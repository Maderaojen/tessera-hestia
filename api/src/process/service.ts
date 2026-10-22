import type { PublicConversation } from '../session-dto.js';
import { activeTurnPhase, type ConversationSegment, type ManagedSession, type Turn } from '../types.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import type { PublicTurn, TurnProcessBrief } from '../contract/index.js';
import { readTranscriptProcess, type ProcessProvider, type TranscriptProcess } from './cache.js';
import { itemsOf } from './classify.js';
import { claudeItemDetail, claudeItemImages, claudeOpenTurn } from './claude.js';
import { codexItemDetail, codexItemImages, codexOpenTurn } from './codex.js';
import type { RawProcessImage } from './images.js';
import type { ProcessItem, ProcessItemDetail, ProcessTurn, TurnPart } from './types.js';

// Only the latest turns carry a brief in a conversation's detail; earlier
// ones are read when asked for.
export const BRIEF_TURNS = 50;

type Unavailable = Exclude<TurnProcessBrief, { status: 'available' }>['status'];

export type ConversationProcess =
  | { status: 'ok'; provider: ProcessProvider; process: Extract<TranscriptProcess, { status: 'ok' }> }
  | { status: Unavailable };

function processProvider(conversation: ConversationSegment): ProcessProvider | null {
  return conversation.provider === 'claude' || conversation.provider === 'codex' ? conversation.provider : null;
}

/**
 * The conversation's transcript read into turns, or why it can't be. Only
 * the transcript the conversation is positively bound to is read. A Claude
 * transcript that is no longer where it was bound may have been moved whole
 * (Claude Code entering a worktree, sync/binding.ts followMovedTranscript):
 * it is looked up again by its session id, read only — the binding itself
 * is the poller's to change.
 */
export async function readConversationProcess(session: ManagedSession, conversation: ConversationSegment): Promise<ConversationProcess> {
  const provider = processProvider(conversation);
  if (!provider) return { status: 'unsupported' };
  const { transcript } = conversation;
  if (transcript.state !== 'resolved' || !transcript.file || !transcript.identity) return { status: 'unavailable' };
  let process = await readTranscriptProcess(transcript.file, provider);
  if (process.status === 'missing' && provider === 'claude' && conversation.providerSessionId) {
    const lookup = await recordedRuntime(session, conversation)?.locateSessionFile({
      cwd: session.cwd,
      providerSessionId: conversation.providerSessionId,
      launchedAfter: conversation.startedAt,
      conversationRoot: conversation.launchProfile?.conversationRoot,
    });
    if (lookup?.status === 'resolved' && lookup.identity === 'pinned_id' && lookup.file !== transcript.file) {
      process = await readTranscriptProcess(lookup.file, provider);
    }
  }
  if (process.status === 'missing') return { status: 'transcript_missing' };
  return { status: 'ok', provider, process };
}

function key(user: { text: string; at: string | null }): string {
  return `${user.at ?? ''}\u0000${user.text}`;
}

/** The transcript's turns by their user message (time and text); a key two turns share maps to null. */
export function processTurnsByUser(turns: readonly ProcessTurn[]): Map<string, ProcessTurn | null> {
  const byUser = new Map<string, ProcessTurn | null>();
  for (const turn of turns) {
    const k = key(turn.user);
    byUser.set(k, byUser.has(k) ? null : turn);
  }
  return byUser;
}

/**
 * The brief for one stored turn, checked turn by turn against the
 * transcript: the same user message (time and text) and the same reply
 * text, else `unavailable` — never parts that read differently from what
 * the chat shows. A turn still being written whose stored text hasn't
 * caught up with the transcript yet gets its parts cut to the stored text.
 */
export function briefFor(stored: Turn, byUser: Map<string, ProcessTurn | null>, open: boolean): TurnProcessBrief {
  if (!stored.user.at) return { status: 'unmatched' };
  const found = byUser.get(key(stored.user));
  if (found === undefined) return { status: 'unmatched' };
  if (found === null) return { status: 'unavailable' };
  const text = stored.assistant.text;
  let parts: TurnPart[] | null = null;
  if (found.assistantText === text) parts = found.parts;
  else if (open && found.assistantText.startsWith(text)) parts = cutTo(found.parts, text);
  if (!parts || parts.map((part) => part.text).join('\n\n') !== text) return { status: 'unavailable' };
  return { status: 'available', open, parts, counts: found.counts };
}

// The parts as far as `text` (a prefix of their joined text) goes.
function cutTo(parts: readonly TurnPart[], text: string): TurnPart[] | null {
  const out: TurnPart[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= text.length) break;
    const start = used === 0 ? 0 : used + 2;
    if (start > text.length) return null;
    const piece = text.slice(start, start + part.text.length);
    if (!part.text.startsWith(piece)) return null;
    out.push({ ...part, text: piece });
    used = start + piece.length;
  }
  return out;
}

function turnIsOpen(session: ManagedSession, conversation: ConversationSegment, turn: Turn): boolean {
  if (session.activeConversationId !== conversation.id || conversation.turns.at(-1)?.index !== turn.index) return false;
  const phase = activeTurnPhase(session);
  return phase === 'replying' || phase === 'awaiting_approval';
}

/** A conversation's detail with the latest turns' briefs added. Never fails the detail. */
export async function withTurnProcess(session: ManagedSession, conversation: ConversationSegment, detail: PublicConversation): Promise<PublicConversation> {
  if (detail.turns.length === 0) return detail;
  let read: ConversationProcess;
  try {
    read = await readConversationProcess(session, conversation);
  } catch {
    return detail;
  }
  const byUser = read.status === 'ok' ? processTurnsByUser(read.process.turns) : null;
  const from = Math.max(0, detail.turns.length - BRIEF_TURNS);
  const turns: PublicTurn[] = detail.turns.map((turn, i) => {
    if (i < from) return turn;
    const stored = conversation.turns[i];
    if (!stored || stored.index !== turn.index) return { ...turn, process: { status: 'unavailable' } };
    const process: TurnProcessBrief = byUser ? briefFor(stored, byUser, turnIsOpen(session, conversation, stored)) : { status: read.status as Unavailable };
    return { ...turn, process };
  });
  return { ...detail, turns };
}

export type TurnSelector = number | 'open';

export type TurnProcessLookup =
  | { status: 'ok'; turn: ProcessTurn; brief: TurnProcessBrief; records: readonly unknown[]; provider: ProcessProvider }
  // The turn has no process to list; `brief` says why.
  | { status: 'none'; brief: TurnProcessBrief }
  | { status: 'turn_not_found' | 'transcript_missing' | 'unsupported' };

/**
 * One turn's process for the level-3 list and level-4 details: a stored
 * turn by its index — only when it checks out against the transcript
 * (briefFor) — or `open`, the newest user message onwards, which may not
 * be a stored turn yet (its parts are not sent: nothing stored to check
 * them against).
 */
export async function lookupTurnProcess(session: ManagedSession, conversation: ConversationSegment, selector: TurnSelector): Promise<TurnProcessLookup> {
  const stored = selector === 'open' ? null : conversation.turns.find((turn) => turn.index === selector);
  if (selector !== 'open' && !stored) return { status: 'turn_not_found' };
  const read = await readConversationProcess(session, conversation);
  if (read.status === 'transcript_missing' || read.status === 'unsupported') return { status: read.status };
  if (read.status !== 'ok') return { status: 'none', brief: { status: read.status } };
  const { records, turns } = read.process;
  if (selector === 'open') {
    const offset = turns.at(-1)?.userSrc ?? 0;
    const turn = read.provider === 'claude' ? claudeOpenTurn(records, offset) : codexOpenTurn(records, offset);
    if (!turn) return { status: 'none', brief: { status: 'unmatched' } };
    return { status: 'ok', turn, records, provider: read.provider, brief: { status: 'available', open: true, parts: [], counts: turn.counts } };
  }
  const byUser = processTurnsByUser(turns);
  const brief = briefFor(stored!, byUser, turnIsOpen(session, conversation, stored!));
  const turn = byUser.get(key(stored!.user));
  if (brief.status !== 'available' || !turn) return { status: 'none', brief };
  return { status: 'ok', turn, brief, records, provider: read.provider };
}

export function itemsFor(turn: ProcessTurn): ProcessItem[] {
  return itemsOf(turn.events, (event) => event.type === 'tool' || (event.type === 'thinking' && event.hasText));
}

export function itemImagesFor(lookup: Extract<TurnProcessLookup, { status: 'ok' }>, itemId: string): RawProcessImage[] | null {
  return lookup.provider === 'claude' ? claudeItemImages(lookup.records, lookup.turn, itemId) : codexItemImages(lookup.records, lookup.turn, itemId);
}

export function itemDetailFor(lookup: Extract<TurnProcessLookup, { status: 'ok' }>, itemId: string): ProcessItemDetail | null {
  return lookup.provider === 'claude'
    ? claudeItemDetail(lookup.records, lookup.turn, itemId)
    : codexItemDetail(lookup.records, lookup.turn, itemId);
}
