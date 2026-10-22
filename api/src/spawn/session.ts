import type { PermissionMode } from '../contract/permissions.js';
import * as registry from '../registry.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import { recordSessionEvent, type SessionEventSource } from '../session-events.js';
import * as sessionService from '../services/sessions.js';
import * as transitions from '../services/transitions.js';
import { activeConversation } from '../sync/binding.js';
import { answerStartupPrompt, refreshStartupPrompt } from '../sync/startupPrompt.js';
import * as tmuxCli from '../tmux.js';
import { activeTurnPhase, type ConversationSegment, type ManagedSession } from '../types.js';
import type { SessionView } from './ports.js';
import { t } from '../i18n/index.js';

// The tmux and CLI a delegation or a branch line starts, against the real
// app: made, launched, read, answered and closed as the app's own buttons
// do, with each step written to the session events under `source`.

export type { SessionView } from './ports.js';

// A turn's recorded time can trail the send by the CLI's own delay.
const SEND_SKEW_MS = 5_000;

export function sessionView(session: ManagedSession): SessionView {
  const conversation = activeConversation(session);
  const lastTurn = conversation?.turns.at(-1);
  return {
    profileId: conversation?.launchProfile?.id ?? null,
    running: session.status === 'ready',
    switching: !!(session.clearPending || session.launchPending || session.resumePending) || session.status === 'launching',
    launching: session.status === 'launching' || !!session.launchPending,
    phase: activeTurnPhase(session),
    provider: session.provider,
    startupPrompt: session.startupPrompt?.kind ?? null,
    interaction: !!session.pendingInteraction,
    lastTurnAt: lastTurn?.assistant.at ?? lastTurn?.user.at ?? null,
    lastSentAt: conversation?.lastUserMessageAt ?? null,
    lastError: session.lastError,
  };
}

/** Any session's CLI; null when the session is gone. */
export async function readSession(sessionId: string): Promise<SessionView | null> {
  const session = await registry.getSession(sessionId);
  return session ? sessionView(session) : null;
}

/**
 * A registered session in `cwd`, in the project, whose tmux carries `env`,
 * named `alias`. One with this id already there is left as it is; a tmux
 * left from a start cut short between making it and recording it is
 * killed first.
 */
export async function ensureSession(input: {
  sessionId: string; cwd: string; projectId: string; alias: string;
  env: Record<string, string>; source: SessionEventSource; detail: Record<string, unknown>;
  forkOrigin?: ManagedSession['forkOrigin'];
  delegationOrigin?: ManagedSession['delegationOrigin'];
}): Promise<void> {
  if (await registry.getSession(input.sessionId)) return;
  const tmuxName = registry.tmuxNameFor(input.sessionId);
  if (await tmuxCli.sessionExists(tmuxName)) {
    await tmuxCli.killSession(tmuxName);
    await recordSessionEvent({ sessionId: input.sessionId, action: 'kill_leftover', result: 'ok', source: input.source, detail: input.detail });
  }
  // Its worktree isn't one of the project's paths (spawn/roots.ts); in the
  // starting session's own folder, it is one already.
  await sessionService.createSession(input.cwd, input.projectId, {
    id: input.sessionId, env: input.env, rememberPath: false,
    ...(input.forkOrigin ? { forkOrigin: input.forkOrigin } : {}),
    ...(input.delegationOrigin ? { delegationOrigin: input.delegationOrigin } : {}),
  });
  await recordSessionEvent({ sessionId: input.sessionId, action: 'create', result: 'ok', source: input.source, detail: { ...input.detail, cwd: input.cwd } });
  await registry.updateSession(input.sessionId, { alias: input.alias });
}

/**
 * Starts the profile's CLI in it, as the app's own launch does; with
 * `fork`, forking that session's conversation (a branch line's native fork).
 */
export async function launch(
  sessionId: string, profileId: string, source: SessionEventSource, fork?: { sessionId: string; conversationId: string },
  permissionMode?: PermissionMode,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let forkFrom: { sessionId: string; conversation: ConversationSegment } | undefined;
  if (fork) {
    const conversation = (await registry.getSession(fork.sessionId))?.conversations?.find((item) => item.id === fork.conversationId);
    if (!conversation) return { ok: false, reason: t('spawn.session.forkConversationMissing') };
    forkFrom = { sessionId: fork.sessionId, conversation };
  }
  const result = await transitions.launch(sessionId, { profileId, ...(forkFrom ? { fork: forkFrom } : {}), ...(permissionMode ? { permissionMode } : {}) });
  await recordSessionEvent({
    sessionId, action: 'launch', result: result.ok ? 'ok' : result.code, source,
    detail: {
      profileId, permissionMode: result.ok ? result.permissionMode : permissionMode ?? null,
      ...(result.ok && result.permissionFallbackFrom ? { permissionFallbackFrom: result.permissionFallbackFrom } : {}),
      ...(fork ? { forkedFrom: fork } : {}),
    },
  });
  if (result.ok) return { ok: true };
  // Launched already (a restart between the launch and its record).
  if (result.code === 'cli_already_running' || result.code === 'launch_unconfirmed') return { ok: true };
  return { ok: false, reason: result.error };
}

/** Answers the CLI's start-up trust prompt with "trust". */
export async function answerTrust(sessionId: string): Promise<'answered' | 'unsure'> {
  const session = await registry.getSession(sessionId);
  const conversation = session ? activeConversation(session) : undefined;
  const runtime = session && conversation ? recordedRuntime(session, conversation) : undefined;
  if (!session || !runtime?.readStartupPrompt) return 'unsure';
  const answer = await answerStartupPrompt(session.tmuxName, runtime, 'trust').catch(() => 'unsure' as const);
  if (answer === 'unsure') return 'unsure';
  const latest = (await registry.getSession(sessionId)) ?? session;
  await refreshStartupPrompt(latest, runtime).catch(() => null);
  return 'answered';
}

export type CloseOutcome = { ok: true; closed: boolean } | { ok: false; reason: 'cli_busy' | 'exit_unverified' | 'in_transition' };

/**
 * Closes the tmux as the app's 關閉此 tmux does: its CLI asked to exit
 * first (`force` ends it as it is). `closed` is false when there was no
 * tmux left to close.
 */
export async function closeSession(sessionId: string, source: SessionEventSource, options: { force?: boolean } = {}): Promise<CloseOutcome> {
  const session = await registry.getSession(sessionId);
  if (!session || !(await tmuxCli.sessionExists(session.tmuxName))) return { ok: true, closed: false };
  const result = await sessionService.closeSession(sessionId, { force: options.force });
  await recordSessionEvent({ sessionId, action: options.force ? 'close_force' : 'close', result: result.status, source });
  if (result.status === 'closed') return { ok: true, closed: true };
  if (result.status === 'not_found') return { ok: true, closed: false };
  return { ok: false, reason: result.status === 'in_transition' ? 'in_transition' : result.status };
}

/** The reply to the first turn that began at or after `since`, once it is over; null before. */
export async function firstReplyAfter(sessionId: string, since: string): Promise<string | null> {
  const session = await registry.getSession(sessionId);
  const conversation = session ? activeConversation(session) : undefined;
  if (!session || !conversation) return null;
  const after = Date.parse(since) - SEND_SKEW_MS;
  const index = conversation.turns.findIndex((turn) => !!turn.user.at && Date.parse(turn.user.at) >= after);
  if (index < 0) return null;
  // Over: a later turn began, or the CLI is back at its input box.
  const over = index < conversation.turns.length - 1 || activeTurnPhase(session) === 'idle';
  return over ? conversation.turns[index]!.assistant.text : null;
}
