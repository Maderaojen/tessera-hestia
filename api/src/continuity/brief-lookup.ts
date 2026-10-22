import type { ContinuityEvent, ContinuityHandoff } from '../contract/continuity.js';
import type { SegmentHandoffRecord } from '../types.js';

// Which of a session's handoffs a brief request means. A session knows its handoffs from
// the one under way, the ones written on its conversations and the ones in
// its history. Asked by the full id or its first 8 characters (all an older
// handoff, backfilled from its briefing message, knows); a short id that
// fits two of this session's handoffs is refused, not guessed.

export const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHORT_ID = /^[0-9a-f]{8}$/;

export type KnownHandoff = { handoffId: string; briefFile: string | null };

export function knownHandoffs(input: {
  current: ContinuityHandoff | null;
  segments: (SegmentHandoffRecord | null | undefined)[];
  history: ContinuityEvent[];
}): KnownHandoff[] {
  const known: KnownHandoff[] = [];
  if (input.current) known.push({ handoffId: input.current.id, briefFile: input.current.briefFile });
  for (const segment of input.segments) if (segment) known.push({ handoffId: segment.handoffId, briefFile: segment.briefFile });
  for (const event of input.history) if (event.handoffId) known.push({ handoffId: event.handoffId, briefFile: null });
  return known;
}

export type BriefLookup =
  | { kind: 'found'; handoffId: string; shortId: string; briefFile: string | null }
  | { kind: 'invalid' }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' };

export function lookUpHandoff(known: KnownHandoff[], asked: string): BriefLookup {
  const id = asked.toLowerCase();
  const full = FULL_ID.test(id);
  if (!full && !SHORT_ID.test(id)) return { kind: 'invalid' };
  const short = id.slice(0, 8);
  // A full id fits itself, or a backfilled handoff known only by its first
  // 8; a short id fits any handoff starting with it.
  const fits = known.filter((entry) => (full ? entry.handoffId === id || entry.handoffId === short : entry.handoffId.slice(0, 8) === short));
  if (!fits.length) return { kind: 'unknown' };
  // One handoff, known by its full id here and its short one there, is one.
  const fullIds = new Set(fits.map((entry) => entry.handoffId).filter((handoffId) => FULL_ID.test(handoffId)));
  // Two files for what looks like one handoff (an old one sharing the
  // prefix) can't be told apart either.
  const files = new Set(fits.map((entry) => entry.briefFile).filter((file): file is string => !!file));
  if (fullIds.size > 1 || files.size > 1) return { kind: 'ambiguous' };
  const briefFile = [...files][0] ?? null;
  return { kind: 'found', handoffId: id, shortId: short, briefFile };
}
