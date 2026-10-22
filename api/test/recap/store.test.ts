import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Turn } from '../../src/contract/sessions.js';
import type { RecapOutput } from '../../src/recap/schema.js';

let root: string;
let store: typeof import('../../src/recap/store.js');
let dialogue: typeof import('../../src/dialogue-store.js');

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(path.join(os.tmpdir(), 'recap-store-'));
  // dialogue-store.ts reads DIALOGUE_ROOT when imported (see dialogue-store.test.ts).
  vi.stubEnv('HESTIA_DIALOGUE_ROOT', root);
  store = await import('../../src/recap/store.js');
  dialogue = await import('../../src/dialogue-store.js');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const owner = { sessionId: 's1', tmuxName: 'hestia-s1', projectId: 'p1', conversationId: 'c/1', provider: 'claude' as const };
const generator = { profileId: 'native:claude', profileLabel: 'Claude (原生)', runtimeId: 'claude-code' as const, model: 'haiku', effort: null };
const NOW = '2026-10-05T02:00:00.000Z';

function turn(index: number, text = `第 ${index} 輪`): Turn {
  return { index, user: { text, at: `2026-10-05T01:${String(index).padStart(2, '0')}:00.000Z` }, assistant: { text: '好', at: null } };
}

const turns = Array.from({ length: 5 }, (_v, i) => turn(i));

function answer(...titles: string[]): RecapOutput {
  return { items: titles.map((title) => ({ id: null, title, status: 'uncertain', turns: { from: 0, to: 1 }, mergedFrom: [] })) };
}

function batch(startAt: number, count: number, output: RecapOutput, extra: Partial<Parameters<typeof store.applyBatch>[1]> = {}) {
  return store.applyBatch(owner, {
    output, batch: turns.slice(startAt, startAt + count), startAt, turns, generator, now: NOW, clearRequest: false, ...extra,
  });
}

describe('the recap file', () => {
  it('sits beside the conversation\'s archive, under the same name', () => {
    const archive = dialogue.dialogueFile({ tmuxName: owner.tmuxName }, { id: owner.conversationId, provider: owner.provider });
    expect(store.recapFilePath(owner)).toBe(archive.replace(/\.jsonl$/, '.recap.json'));
    expect(store.recapFilePath(owner)).toBe(path.join(root, dialogue.ARCHIVE_HOST, 'claude', 'hestia-s1', 'c%2F1.recap.json'));
  });

  it('is refused for a conversation without a provider', async () => {
    const none = { ...owner, provider: null };
    expect(() => store.recapFilePath(none)).toThrow();
    await expect(store.applyBatch(none, { output: answer('x'), batch: turns.slice(0, 1), startAt: 0, turns, generator, now: NOW, clearRequest: false })).rejects.toThrow();
  });

  it('is written and read back, describing itself', async () => {
    expect(await store.readRecapFile(owner)).toBeNull();
    const result = await batch(0, 2, answer('深色主題'));
    expect(result.ok).toBe(true);
    const read = await store.readRecapFile(owner);
    expect(read).toMatchObject({
      version: 1,
      identity: { host: dialogue.ARCHIVE_HOST, sessionId: 's1', conversationId: 'c/1', tmuxName: 'hestia-s1', provider: 'claude', projectId: 'p1' },
      language: 'zh-TW',
      items: [{ title: '深色主題', statusSource: 'auto', turns: { from: 0, to: 1 } }],
      coveredTurns: 2,
      lastCovered: { index: 1, userAt: turns[1]!.user.at, userTextHash: store.userTextHash('第 1 輪') },
      updatedAt: NOW, generator, lastError: null, failures: 0, requestedAt: null,
    });
    expect(JSON.parse(await readFile(store.recapFilePath(owner), 'utf-8'))).toEqual(read);
  });

  it.each([
    ['not JSON', '{"version": 1, '],
    ['another shape', JSON.stringify({ version: 2, items: 'none' })],
  ])('reads as none when it is %s, and says so in the log', async (_name, content) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await batch(0, 1, answer('x'));
    await writeFile(store.recapFilePath(owner), content);
    expect(await store.readRecapFile(owner)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('treated as none'));
  });

  it('keeps an earlier failure and request through a batch, and clears them when told', async () => {
    await store.updateRecapFile(owner, (recap) => ({ ...recap, requestedAt: NOW, failures: 2, lastError: { code: 'run_failed', at: NOW, retryAt: NOW } }));
    await batch(0, 2, answer('a'));
    expect(await store.readRecapFile(owner)).toMatchObject({ requestedAt: NOW, failures: 0, lastError: null });
    await batch(2, 3, answer('a', 'b'), { clearRequest: true });
    expect(await store.readRecapFile(owner)).toMatchObject({ requestedAt: null, coveredTurns: 5 });
  });
});

describe('applyBatch', () => {
  it('refuses an answer that breaks the merge rules, writing nothing', async () => {
    await batch(0, 2, answer('a'));
    const before = await readFile(store.recapFilePath(owner), 'utf-8');
    const result = await batch(2, 1, { items: [{ id: null, title: '', status: 'uncertain', turns: { from: 2, to: 2 }, mergedFrom: [] }] });
    expect(result).toMatchObject({ ok: false, code: 'invalid_output' });
    expect(await readFile(store.recapFilePath(owner), 'utf-8')).toBe(before);
  });

  it('refuses a batch planned from a point the recap is no longer at', async () => {
    await batch(0, 2, answer('a'));
    expect(await batch(0, 2, answer('a'))).toMatchObject({ ok: false, code: 'stale' });
    expect(await batch(3, 1, answer('a'))).toMatchObject({ ok: false, code: 'stale' });
  });

  it('refuses a batch whose turns moved while it ran', async () => {
    const moved = [turn(0, '改過的第 0 輪'), ...turns.slice(1)];
    expect(await batch(0, 2, answer('a'), { turns: moved })).toMatchObject({ ok: false, code: 'stale' });
  });

  it('and a user\'s status change, at the same time, both land', async () => {
    await batch(0, 2, answer('a'));
    const [first] = (await store.readRecapFile(owner))!.items;
    // Both queue on the file: neither writes over the other.
    const writes = [
      batch(2, 2, { items: [{ id: first!.id, title: 'a', status: 'implemented', turns: { from: 0, to: 3 }, mergedFrom: [] }] }),
      store.setItemStatus(owner, first!.id, 'accepted', '2026-10-05T02:00:01.000Z'),
    ];
    await Promise.all(writes);
    const read = (await store.readRecapFile(owner))!;
    expect(read.coveredTurns).toBe(4);
    expect(read.items).toEqual([expect.objectContaining({ id: first!.id, status: 'accepted', statusSource: 'user', turns: { from: 0, to: 3 } })]);
  });

  it('a status change queued after a batch is not lost to it either', async () => {
    await batch(0, 2, answer('a'));
    const [first] = (await store.readRecapFile(owner))!.items;
    await Promise.all([
      store.setItemStatus(owner, first!.id, 'planned', NOW),
      batch(2, 1, { items: [{ id: first!.id, title: 'a', status: 'implemented', turns: { from: 0, to: 2 }, mergedFrom: [] }] }),
      store.setItemStatus(owner, first!.id, 'not_implemented', '2026-10-05T02:00:02.000Z'),
    ]);
    expect((await store.readRecapFile(owner))!.items[0]).toMatchObject({ status: 'not_implemented', statusSource: 'user', statusChangedAt: '2026-10-05T02:00:02.000Z' });
  });
});

describe('setItemStatus', () => {
  it('marks the item as the user\'s', async () => {
    await batch(0, 1, answer('a'));
    const [first] = (await store.readRecapFile(owner))!.items;
    const written = await store.setItemStatus(owner, first!.id, 'accepted', NOW);
    expect(written!.items[0]).toEqual({ ...first, status: 'accepted', statusSource: 'user', statusChangedAt: NOW, updatedAt: NOW });
  });

  it('is null for an item that isn\'t there, or a conversation without a recap', async () => {
    expect(await store.setItemStatus(owner, 'r_nope', 'accepted', NOW)).toBeNull();
    expect(await store.readRecapFile(owner)).toBeNull();
    await batch(0, 1, answer('a'));
    expect(await store.setItemStatus(owner, 'r_nope', 'accepted', NOW)).toBeNull();
  });
});

describe('recapProgress', () => {
  const covered = (count: number, last = turns[count - 1]!) => ({
    ...store.emptyRecapFile(owner), coveredTurns: count,
    lastCovered: { index: last.index, userAt: last.user.at, userTextHash: store.userTextHash(last.user.text) },
  });

  it.each([
    ['no recap', () => null, turns, { coveredTurns: 0, rebuild: false }],
    ['nothing covered yet', () => store.emptyRecapFile(owner), turns, { coveredTurns: 0, rebuild: false }],
    ['the covered turns where they were', () => covered(3), turns, { coveredTurns: 3, rebuild: false }],
    ['more covered than there are turns', () => covered(3), turns.slice(0, 2), { coveredTurns: 0, rebuild: true }],
    ['the last covered turn now another index', () => covered(3), turns.map((t, i) => ({ ...t, index: i + 1 })), { coveredTurns: 0, rebuild: true }],
    ['its text changed', () => covered(3), turns.map((t) => ({ ...t, user: { ...t.user, text: `${t.user.text}!` } })), { coveredTurns: 0, rebuild: true }],
    ['its time changed', () => covered(3), turns.map((t) => ({ ...t, user: { ...t.user, at: null } })), { coveredTurns: 0, rebuild: true }],
    ['covered turns but no record of the last', () => ({ ...covered(3), lastCovered: null }), turns, { coveredTurns: 0, rebuild: true }],
  ])('%s', (_name, recap, now, expected) => {
    expect(store.recapProgress(recap(), now)).toEqual(expected);
  });
});
