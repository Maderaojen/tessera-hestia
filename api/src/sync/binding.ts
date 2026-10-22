import { stat } from 'node:fs/promises';
import { TRANSCRIPT_NOT_FOUND_GRACE_MS } from '../config.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import type { TranscriptAdapter } from '../providers/types.js';
import * as registry from '../registry.js';
import type { ConversationSegment, ManagedSession, Turn } from '../types.js';
import { resetTurnWatch, trackerFor } from './tracker.js';
import { t } from '../i18n/index.js';

// A session's active conversation together with the transcript it is
// positively bound to — the only file provider parsers may ever read.
export type Binding = {
  session: ManagedSession;
  conversation: ConversationSegment;
  adapter: TranscriptAdapter;
  file: string;
};

export function activeConversation(session: ManagedSession): ConversationSegment | undefined {
  if (!session.provider || !session.activeConversationId) return undefined;
  const conversation = session.conversations?.find((candidate) => candidate.id === session.activeConversationId);
  return conversation && conversation.provider === session.provider ? conversation : undefined;
}

// The binding for a session whose transcript is already resolved. Locating a
// transcript in the first place is the poller's job (ensureBinding is the
// only path allowed to probe the provider's directories); everything else
// just refuses.
export function resolvedBinding(session: ManagedSession): Binding | null {
  const conversation = activeConversation(session);
  if (!conversation || conversation.transcript.state !== 'resolved' || conversation.transcript.identity === null || !conversation.transcript.file) return null;
  const adapter = recordedRuntime(session, conversation);
  if (!adapter) return null;
  return { session, conversation, adapter, file: conversation.transcript.file };
}

// The CLI said this conversation now continues in another transcript (see
// claudeAdapter.followContinuation). Rebinds the same segment to the newest
// file and session id — the conversation, its stored turns and its archive
// all stay; the new file repeats the old history with its original
// timestamps, so selectNewTurns only picks up what came after. The session
// id moves too, so a later resume reopens the live transcript rather than
// the abandoned one (resume requires the session's and the active
// segment's ids to match). Returns true when it switched; the caller stops
// there and the next tick starts clean against the new file.
export async function followTranscriptContinuation(binding: Binding): Promise<boolean> {
  const { session, conversation, adapter, file } = binding;
  if (!adapter.followContinuation) return false;
  const next = await adapter.followContinuation(file);
  if (!next || next.file === file) return false;
  resetTurnWatch(session.id);
  trackerFor(session.id).ready = undefined;
  await registry.updateConversation(session.id, conversation.id, {
    providerSessionId: next.providerSessionId,
    transcript: { ...conversation.transcript, file: next.file },
  }, session.activeConversationId === conversation.id ? { providerSessionId: next.providerSessionId } : {});
  return true;
}

// The CLI moved the bound transcript elsewhere, whole: Claude Code entering
// a worktree (observed 2.1.283) moves <id>.jsonl, full history included,
// into the worktree's own project directory and keeps writing there, same
// id and name; the old path is simply gone. Only once the bound file is
// gone, only by the session id itself (pinned_id — the name is the id), and
// only for the same segment and id: rebinds it to where the file went, the
// way a continuation does. The history it repeats is already stored, so
// only what came after is imported. True when it rebound.
export async function followMovedTranscript(binding: Binding): Promise<boolean> {
  const { session, conversation, adapter, file } = binding;
  if (!conversation.providerSessionId) return false;
  try {
    await stat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  const lookup = await adapter.locateSessionFile({
    cwd: session.cwd,
    providerSessionId: conversation.providerSessionId,
    launchedAfter: session.providerLaunchedAt ?? session.createdAt,
    conversationRoot: conversation.launchProfile?.conversationRoot,
  });
  if (lookup.status !== 'resolved' || lookup.identity !== 'pinned_id' || !lookup.file || lookup.file === file) return false;
  resetTurnWatch(session.id);
  trackerFor(session.id).ready = undefined;
  await registry.updateConversation(session.id, conversation.id, {
    transcript: { ...conversation.transcript, file: lookup.file },
  });
  return true;
}


// A transcript that isn't there yet is only "not found" once one was due:
// a message has been sent and the CLI has had the grace period to write it.
// Until then the absence is expected and reported as still pending.
function unresolvedState<S extends string>(conversation: { lastUserMessageAt?: string | null }, status: S): S | 'pending' {
  if (status !== 'not_found') return status;
  const sentAt = Date.parse(conversation.lastUserMessageAt ?? '');
  if (Number.isNaN(sentAt) || Date.now() - sentAt < TRANSCRIPT_NOT_FOUND_GRACE_MS) return 'pending';
  return status;
}

/**
 * The active conversation's transcript binding, looking the transcript up
 * first when it isn't bound yet — under the segment's own launch profile,
 * with its runtime. A lookup that doesn't resolve records why on the
 * segment (only when that changed) and gives null; one that resolves binds
 * it and returns the binding with `justBound`. `withoutSessionId`: whether
 * a segment with no provider session id yet may be looked up at all (a
 * reply in progress may; an idle poll waits for the id).
 */
export async function ensureBinding(
  session: ManagedSession,
  options: { withoutSessionId: boolean },
): Promise<{ binding: Binding; justBound: boolean } | null> {
  const existing = resolvedBinding(session);
  if (existing) return { binding: existing, justBound: false };
  const conversation = activeConversation(session);
  const adapter = conversation ? recordedRuntime(session, conversation) : undefined;
  if (!conversation || !adapter || (!options.withoutSessionId && !conversation.providerSessionId)) return null;
  const lookup = await adapter.locateSessionFile({
    cwd: session.cwd,
    providerSessionId: conversation.providerSessionId,
    launchedAfter: session.providerLaunchedAt ?? session.createdAt,
    conversationRoot: conversation.launchProfile?.conversationRoot,
  });
  if (lookup.status !== 'resolved' || !lookup.file || !lookup.identity) {
    const state = unresolvedState(conversation, lookup.status);
    const error = state === 'ambiguous' ? t('session.sync.ambiguousTranscript') : null;
    if (conversation.transcript.state !== state || conversation.transcriptError !== error) {
      await registry.updateConversation(session.id, conversation.id, {
        transcript: { state, file: null, identity: null }, transcriptError: error,
      });
    }
    return null;
  }
  const bound = await registry.updateConversation(session.id, conversation.id, {
    transcript: { state: 'resolved', file: lookup.file, identity: lookup.identity }, transcriptError: null,
  });
  const boundConversation = bound?.conversations?.find((candidate) => candidate.id === conversation.id) ?? conversation;
  // Defense in depth: provider parsers may only see a positively attributed transcript.
  if (boundConversation.transcript.state !== 'resolved' || boundConversation.transcript.identity === null
    || boundConversation.transcript.file !== lookup.file) return null;
  return { binding: { session, conversation: boundConversation, adapter, file: lookup.file }, justBound: true };
}

// A forked transcript's copied turns keep their own times; the fork's own
// first turn can be stamped a little before the conversation's recorded
// start (the CLI's clock against ours).
const FORK_START_SKEW_MS = 5_000;

/**
 * Turns already in a transcript when it was bound, which aren't this
 * segment's to import:
 * - a runtime recovered from before the conversation model may point at a
 *   transcript that also holds turns in the unverified legacy bucket: all
 *   of them, as it had them when its ownership was proven;
 * - a branch line's native fork (ADR 0023 決策 3): Claude Code copies the
 *   conversation it forked from, timestamps kept, ahead of its own turns
 *   (verified 2.1.294), so the turns asked before the segment started
 *   (less a skew) are the ones it came with. Codex copies none (0.161.0),
 *   which this counts as 0.
 * Records how many, so only turns after them are imported. True when it
 * just did (the caller stops for this poll).
 */
export async function establishTurnBaseline(binding: Binding): Promise<boolean> {
  const { session, conversation, adapter, file } = binding;
  if (conversation.transcriptTurnOffset != null) return false;
  if (conversation.startReason !== 'runtime_recovery' && conversation.startReason !== 'fork') return false;
  const baseline = await adapter.parseTurns(file);
  const offset = conversation.startReason === 'fork' ? turnsBefore(baseline, conversation.startedAt) : baseline.length;
  await registry.updateConversation(session.id, conversation.id, { transcriptTurnOffset: offset });
  return true;
}

/** How many leading turns were asked before `startedAt` (less the skew); one without a time counts as before. */
export function turnsBefore(turns: readonly Pick<Turn, 'user'>[], startedAt: string): number {
  const cutoff = Date.parse(startedAt) - FORK_START_SKEW_MS;
  const first = turns.findIndex((turn) => !!turn.user.at && Date.parse(turn.user.at) >= cutoff);
  return first < 0 ? turns.length : first;
}
