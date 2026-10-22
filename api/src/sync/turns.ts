import { TRANSCRIPT_CLOCK_SKEW_MS } from '../config.js';
import { upsertTurn } from '../dialogue-store.js';
import * as registry from '../registry.js';
import { segmentRuntime } from '../runtimes/resolve.js';
import type { ConversationSegment, ManagedSession, Turn } from '../types.js';
import type { Binding } from './binding.js';

// Which parsed turns aren't stored yet. Anchored on the last stored turn's
// user timestamp whenever every timestamp involved is usable, not only on a
// count: a parser change that starts recognizing a turn it used to drop
// (an interrupted reply with no text — see claude.ts) shifts every later
// position by one, and a pure count would then re-import an already-stored
// turn as a duplicate. The count (with the runtime-recovery offset) stays
// the fallback, and the only option before anything is stored.
export function selectNewTurns(parsed: Turn[], conversation: Pick<ConversationSegment, 'turns' | 'transcriptTurnOffset'>): Turn[] {
  const lastStoredAt = Date.parse(conversation.turns.at(-1)?.user.at ?? '');
  const parsedAt = parsed.map((turn) => Date.parse(turn.user.at ?? ''));
  if (!Number.isNaN(lastStoredAt) && parsedAt.every((at) => !Number.isNaN(at))) {
    return parsed.filter((_turn, i) => parsedAt[i]! > lastStoredAt);
  }
  return parsed.slice((conversation.transcriptTurnOffset ?? 0) + conversation.turns.length);
}

export type TurnChanges = { newTurns: Turn[]; grownLast: Turn | null };

// New turns (selectNewTurns) plus the one case where an already-stored turn
// has to change: the last stored turn, matched by its user message, whose
// reply has since grown. That happens when the CLI keeps replying without a
// new real user message in between — woken by something the parser skips
// (an isMeta injection such as a subagent's hand-back or a background-task
// notification), so the extra reply text lands on the previous turn — or
// when a turn was imported before its reply was fully written. Only growth
// that keeps every stored part counts (keepsEveryPart): usually the stored
// text as a prefix, but also parts the parser has since learned to read
// in between (2.1.304+ narration, see providers/claude.ts); anything else
// is left alone rather than rewriting history. A follow-up added to that
// turn (Turn.followUps) counts as growth too. The stored index is kept so
// the archive and the frontend's keys still line up.
export function diffTurns(parsed: Turn[], conversation: Pick<ConversationSegment, 'turns' | 'transcriptTurnOffset'>): TurnChanges {
  const newTurns = selectNewTurns(parsed, conversation);
  const last = conversation.turns.at(-1);
  const match = last?.user.at
    ? parsed.find((turn) => turn.user.at === last.user.at && turn.user.text === last.user.text)
    : undefined;
  const keepsReply = !!last && !!match && keepsEveryPart(last.assistant.text, match.assistant.text);
  const replyGrew = keepsReply && match.assistant.text.length > last.assistant.text.length;
  // The stop's marker can land after the partial reply was stored: the
  // text stays, the turn becomes interrupted.
  const becameInterrupted = keepsReply && !!match.assistant.interrupted && !last.assistant.interrupted;
  // A message sent mid-reply joins the turn as a follow-up, possibly after
  // the turn was first stored.
  const followUpsGrew = keepsReply && (match.followUps?.length ?? 0) > (last.followUps?.length ?? 0);
  return {
    newTurns,
    grownLast: replyGrew || followUpsGrew || becameInterrupted
      ? {
        ...last,
        ...(match.followUps ? { followUps: match.followUps } : {}),
        assistant: {
          text: match.assistant.text,
          at: last.assistant.at ?? match.assistant.at,
          ...(match.assistant.interrupted || last.assistant.interrupted ? { interrupted: true as const } : {}),
        },
      }
      : null,
  };
}

// Whether `parsed` holds every part of `stored` in order, only adding
// text. Parts are the paragraphs a reply is joined from; the last stored
// one may be cut short (stored while still being written).
export function keepsEveryPart(stored: string, parsed: string): boolean {
  if (parsed.startsWith(stored)) return true;
  let from = 0;
  for (const part of stored.split('\n\n')) {
    const at = parsed.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

// Stored turns that a newer parse of the same transcript reads longer —
// text the parser used to skip (2.1.304+ narration), kept only where every
// stored part is still there. Matched by the user message, so a shifted
// position never pairs two different turns; each keeps its stored index.
export function revisedTurns(parsed: Turn[], stored: Turn[]): Turn[] {
  return stored.flatMap((turn): Turn[] => {
    if (!turn.user.at) return [];
    const match = parsed.find((candidate) => candidate.user.at === turn.user.at && candidate.user.text === turn.user.text);
    if (!match || match.assistant.text.length <= turn.assistant.text.length) return [];
    if (!keepsEveryPart(turn.assistant.text, match.assistant.text)) return [];
    return [{ ...turn, assistant: { ...turn.assistant, text: match.assistant.text } }];
  });
}

// Whether the turn the latest send started (or joined, as a follow-up) is
// in the transcript, counting these changes: a new turn, or the last turn
// holding a message from at or after that send. A turn still being written
// is stored as it goes, so "something new arrived" can't tell an earlier
// turn growing from the awaited one.
export function awaitedTurnLanded(conversation: Pick<ConversationSegment, 'turns' | 'lastUserMessageAt'>, changes: TurnChanges): boolean {
  if (changes.newTurns.length > 0) return true;
  const sentAt = Date.parse(conversation.lastUserMessageAt ?? '');
  const last = changes.grownLast ?? conversation.turns.at(-1);
  if (!last) return false;
  const times = [last.user.at, ...(last.followUps ?? []).map((followUp) => followUp.at)]
    .map((at) => Date.parse(at ?? '')).filter((at) => !Number.isNaN(at));
  // Without a send time, or a transcript without usable times, there's no
  // telling it's an earlier turn; don't hold a finished reply open on that.
  if (Number.isNaN(sentAt) || times.length === 0) return true;
  return times.some((at) => at >= sentAt - TRANSCRIPT_CLOCK_SKEW_MS);
}

// Whether the message the turn is waiting on was never anyone's: the CLI's
// own compaction summary (TranscriptAdapter.parseCompactionSummaryTimes),
// which a Hestia that read it as a message recorded as sent from the
// terminal, at its exact transcript time. No reply comes to it, so without
// this the turn would stay open (and later look stuck) for good; checked on
// every settle, so such a turn ends with no migration.
export function awaitedWasCompactionSummary(conversation: Pick<ConversationSegment, 'lastUserMessageAt'>, summaryTimes: readonly string[]): boolean {
  return !!conversation.lastUserMessageAt && summaryTimes.includes(conversation.lastUserMessageAt);
}

export function hasTurnChanges(changes: TurnChanges): boolean {
  return changes.newTurns.length > 0 || changes.grownLast !== null;
}

// The one place turns get stored: the dialogue archive first, then the
// registry (which publishes the SSE update the chat view reloads on).
export async function commitTurns(
  session: ManagedSession,
  conversation: ConversationSegment,
  changes: TurnChanges,
  sessionPatch: Partial<Omit<ManagedSession, 'conversations'>> = {},
): Promise<ManagedSession | undefined> {
  const { newTurns, grownLast } = changes;
  if (grownLast) await upsertTurn(session, conversation, grownLast);
  for (const turn of newTurns) {
    await upsertTurn(session, conversation, turn);
  }
  const stored = grownLast ? [...conversation.turns.slice(0, -1), grownLast] : conversation.turns;
  return registry.updateConversation(session.id, conversation.id, {
    turns: [...stored, ...newTurns],
    transcriptError: null,
  }, sessionPatch);
}

// Parses the bound transcript and works out what changed against what's
// stored. Every import path (waiting, ready, after a stop) goes through
// this; they differ only in *when* they call it and what status they set
// afterwards.
export async function readTurnChanges(binding: Binding): Promise<TurnChanges> {
  return diffTurns(await binding.adapter.parseTurns(binding.file), binding.conversation);
}

// Once at startup, before polling: every stored conversation re-read with
// the current parser (revisedTurns), archive first, then the registry. A
// transcript that is gone or unreadable is skipped. Returns how many turns
// changed.
export async function backfillRevisedTurns(): Promise<number> {
  let revised = 0;
  for (const session of await registry.listAllSessions()) {
    for (const conversation of session.conversations ?? []) {
      const file = conversation.transcript.state === 'resolved' ? conversation.transcript.file : null;
      const adapter = file && conversation.turns.length > 0 ? segmentRuntime(conversation) : undefined;
      if (!file || !adapter) continue;
      const parsed = await adapter.parseTurns(file).catch(() => null);
      const changed = parsed ? revisedTurns(parsed, conversation.turns) : [];
      if (changed.length === 0) continue;
      for (const turn of changed) await upsertTurn(session, conversation, turn);
      const byIndex = new Map(changed.map((turn) => [turn.index, turn]));
      await registry.updateConversation(session.id, conversation.id, {
        turns: conversation.turns.map((turn) => byIndex.get(turn.index) ?? turn),
      });
      revised += changed.length;
    }
  }
  return revised;
}
