import { RUNTIME_IDENTITY_WARN_AFTER_MS, PANE_IDLE_FINALIZE_MS, PANE_IDLE_FINALIZE_QUIET_MS, POLL_INTERVAL_MS, STABLE_POLLS_BEFORE_FINAL, STOP_IMPORT_POLL_MS, STOP_IMPORT_TIMEOUT_MS } from './config.js';
import { isClosing } from './sync/closing.js';
import { recordedRuntime } from './runtimes/resolve.js';
import * as registry from './registry.js';
import * as tmuxCli from './tmux.js';
import type { TranscriptAdapter } from './providers/types.js';
import { activeTurnPhase, type ManagedSession, type PaneActivity, type PendingInteraction } from './types.js';
import { activeConversation, ensureBinding, establishTurnBaseline, followMovedTranscript, followTranscriptContinuation, resolvedBinding } from './sync/binding.js';
import { readFingerprint, sameFingerprint, trackerFor } from './sync/tracker.js';
import { applyRuntimeLeftReady, applyTurnEffects } from './sync/turnEffects.js';
import { nextTurn, turnStateOf, type TurnState } from './sync/turnMachine.js';
import { awaitedTurnLanded, awaitedWasCompactionSummary, readTurnChanges } from './sync/turns.js';
import { reconcileClear, reconcileLaunch, reconcileResume } from './sync/transitionReconciler.js';
import { reconcileSends, sendTransitions } from './sync/delivery.js';
import { pendingFromPane } from './sync/interaction.js';
import { refreshStartupPrompt, startupPromptPossible } from './sync/startupPrompt.js';
import { refreshWorkspace } from './sync/workspace.js';
import { BACKGROUND_TURN_QUIET_MS, refreshBackgroundAgents } from './sync/backgroundAgents.js';
import { refreshActualPermissionMode } from './sync/permissionMode.js';
import { refreshCliSuggestion } from './sync/cliSuggestion.js';
import { reconcileWithTmux } from './services/sessions.js';
import { recordSessionEvent } from './session-events.js';
import type { Msg } from './providers/msg.js';

export type PollingHandle = { stop(): void };

// Each tick is scheduled only once the previous one has settled, with
// POLL_INTERVAL_MS between them. A tick that runs long (many sessions,
// slow tmux/ps execs) must never overlap the next: both would advance the
// same trackers and apply the same turn effects twice. `runTick` is only
// swapped out by tests.
export function startPolling(runTick: () => Promise<void> = tick): PollingHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const scheduleNext = (): void => {
    timer = setTimeout(() => {
      timer = null;
      runTick()
        .catch((err: unknown) => console.error('[polling] tick failed', err))
        .finally(() => { if (!stopped) scheduleNext(); });
    }, POLL_INTERVAL_MS);
  };
  scheduleNext();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// Runs one step for every session in turn. A step failing for one session
// is logged and never stops the others.
async function forEachSession(
  sessions: readonly ManagedSession[],
  what: string,
  step: (session: ManagedSession) => Promise<void>,
): Promise<void> {
  for (const session of sessions) {
    try {
      await step(session);
    } catch (err) {
      console.error(`[polling] ${what} for session ${session.id} failed`, err);
    }
  }
}

// One per-session step of a tick: what it is (for the log), which
// sessions it is for, and what it does. A step failing for one session is
// logged and never stops the others (forEachSession).
type SessionStep = {
  name: string;
  appliesTo?: (session: ManagedSession) => boolean;
  run: (session: ManagedSession) => Promise<void>;
};

// What each tick does for every session before the turns are read, in this
// order. A new observation of the running CLI is one more entry here.
const BEFORE_TURNS: readonly SessionStep[] = [
  // CLI transitions the app started — a /clear or switch, a resume, a
  // launch — are confirmed or failed first (sync/transitionReconciler.ts).
  { name: 'pending clear check', run: reconcileClear },
  { name: 'pending Claude resume check', run: reconcileResume },
  { name: 'pending launch check', run: reconcileLaunch },
  // Independent of (and runs for a broader set of sessions than) the
  // replying/awaiting_approval step below — a launched CLI can exit while
  // just sitting idle at 'ready' (crash, or the user typing `exit`/Ctrl+D
  // themselves), a state that step never even looks at. See
  // checkProviderStillAlive's own comment.
  {
    name: 'liveness check',
    appliesTo: (session) => !(
      session.provider === null
      || session.status === 'dead'
      || !!session.clearPending
      // A launch with a durable pending snapshot is handled above and is
      // deliberately excluded here: right after sending its command, the
      // pane can briefly still show the shell before exec lands. A launching
      // record already attached to a conversation is also a known in-flight
      // runtime transition. Pre-feature records have no active ID and must
      // still be checked/recovered even though migration backfills pending=null.
      || (session.status === 'launching' && (!!session.launchPending || !!session.activeConversationId))
    ),
    run: (session) => checkProviderStillAlive(session.id),
  },
  // A CLI without a launch-time ID may expose a process-owned identity after
  // startup. This observation is read-only and binds only the still-active
  // segment; missing or conflicting evidence leaves transcript import closed.
  {
    name: 'runtime identity observation',
    appliesTo: (session) => session.providerSessionId === null && !session.clearPending && session.status !== 'dead',
    run: (session) => observeRuntimeIdentity(session.id),
  },
  // A CLI can open with a blocking prompt (e.g. Agy's workspace trust) that
  // would eat whatever is typed. Surface it so the user can answer it, and
  // clear it once it is gone. Only read while one is possible (sync/startupPrompt.ts).
  {
    name: 'start-up prompt check',
    run: async (session) => {
      const conversation = activeConversation(session);
      const runtime = conversation ? recordedRuntime(session, conversation) : undefined;
      if (!runtime || !startupPromptPossible(session, conversation, runtime)) return;
      await refreshStartupPrompt(session, runtime);
    },
  },
  // Every app send is tracked until the transcript shows it; one that never
  // shows up (a dialog ate it, the CLI wasn't listening) is surfaced with
  // its text kept, instead of vanishing when the next send replaces it.
  {
    name: 'delivery check',
    appliesTo: (session) => !!activeConversation(session)?.unconfirmedSends?.length,
    run: (session) => settleOutgoingSends(session.id),
  },
  // The checkout and branch the CLI works in, for the chat header
  // (sync/workspace.ts; throttled there).
  { name: 'workspace check', run: refreshWorkspace },
  // The CLI's own background subagents still running, for the terminal
  // button once the turn is over; cheap per tick, confirmations throttled
  // (sync/backgroundAgents.ts). Never touches the turn itself.
  { name: 'background subagent check', run: refreshBackgroundAgents },
  // The permission mode the CLI is actually in, which the terminal can
  // change (sync/permissionMode.ts); the cached transcript, once a tick.
  { name: 'permission mode check', run: refreshActualPermissionMode },
];

// What each tick does once the turns are read: it sees this tick's turn phase.
const AFTER_TURNS: readonly SessionStep[] = [
  // The CLI's own suggested next message, for the chat to offer (display
  // only; sync/cliSuggestion.ts).
  {
    name: 'CLI suggestion check',
    run: async (session) => {
      const fresh = await registry.getSession(session.id);
      if (fresh) await refreshCliSuggestion(fresh);
    },
  },
];

async function runSteps(sessions: readonly ManagedSession[], steps: readonly SessionStep[]): Promise<void> {
  for (const step of steps) {
    await forEachSession(sessions, step.name, async (session) => {
      if (step.appliesTo && !step.appliesTo(session)) return;
      await step.run(session);
    });
  }
}

export async function tick(): Promise<void> {
  // A tmux can vanish without the app knowing (killed outside it, its
  // server gone, a reboot). Checked every tick, not only when a client
  // lists sessions, so a chat left open sees its session end.
  await reconcileWithTmux().catch((err: unknown) => console.error('[polling] tmux reconcile failed', err));
  const sessions = await registry.listSessions();

  await runSteps(sessions, BEFORE_TURNS);
  for (const session of sessions) {
    const phase = activeTurnPhase(session);
    if (phase !== 'replying') {
      // paneActivity is only sampled while replying; whatever it last saw
      // belongs to a turn that is over now (imported, stopped, blocked on a
      // prompt, CLI gone). Clear it here rather than at every place that can
      // move a session out of replying (routes, registry, polling), so a
      // stale 'busy' can't linger. Only writes when there is something to
      // clear.
      trackerFor(session.id).paneIdleSince = undefined;
      const { effects } = nextTurn(turnStateOf(session), { type: 'pane_unsampled' });
      await applyTurnEffects(session, null, effects).catch((err: unknown) => {
        console.error(`[polling] pane activity reset for session ${session.id} failed`, err);
      });
    }
    // awaiting_approval has to keep being polled, not just replying —
    // sending a key (see routes/messages.ts /respond) no longer assumes
    // that resolves anything; only re-checking findPendingInteraction can
    // tell whether it actually did. Without this, a session would get
    // stuck showing the same interaction card forever after the first
    // keypress, since nothing else would ever look at it again.
    if (session.clearPending) continue;
    try {
      if (phase === 'replying' || phase === 'awaiting_approval') await pollOne(session.id);
      else if (phase === 'idle') await pollIdle(session.id);
    } catch (err) {
      console.error(`[polling] session ${session.id} failed`, err);
    }
  }

  await runSteps(sessions, AFTER_TURNS);
}

async function settleOutgoingSends(sessionId: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  const conversation = session && activeConversation(session);
  const sends = conversation?.unconfirmedSends;
  if (!session || !conversation || !sends?.length) return;
  // Only a positively bound transcript may confirm a send. Without one there
  // is no delivery evidence at all, which after the timeout is itself the
  // signal (a CLI whose transcript appears only after its first prompt).
  const tracker = trackerFor(session.id);
  if (activeTurnPhase(session) === 'replying') tracker.lastReplyingAt = Date.now();
  const binding = resolvedBinding(session);
  // A transcript that exists but can't be attributed (ambiguous, legacy) is
  // not "no evidence": the user is told that instead, never "undelivered".
  if (!binding && conversation.transcript.state !== 'pending' && conversation.transcript.state !== 'not_found') return;
  let messages: Msg[] | null = null;
  let turnStarts: string[] = [];
  if (binding) {
    // Flagged-only lists are re-read only when the transcript changes, so an
    // unanswered flag does not cost a full parse every poll.
    const fingerprint = await readFingerprint(binding.file);
    const onlyFlagged = sends.every((send) => send.flagged);
    if (onlyFlagged && fingerprint && tracker.deliveryFingerprint && sameFingerprint(tracker.deliveryFingerprint, fingerprint)) return;
    tracker.deliveryFingerprint = fingerprint ?? undefined;
    // A send made while a reply was still being written can be taken into
    // that turn as a follow-up instead of becoming a user message; it was
    // delivered all the same.
    const [userMessages, followUps, starts] = await Promise.all([
      binding.adapter.parseMessages(binding.file),
      binding.adapter.parseFollowUps?.(binding.file) ?? Promise.resolve([]),
      binding.adapter.parseTurnStarts?.(binding.file) ?? Promise.resolve([]),
    ]);
    messages = [...userMessages, ...followUps];
    turnStarts = starts;
  }
  const next = reconcileSends(sends, messages, Date.now(), tracker.lastReplyingAt, turnStarts);
  if (!next) return;
  // The pending bubble shows the latest send; it is uncertain exactly when
  // that send is still tracked and flagged.
  const latest = next.at(-1);
  const deliveryUnconfirmedText = latest?.flagged && latest.text === conversation.lastUserMessageText ? latest.text : null;
  await registry.updateConversation(session.id, conversation.id, { unconfirmedSends: next, deliveryUnconfirmedText });
  // Flagged, received and late confirmations are kept, so a false "possibly
  // undelivered" can be traced (and counted) without the transcript.
  for (const transition of sendTransitions(sends, next)) {
    const { send } = transition;
    const detail: Record<string, unknown> = {
      sentAt: send.at,
      preview: send.text.slice(0, 40),
      ...(send.midReply ? { midReply: true } : {}),
      ...(transition.kind === 'received' ? { receivedAt: send.receivedAt, wasFlagged: transition.wasFlagged } : {}),
      ...(transition.kind === 'confirmed' ? { afterMs: Date.now() - Date.parse(send.at), wasFlagged: send.flagged, received: !!send.receivedAt } : {}),
    };
    await recordSessionEvent({ sessionId: session.id, action: `send_${transition.kind}`, result: 'ok', source: 'reconcile', detail });
  }
}

// Per session+conversation: when the runtime identity was first seen
// unobservable, and whether that has been warned about. The poller retries
// every tick; the log fires once, and only if the state persists.
const unobservableIdentity = new Map<string, { since: number; warned: boolean }>();

async function observeRuntimeIdentity(sessionId: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  const conversation = session && activeConversation(session);
  if (!session || !conversation || session.providerSessionId !== null || session.clearPending
    || session.status === 'dead' || session.status === 'launching') return;
  const runtime = recordedRuntime(session, conversation);
  if (!runtime || !conversation.launchProfile || runtime.identity.kind !== 'observed_after_start') return;
  const pid = await tmuxCli.getPaneRuntimePid(session.tmuxName, runtime.processIdentity);
  if (pid === null) return;
  const observation = await runtime.identity.observe({ pid, profile: conversation.launchProfile, startedAt: conversation.startedAt });
  const key = `${session.id}:${conversation.id}`;
  if (observation.status === 'resolved') {
    // While a start-up prompt is up the CLI has no conversation of its own
    // yet: whatever it has open is someone else's (Agy 1.2.12 opens an old
    // one behind its trust prompt). Read after observing, so a prompt drawn
    // meanwhile is caught too; the prompt is recorded as a side effect.
    if (runtime.readStartupPrompt && await refreshStartupPrompt(session, runtime)) return;
    unobservableIdentity.delete(key);
    await registry.bindObservedSessionId(session.id, conversation.id, runtime.runtimeId, observation.providerSessionId);
    return;
  }
  if (observation.status !== 'unobservable') return;
  // A freshly started CLI may open its evidence a moment later; only a
  // persistent absence is reported.
  const seen = unobservableIdentity.get(key) ?? { since: Date.now(), warned: false };
  unobservableIdentity.set(key, seen);
  if (!seen.warned && Date.now() - seen.since >= RUNTIME_IDENTITY_WARN_AFTER_MS) {
    seen.warned = true;
    console.warn(`[polling] session ${session.id} ${runtime.runtimeId} pid ${pid} ${observation.reason}; session id stays unbound`);
  }
}

// An idle turn can still gain conversation without going through the
// API at all — the user typing straight into the tmux pane. Without this,
// nothing would read the transcript until the next send from the app
// flipped the turn back to replying, so the chat view silently fell
// behind. Two cheap-by-default reactions, both keyed on the transcript's
// fingerprint changing:
// - a new real user message with no reply yet → flip to replying, so the
//   normal pollOne path (stop button, stuck hint, finalization) takes over;
// - otherwise, once the file has gone quiet, import any complete turns not
//   stored yet (also catches up anything a past bug/restart skipped).
async function pollIdle(sessionId: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  if (!session || activeTurnPhase(session) !== 'idle') return;
  // Only a transcript the session id names is looked for while idle; a
  // just-bound one is read from the next poll on.
  const bound = await ensureBinding(session, { withoutSessionId: false });
  if (!bound || bound.justBound) return;
  const { binding } = bound;
  const { conversation, adapter, file } = binding;
  if (await followMovedTranscript(binding) || await followTranscriptContinuation(binding)) return;
  // A recovered CLI may already have turns in its verified transcript: the
  // baseline is set before ready-state import, just as pollOne does.
  if (await establishTurnBaseline(binding)) return;
  const fingerprint = await readFingerprint(file);
  if (!fingerprint) return;
  const tracker = trackerFor(session.id);
  const prev = tracker.ready;
  if (!prev || !sameFingerprint(prev.fingerprint, fingerprint)) {
    tracker.ready = { fingerprint, stableCount: 1, checked: false };
    const messages = await adapter.parseMessages(file);
    const last = [...messages].reverse().find((message) => message.role === 'user');
    const lastAt = last?.ts ? Date.parse(last.ts) : NaN;
    const lastStoredAt = Date.parse(conversation.turns.at(-1)?.user.at ?? '');
    const lastSentAt = Date.parse(conversation.lastUserMessageAt ?? '');
    const isNewUserMessage = !Number.isNaN(lastAt)
      && (Number.isNaN(lastStoredAt) || lastAt > lastStoredAt)
      && (Number.isNaN(lastSentAt) || lastAt > lastSentAt);
    // Still in progress: no reply text at all yet, or the adapter's
    // structural signal says the reply isn't finished (a CLI working through
    // tool calls writes interim text, so "last message is the user's" alone
    // misses most real turns). A finished one is left to the import below.
    const inProgress = isNewUserMessage && (
      messages.at(-1)?.role === 'user'
      || await adapter.isTurnComplete(file).then((result) => result.status === 'supported' && !result.value)
    );
    if (last?.ts && inProgress) {
      tracker.ready = undefined;
      // Recorded as if it had been sent from the app, so the stuck-hint
      // clock and the delivery-echo check measure from this message rather
      // than from whatever the app last sent.
      const { effects } = nextTurn(turnStateOf(session), { type: 'terminal_message', text: last.text, at: last.ts });
      await applyTurnEffects(session, conversation, effects);
    }
    return;
  }

  const stableCount = prev.stableCount + 1;
  tracker.ready = { ...prev, stableCount };
  if (prev.checked || stableCount < STABLE_POLLS_BEFORE_FINAL) return;
  tracker.ready = { ...prev, stableCount, checked: true };

  // The transcript is the authority on whether a turn is going, not what the
  // app last did: a turn a person opened that is still being written after
  // the app ended it (a stop the CLI never took, a pane misread as idle) is
  // the session replying again. Only once written after that end, so one
  // that never closes (a dangling tool_use) isn't reopened over and over.
  const openTurn = await adapter.openTurnAtEnd?.(file).catch(() => null) ?? null;
  const writtenSinceEnd = fingerprint.mtimeMs > (tracker.turnEndedAt ?? 0)
    && Date.now() - fingerprint.mtimeMs < BACKGROUND_TURN_QUIET_MS;
  if (openTurn?.openedBy === 'user' && writtenSinceEnd) {
    tracker.ready = undefined;
    const message = await unrecordedOpeningMessage(adapter, file, conversation, openTurn.at);
    await applyTurnEffects(session, conversation, nextTurn(turnStateOf(session), { type: 'open_turn', message }).effects);
    await recordSessionEvent({
      sessionId: session.id, action: 'turn_reopened', result: 'ok', source: 'reconcile',
      detail: { openedAt: openTurn.at, fromTerminal: !!message, turnEndedAt: tracker.turnEndedAt ? new Date(tracker.turnEndedAt).toISOString() : null },
    });
    return;
  }
  const completion = await adapter.isTurnComplete(file);
  // A turn still going (the CLI's own, woken by a background result) shows
  // as it is written; any other unfinished one waits for its end.
  if (completion.status === 'supported' && !completion.value && !openTurn) return;
  const changes = await readTurnChanges(binding);
  const { effects } = nextTurn(turnStateOf(session), {
    type: 'transcript_settled',
    turnComplete: completion.status === 'supported' ? completion.value : null,
    paneIdleLongEnough: false, awaitedLanded: false, changes, turnOpen: !!openTurn,
  });
  await applyTurnEffects(session, conversation, effects);
}

// The message an open turn started with, when it was typed in the terminal
// and never recorded as sent (newer than anything stored or sent); null
// when the app sent it or already has it.
async function unrecordedOpeningMessage(
  adapter: TranscriptAdapter,
  file: string,
  conversation: { turns: { user: { at: string | null } }[]; lastUserMessageAt: string | null },
  openedAt: string | null,
): Promise<{ text: string; at: string } | null> {
  const at = Date.parse(openedAt ?? '');
  if (!openedAt || Number.isNaN(at)) return null;
  const known = [conversation.turns.at(-1)?.user.at, conversation.lastUserMessageAt].map((value) => Date.parse(value ?? ''));
  if (known.some((value) => !Number.isNaN(value) && value >= at)) return null;
  const message = (await adapter.parseMessages(file)).find((candidate) => candidate.role === 'user' && candidate.ts === openedAt);
  return message ? { text: message.text, at: openedAt } : null;
}

// Cross-checks against tmux's own idea of what's running in the pane
// (#{pane_current_command} — see tmux.ts's own comment on the caveats),
// not just our internal bookkeeping (session.provider/status), which is
// set once at launch and never otherwise re-verified. If the CLI exited
// (crashed, or the user exited it directly in the terminal) the pane
// silently reverts to a plain shell — nothing about our own state would
// ever notice that on its own, and a session stuck believing a CLI is
// still there when it isn't would just wait forever for a reply that can
// never come.
async function checkProviderStillAlive(sessionId: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  if (!session || !session.provider || session.status === 'dead' || session.clearPending) return;
  // The app is closing this tmux: its CLI exiting is part of that.
  if (isClosing(session.id)) return;

  // Legacy records without an active conversation fall back to the
  // session's own binding inside recordedRuntime.
  const runtime = recordedRuntime(session, activeConversation(session));
  if (!runtime) return;
  const liveness = await tmuxCli.getPaneLiveness(session.tmuxName, runtime.processIdentity);
  if (liveness === 'unknown') return; // unknown is deliberately non-destructive; reconcile owns missing panes
  if (liveness === 'alive') {
    // Legacy migrations deliberately leave history unbound. Once the existing
    // runtime is positively observed, attach an empty segment for future
    // polling/sending without attributing legacy turns to this transcript.
    if (!session.activeConversationId) await registry.attachRuntimeRecoveryConversation(session.id);
    return;
  }

  // End only the active conversation; earlier segments and turns remain.
  trackerFor(session.id).waiting = undefined;
  const ended = await registry.endActiveConversation(session.id, 'cli_exit');
  if (ended) {
    await applyRuntimeLeftReady(ended);
    await recordSessionEvent({ sessionId: session.id, action: 'cli_exited', result: 'ended', source: 'reconcile', detail: { provider: session.provider } });
  }
}

/**
 * What the CLI is blocked on right now, if anything. The transcript's
 * unanswered tool_use is confirmed against the pane where it can be read
 * (an unresolved tool_use is also exactly what an approved, or auto-mode,
 * tool looks like while it runs; if the pane can't be read, the transcript's
 * answer stands rather than risk hiding a real prompt). Where the adapter
 * can read the prompt itself off the pane, that reading is attached — and
 * stands on its own, since a CLI may write nothing while a prompt waits
 * (Claude Code 2.1.284, docs/reference/human-in-the-loop.md).
 */
async function findPending(adapter: TranscriptAdapter, sessionFile: string, readPane: () => Promise<string | null>): Promise<PendingInteraction | null> {
  const pendingResult = await adapter.findPendingInteraction(sessionFile);
  let pending = pendingResult.status === 'supported' ? pendingResult.value : null;
  if (pending && adapter.paneShowsPermissionPrompt) {
    const pane = await readPane();
    if (pane !== null && !adapter.paneShowsPermissionPrompt(pane)) pending = null;
  }
  if (adapter.readPaneInteraction) {
    const pane = await readPane();
    const onScreen = pane === null ? null : adapter.readPaneInteraction(pane);
    if (onScreen) return pendingFromPane(onScreen, pending);
  }
  return pending;
}

/**
 * Re-reads what the CLI is blocked on right after the app answered part of
 * it (sync/interaction.ts), so the next question, or the reply, shows
 * without waiting for the next poll.
 */
export async function refreshPendingInteraction(sessionId: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  const phase = session ? activeTurnPhase(session) : null;
  if (!session || (phase !== 'replying' && phase !== 'awaiting_approval')) return;
  const bound = await ensureBinding(session, { withoutSessionId: true });
  if (!bound) return;
  const { conversation, adapter, file } = bound.binding;
  const pending = await findPending(adapter, file, () => tmuxCli.capturePane(session.tmuxName).catch(() => null));
  const event = pending ? { type: 'permission_prompt' as const, interaction: pending } : { type: 'prompt_gone' as const };
  await applyTurnEffects(session, conversation, nextTurn(turnStateOf(session), event).effects);
}

async function pollOne(sessionId: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  const phase = session ? activeTurnPhase(session) : null;
  if (!session || (phase !== 'replying' && phase !== 'awaiting_approval')) return;
  const bound = await ensureBinding(session, { withoutSessionId: true });
  if (!bound) return;
  const { binding } = bound;
  const { conversation, adapter, file: sessionFile } = binding;
  if (await followMovedTranscript(binding) || await followTranscriptContinuation(binding)) return;
  const tracker = trackerFor(session.id);
  // Updated as this poll's own transitions land; the rest of the snapshot is
  // what the poll started from.
  let turn: TurnState = turnStateOf(session);
  if (await establishTurnBaseline(binding)) return;

  // At most one capture per poll, shared by every pane read below.
  let paneCapture: Promise<string | null> | undefined;
  const readPane = () => (paneCapture ??= tmuxCli.capturePane(session.tmuxName).catch(() => null));

  // A pending decision takes priority over the stability/turn logic below —
  // it's definitive, so there's no need to wait for the file to go quiet
  // first.
  const pending = await findPending(adapter, sessionFile, readPane);
  if (pending) {
    // nextTurn only writes (and publishes) when the pending tool_use is a
    // different one — see its permission_prompt case.
    const { effects } = nextTurn(turn, { type: 'permission_prompt', interaction: pending });
    await applyTurnEffects(session, conversation, effects);
    return;
  }

  // No pending interaction — either there never was one, or a key/text
  // just resolved it (a tool_result finally showed up). Either way, fall
  // through to the normal stability/turn-completion tracking below exactly
  // as if this were a plain replying session.
  const promptGone = nextTurn(turn, { type: 'prompt_gone' });
  await applyTurnEffects(session, conversation, promptGone.effects);
  turn = { ...turn, phase: promptGone.phase, pendingToolUseId: promptGone.effects.length > 0 ? null : turn.pendingToolUseId };

  // What the CLI itself looks like right now, sampled on every replying
  // poll. It drives the terminal button's activity indicator (via the
  // derived `activity`) and the pane-idle safety net at the end of this
  // function. Written only when it changes: every write publishes an SSE
  // update, and an identical one every 800ms would just be noise.
  const paneActivity = adapter.paneShowsBusy ? observePane(adapter, await readPane()) : 'unknown';
  await applyTurnEffects(session, conversation, nextTurn(turn, { type: 'pane_observed', activity: paneActivity }).effects);
  if (paneActivity === 'idle') {
    tracker.paneIdleSince ??= Date.now();
  } else {
    tracker.paneIdleSince = undefined;
  }

  // Whether each app send reached the CLI is settled separately, for every
  // phase and even before a transcript exists (settleOutgoingSends).

  const fingerprint = await readFingerprint(sessionFile);
  if (!fingerprint) return; // file momentarily unreadable — try next tick

  const prev = tracker.waiting;
  const unchanged = !!prev && sameFingerprint(prev.fingerprint, fingerprint);
  const stableCount = prev && unchanged ? prev.stableCount + 1 : 1;
  const changedAt = prev && unchanged ? prev.changedAt : Date.now();
  tracker.waiting = { fingerprint, stableCount, changedAt };

  // Can't confirm this the way findPendingInteraction confirms a tool
  // prompt (nothing gets written to the transcript while e.g. a /status
  // panel is open — see docs/reference/human-in-the-loop.md), so this only ever sets
  // a hint, never changes the turn phase, and never overwrites a different hint
  // already shown. Measured from the transcript's last change (or the send,
  // whichever is later), not from the send alone: a long reply that keeps
  // writing isn't stuck. A CLI whose pane says it's busy (thinking, or a
  // slow tool that writes nothing until it finishes) isn't either. Wall
  // clock, not poll count, so it stays meaningful regardless of how fast
  // POLL_INTERVAL_MS is tuned.
  const quietSince = Math.max(changedAt, Date.parse(session.lastUserMessageAt ?? '') || 0, tracker.lastControlKeyAt ?? 0);
  await applyTurnEffects(session, conversation, nextTurn(turn, {
    type: 'transcript_watch', changed: !unchanged, quietMs: Date.now() - quietSince, paneActivity,
  }).effects);

  if (stableCount < STABLE_POLLS_BEFORE_FINAL) return;

  // File-quiescence alone can't distinguish "actually done" from "still
  // mid-turn, just between two tool calls" (a slow tool, or the model
  // thinking, can easily leave the transcript unchanged for longer than
  // STABLE_POLLS_BEFORE_FINAL's window) — ask the adapter's own structural
  // signal too. Without this, a turn gets finalized on whatever partial
  // assistant text happened to be written so far, the turn flips to
  // idle, and nothing generated after that point is ever polled again
  // (see the comment on the `tick()` loop above: only replying /
  // awaiting_approval turns get polled this way).
  const completion = await adapter.isTurnComplete(sessionFile);
  // Unknown/unsupported means there is no structural completion assertion;
  // the separately established file-quiescence heuristic remains the only
  // signal for these providers. Never convert the capability result to `true`.
  const turnComplete = completion.status === 'supported' ? completion.value : null;
  // Safety net for a transcript whose shape never says "done" — a tool
  // interrupted before its tool_result was written leaves a dangling
  // tool_use forever, and without this the session would sit in replying
  // with the chat never updating again. The pane can settle it: quiet
  // transcript plus the CLI back at its input box, not busy and not on a
  // permission prompt, continuously for PANE_IDLE_FINALIZE_MS. Needs a
  // verified idle reading; without one the transcript stays the only
  // authority.
  const idleSince = tracker.paneIdleSince;
  const paneIdleLongEnough = !!adapter.paneShowsIdle && idleSince !== undefined && Date.now() - idleSince >= PANE_IDLE_FINALIZE_MS
    && Date.now() - changedAt >= PANE_IDLE_FINALIZE_QUIET_MS;

  // Imported either way: an unfinished turn shows what it has so far and
  // keeps replying; a finished one (or the pane safety net) also unlocks,
  // once the reply being waited on has landed (nextTurn).
  const changes = await readTurnChanges(binding);
  // A turn opened on the CLI's own compaction summary has nothing to wait for.
  const awaitedLanded = awaitedTurnLanded(conversation, changes)
    || awaitedWasCompactionSummary(conversation, await adapter.parseCompactionSummaryTimes?.(sessionFile) ?? []);
  const settled = nextTurn(turn, { type: 'transcript_settled', turnComplete, paneIdleLongEnough, awaitedLanded, changes });
  await applyTurnEffects(session, conversation, settled.effects);
  // Ended on the pane's word against the transcript's: kept, so a wrong
  // ending can be traced.
  if (turnComplete === false && settled.phase === 'idle') {
    await recordSessionEvent({
      sessionId: session.id, action: 'turn_ended_by_pane', result: 'ok', source: 'reconcile',
      detail: { paneIdleMs: Date.now() - (idleSince ?? Date.now()), transcriptQuietMs: Date.now() - changedAt },
    });
  }
}

// Busy wins over idle (the input box stays on screen while the CLI works);
// anything else — an unreadable pane, a local panel like /status, a
// permission prompt — is 'unknown', never a guess either way.
function observePane(adapter: TranscriptAdapter, pane: string | null): PaneActivity {
  if (pane === null) return 'unknown';
  if (adapter.paneShowsBusy?.(pane)) return 'busy';
  if (adapter.paneShowsIdle?.(pane)) return 'idle';
  return 'unknown';
}

// Restarts the stuck hint's quiet clock (see pollOne) when a control key is
// sent by hand — see routes/messages.ts /respond.
export function noteControlKey(sessionId: string): void {
  trackerFor(sessionId).lastControlKeyAt = Date.now();
}

// Run in the background after the stop button's Esc (routes/messages.ts
// /stop). That route unlocks the turn to idle right away, which also
// takes it out of tick()'s reply polling — so without this, the interrupted
// turn would only get imported once the next send put it back to replying.
// Waits for the interrupted marker to close the turn (Claude writes it a
// moment after the key), falling back to whatever complete turn exists at
// the timeout (providers with no such marker). Backs off the moment a new
// send takes the turn back to replying: normal polling owns it then.
export async function importTurnsAfterStop(sessionId: string): Promise<void> {
  const deadline = Date.now() + STOP_IMPORT_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, STOP_IMPORT_POLL_MS));
    const session = await registry.getSession(sessionId);
    if (!session || activeTurnPhase(session) !== 'idle') return;
    const binding = resolvedBinding(session);
    if (!binding) return;

    const changes = await readTurnChanges(binding);
    const timedOut = Date.now() >= deadline;
    // The interrupted reply is either a new turn or (stopped mid-reply after
    // an isMeta wake-up) the last stored one growing — see diffTurns.
    const latest = changes.newTurns.at(-1) ?? changes.grownLast;
    if (latest && (timedOut || latest.assistant.interrupted)) {
      const { effects } = nextTurn(turnStateOf(session), { type: 'interrupted_reply', changes });
      await applyTurnEffects(session, binding.conversation, effects);
      await recordStopOutcome(sessionId, !!latest.assistant.interrupted);
      return;
    }
    if (timedOut) {
      await recordStopOutcome(sessionId, false);
      return;
    }
  }
}

// Whether the CLI wrote its interrupt for the stop button's key. Without
// one it may well be still working (the key went to another screen); the
// turn is then taken up again by pollIdle once the transcript grows.
async function recordStopOutcome(sessionId: string, interrupted: boolean): Promise<void> {
  await recordSessionEvent({ sessionId, action: 'stop', result: interrupted ? 'interrupted' : 'no_interrupt_seen', source: 'app' });
}
