import { describe, expect, it } from 'vitest';
import { knownHandoffs, lookUpHandoff } from '../../src/continuity/brief-lookup.js';
import type { ContinuityHandoff } from '../../src/contract/continuity.js';
import type { SegmentHandoffRecord } from '../../src/types.js';

const A = '1a2b3c4d-0000-4000-8000-000000000001';
const B = '9f8e7d6c-0000-4000-8000-000000000002';
const A_TWIN = '1a2b3c4d-0000-4000-8000-0000000000ff';
const segment = (handoffId: string, briefFile: string | null, derived = false): SegmentHandoffRecord => ({
  handoffId, trigger: null, fromConversationId: null, briefSource: null, source: null, briefNote: null, confirm: null, briefAmended: null, briefFile,
  ...(derived ? { derived } : {}),
});

describe('knownHandoffs', () => {
  it('from the one under way, the conversations and the history', () => {
    const known = knownHandoffs({
      current: { id: B, briefFile: '.hestia/handoffs/b-9f8e7d6c.md' } as ContinuityHandoff,
      segments: [segment(A, '.hestia/handoffs/a-1a2b3c4d.md'), null, undefined],
      history: [{ at: '', kind: 'handoff_failed', detail: null, handoffId: A_TWIN }, { at: '', kind: 'resumed', detail: null }],
    });
    expect(known).toEqual([
      { handoffId: B, briefFile: '.hestia/handoffs/b-9f8e7d6c.md' },
      { handoffId: A, briefFile: '.hestia/handoffs/a-1a2b3c4d.md' },
      { handoffId: A_TWIN, briefFile: null },
    ]);
  });
});

describe('lookUpHandoff', () => {
  const known = [{ handoffId: A, briefFile: '.hestia/handoffs/a-1a2b3c4d.md' }, { handoffId: B, briefFile: null }];

  it('by its full id, with its stored file', () => {
    expect(lookUpHandoff(known, A)).toEqual({ kind: 'found', handoffId: A, shortId: '1a2b3c4d', briefFile: '.hestia/handoffs/a-1a2b3c4d.md' });
  });

  it('by its short id', () => {
    expect(lookUpHandoff(known, '9f8e7d6c')).toEqual({ kind: 'found', handoffId: '9f8e7d6c', shortId: '9f8e7d6c', briefFile: null });
  });

  it('a backfilled one, known by its short id only, by its full id too', () => {
    expect(lookUpHandoff([{ handoffId: '1a2b3c4d', briefFile: '.hestia/handoffs/a-1a2b3c4d.md' }], A)).toMatchObject({ kind: 'found', briefFile: '.hestia/handoffs/a-1a2b3c4d.md' });
  });

  it('one handoff known by both its ids is one', () => {
    expect(lookUpHandoff([...known, { handoffId: '1a2b3c4d', briefFile: '.hestia/handoffs/a-1a2b3c4d.md' }], '1a2b3c4d')).toMatchObject({ kind: 'found' });
  });

  it('a short id that fits two of the session\'s handoffs is refused', () => {
    expect(lookUpHandoff([...known, { handoffId: A_TWIN, briefFile: null }], '1a2b3c4d')).toEqual({ kind: 'ambiguous' });
    expect(lookUpHandoff([...known, { handoffId: '1a2b3c4d', briefFile: '.hestia/handoffs/other-1a2b3c4d.md' }], '1a2b3c4d')).toEqual({ kind: 'ambiguous' });
  });

  it('not this session\'s: unknown', () => {
    expect(lookUpHandoff(known, '00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'unknown' });
    expect(lookUpHandoff([], '1a2b3c4d')).toEqual({ kind: 'unknown' });
  });

  it.each(['', '1a2b3c4', '1a2b3c4d.md', '../1a2b3c4d', 'xyzxyzxy', `${A}x`])('not an id: %j', (asked) => {
    expect(lookUpHandoff(known, asked)).toEqual({ kind: 'invalid' });
  });
});
