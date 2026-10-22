import { describe, expect, it } from 'vitest';
import type { ConversationRecapItem, RecapStatus } from '../../src/contract/recap.js';
import { RECAP_MAX_ITEMS } from '../../src/recap/constants.js';
import { mergeRecap, newRecapItemId, normalizeRecapTitle, type RecapMergeInput } from '../../src/recap/merge.js';
import type { RecapOutput, RecapOutputItem } from '../../src/recap/schema.js';

const BEFORE = '2026-10-05T01:00:00.000Z';
const NOW = '2026-10-05T02:00:00.000Z';

function item(id: string, patch: Partial<ConversationRecapItem> = {}): ConversationRecapItem {
  return {
    id, title: `項目 ${id}`, status: 'uncertain', statusSource: 'auto', turns: { from: 0, to: 0 },
    createdAt: BEFORE, updatedAt: BEFORE, statusChangedAt: null, ...patch,
  };
}

function userItem(id: string, status: RecapStatus, patch: Partial<ConversationRecapItem> = {}): ConversationRecapItem {
  return item(id, { status, statusSource: 'user', statusChangedAt: BEFORE, ...patch });
}

// The model's answer for an item, echoing it unchanged unless patched.
function echo(source: ConversationRecapItem, patch: Partial<RecapOutputItem> = {}): RecapOutputItem {
  return { id: source.id, title: source.title, status: source.status, turns: { ...source.turns }, mergedFrom: [], ...patch };
}

function fresh(title: string, turns: { from: number; to: number }, patch: Partial<RecapOutputItem> = {}): RecapOutputItem {
  return { id: null, title, status: 'uncertain', turns, mergedFrom: [], ...patch };
}

function merge(current: ConversationRecapItem[], items: RecapOutputItem[], batch = { from: 20, to: 39 }, extra: Partial<RecapMergeInput> = {}) {
  let next = 0;
  const output: RecapOutput = { items };
  return mergeRecap({ current, output, batch, now: NOW, newId: () => `r_new${next++}`, ...extra });
}

function ok(result: ReturnType<typeof mergeRecap>): ConversationRecapItem[] {
  if (!result.ok) throw new Error(`expected a merge, got: ${result.reason}`);
  return result.items;
}

describe('mergeRecap: ids', () => {
  it('keeps the ids the answer kept, and leaves an unchanged item as it was', () => {
    const a = item('r_a', { turns: { from: 0, to: 3 } });
    const items = ok(merge([a], [echo(a)]));
    expect(items).toEqual([a]);
  });

  it('gives a new item (id null) an id of its own', () => {
    const items = ok(merge([], [fresh('加上深色主題', { from: 20, to: 21 })]));
    expect(items).toEqual([{
      id: 'r_new0', title: '加上深色主題', status: 'uncertain', statusSource: 'auto', turns: { from: 20, to: 21 },
      createdAt: NOW, updatedAt: NOW, statusChangedAt: null,
    }]);
  });

  it('takes an id the model made up for a new item, and gives it a real one', () => {
    const a = item('r_a');
    const items = ok(merge([a], [echo(a), fresh('新的', { from: 22, to: 22 }, { id: 'r_madeup' })]));
    expect(items.map((entry) => entry.id)).toEqual(['r_a', 'r_new0']);
  });

  it('a made-up id never collides with one in use', () => {
    const taken = new Set(['r_00000000']);
    expect(taken.has(newRecapItemId(taken))).toBe(false);
    expect(newRecapItemId(new Set())).toMatch(/^r_[0-9a-f]{8}$/);
  });
});

describe('mergeRecap: a status the user set', () => {
  it.each([
    ['the model changed it', 'not_implemented'],
    ['the model echoed it', 'accepted'],
  ] as const)('stays the user\'s when %s', (_name, modelStatus) => {
    const mine = userItem('r_u', 'accepted');
    const [kept] = ok(merge([mine], [echo(mine, { status: modelStatus })]));
    expect(kept).toMatchObject({ id: 'r_u', status: 'accepted', statusSource: 'user', statusChangedAt: BEFORE });
  });

  it('comes back in its place when the answer left it out', () => {
    const a = item('r_a');
    const mine = userItem('r_u', 'implemented');
    const c = item('r_c');
    const items = ok(merge([a, mine, c], [echo(a), echo(c)]));
    expect(items.map((entry) => entry.id)).toEqual(['r_a', 'r_u', 'r_c']);
    expect(items[1]).toEqual(mine);
  });

  it('can\'t be merged into another item: it is taken out of mergedFrom and kept as it was', () => {
    const a = item('r_a', { turns: { from: 0, to: 1 } });
    const mine = userItem('r_u', 'planned', { turns: { from: 2, to: 2 } });
    const items = ok(merge([a, mine], [echo(a, { turns: { from: 0, to: 25 }, mergedFrom: ['r_u'] })]));
    expect(items.map((entry) => entry.id)).toEqual(['r_a', 'r_u']);
    expect(items[1]).toEqual(mine);
  });

  it('can be the item others are merged into, and keeps its status', () => {
    const mine = userItem('r_u', 'accepted', { turns: { from: 3, to: 4 } });
    const other = item('r_o', { status: 'implemented', turns: { from: 8, to: 9 } });
    const items = ok(merge([mine, other], [echo(mine, { status: 'planned', turns: { from: 3, to: 22 }, mergedFrom: ['r_o'] })]));
    expect(items).toEqual([{ ...mine, turns: { from: 3, to: 22 }, updatedAt: NOW }]);
  });

  it('is the one on file at write time, not the one the batch was sent with', () => {
    // Sent: r_a auto/uncertain. The user marks it accepted while the batch
    // runs; the answer, written from the old list, says implemented.
    const sent = item('r_a');
    const onFile = userItem('r_a', 'accepted', { statusChangedAt: '2026-10-05T01:30:00.000Z' });
    const [kept] = ok(merge([onFile], [echo(sent, { status: 'implemented' })]));
    expect(kept).toMatchObject({ status: 'accepted', statusSource: 'user', statusChangedAt: '2026-10-05T01:30:00.000Z' });
  });

  it('still takes the model\'s new title', () => {
    const mine = userItem('r_u', 'accepted');
    const [kept] = ok(merge([mine], [echo(mine, { title: '換一個說法' })]));
    expect(kept).toMatchObject({ title: '換一個說法', status: 'accepted', updatedAt: NOW });
  });
});

describe('mergeRecap: automatic items', () => {
  it('come back when the answer left them out, after the item they followed', () => {
    const [a, b, c, d] = ['r_a', 'r_b', 'r_c', 'r_d'].map((id) => item(id));
    const items = ok(merge([a!, b!, c!, d!], [echo(a!), fresh('新', { from: 20, to: 20 }), echo(d!)]));
    expect(items.map((entry) => entry.id)).toEqual(['r_a', 'r_b', 'r_c', 'r_new0', 'r_d']);
  });

  it('a dropped first item goes back to the top; one whose predecessor is gone goes last', () => {
    const [a, b, c] = ['r_a', 'r_b', 'r_c'].map((id) => item(id));
    // r_a dropped (first), r_b merged into a new item, r_c dropped after it.
    const items = ok(merge([a!, b!, c!], [fresh('合併', { from: 20, to: 20 }, { mergedFrom: ['r_b'] })]));
    expect(items.map((entry) => entry.id)).toEqual(['r_a', 'r_new0', 'r_c']);
  });

  it('merged legally: gone, and the survivor spans every merged range', () => {
    const a = item('r_a', { turns: { from: 2, to: 4 } });
    const b = item('r_b', { turns: { from: 10, to: 12 } });
    // The model's own range for the survivor, widened by what was merged in.
    const items = ok(merge([a, b], [echo(a, { turns: { from: 11, to: 21 }, mergedFrom: ['r_b'] })]));
    expect(items).toEqual([{ ...a, turns: { from: 10, to: 21 }, updatedAt: NOW }]);
  });

  it('take the model\'s status, as automatic', () => {
    const a = item('r_a');
    const [kept] = ok(merge([a], [echo(a, { status: 'implemented' })]));
    expect(kept).toMatchObject({ status: 'implemented', statusSource: 'auto', updatedAt: NOW, createdAt: BEFORE });
  });
});

describe('mergeRecap: turns and titles', () => {
  it.each([
    ['swapped', { from: 30, to: 25 }, { from: 25, to: 30 }],
    ['past the batch\'s end', { from: 25, to: 99 }, { from: 25, to: 39 }],
    ['below 0', { from: -3, to: 2 }, { from: 0, to: 2 }],
  ])('an existing item\'s range %s is fixed', (_name, given, expected) => {
    const a = item('r_a');
    expect(ok(merge([a], [echo(a, { turns: given })]))[0]!.turns).toEqual(expected);
  });

  it.each([
    ['before the batch', { from: 3, to: 5 }, { from: 20, to: 20 }],
    ['partly before it', { from: 15, to: 22 }, { from: 20, to: 22 }],
    ['after it, swapped', { from: 50, to: 30 }, { from: 30, to: 39 }],
  ])('a new item\'s range %s is put inside the batch', (_name, given, expected) => {
    expect(ok(merge([], [fresh('新', given)]))[0]!.turns).toEqual(expected);
  });

  it('a new item that merged older ones spans them too', () => {
    const a = item('r_a', { turns: { from: 1, to: 2 } });
    expect(ok(merge([a], [fresh('新', { from: 21, to: 22 }, { mergedFrom: ['r_a'] })]))).toEqual([
      expect.objectContaining({ id: 'r_new0', turns: { from: 1, to: 22 } }),
    ]);
  });

  it.each([
    ['trims it', '  加深色主題 ', '加深色主題'],
    ['puts it on one line', '加深色主題\n並且\r\n調亮按鈕', '加深色主題 並且 調亮按鈕'],
    ['cuts it at 40 characters with an ellipsis', '一'.repeat(45), `${'一'.repeat(39)}…`],
    ['leaves exactly 40 alone', '二'.repeat(40), '二'.repeat(40)],
    ['counts an emoji as one character', `${'三'.repeat(39)}😀😀`, `${'三'.repeat(39)}…`],
  ])('the title: %s', (_name, given, expected) => {
    expect(normalizeRecapTitle(given)).toBe(expected);
    expect(ok(merge([], [fresh(given, { from: 20, to: 20 })]))[0]!.title).toBe(expected);
  });
});

describe('mergeRecap: an answer refused whole', () => {
  const a = item('r_a');
  const b = item('r_b');
  it.each([
    ['a duplicate id', [echo(a), echo(a)]],
    ['a duplicate made-up id', [fresh('x', { from: 20, to: 20 }, { id: 'r_x' }), fresh('y', { from: 20, to: 20 }, { id: 'r_x' })]],
    ['mergedFrom naming an id not in the recap', [echo(a, { mergedFrom: ['r_nope'] })]],
    ['an id both kept and merged', [echo(a), echo(b, { mergedFrom: ['r_a'] })]],
    ['an item merging itself', [echo(a, { mergedFrom: ['r_a'] })]],
    ['an id merged into two items', [echo(a, { mergedFrom: ['r_c'] }), fresh('x', { from: 20, to: 20 }, { mergedFrom: ['r_c'] })]],
    ['an empty title', [echo(a), fresh(' \n ', { from: 20, to: 20 })]],
    ['too many items', Array.from({ length: RECAP_MAX_ITEMS + 1 }, (_v, i) => fresh(`第 ${i} 項`, { from: 20, to: 20 }))],
  ])('%s', (_name, items) => {
    const result = merge([a, b, item('r_c')], items);
    expect(result.ok).toBe(false);
  });

  it('says why without naming an id the model made up', () => {
    const result = merge([a], [fresh('x', { from: 20, to: 20 }, { mergedFrom: ['機密對話內容'] })]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).not.toContain('機密對話內容');
  });

  it('too many items once the dropped ones are back', () => {
    const current = Array.from({ length: RECAP_MAX_ITEMS }, (_v, i) => item(`r_${i}`));
    expect(merge(current, [fresh('再一項', { from: 20, to: 20 })]).ok).toBe(false);
  });
});
