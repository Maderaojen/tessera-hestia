import { randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { TMUX_SOCKET } from '../config.js';
import { getLaunchProfileCatalog } from '../launch-profiles.js';
import * as registry from '../registry.js';
import * as tmuxCli from '../tmux.js';
import { tmuxEnvFor } from './tmux-env.js';
import { endIfTmuxGone } from './sessions.js';
import type { ErrorCode, ErrorParams } from '../contract/errors.js';
import { activeTurnPhase, type ConversationSegment, type LaunchProfileSnapshot, type ManagedSession } from '../types.js';
import { conversationForkBlocked, conversationResumeBlocked } from '../runtimes/conversation-blocks.js';
import { getRuntimeDriverForProvider, getRuntimeDriver } from '../runtimes/index.js';
import { deadSessionRecovery, resumableRuntime } from '../runtimes/resume.js';
import { buildLaunchCommand, permissionModeRefusal, snapshotLaunchProfile } from '../runtimes/launch.js';
import type { PermissionMode } from '../contract/permissions.js';
import { permissionModes } from '../permission-modes/service.js';
import type { LaunchProfile } from '../launch-profiles.js';
import type { RuntimeDriver } from '../runtimes/types.js';
import { recordedRuntime, segmentRuntime } from '../runtimes/resolve.js';
import { applyRuntimeLeftReady } from '../sync/turnEffects.js';
import { canRequestExit, requestRuntimeExit } from '../sync/exit.js';
import { checkCommandAvailable } from '../runtimes/command-check.js';
import { forgetStartupObservation } from '../sync/startup.js';
import { t, type MessageKey } from '../i18n/index.js';

// Every user-started CLI transition — launch, /clear, switching to or
// recovering a conversation, and the force/cancel answers of a switch —
// from its preconditions through the durable claim to the one dispatch of
// its command. Confirming that the CLI actually started (or exited) is the
// poller's (sync/transitionReconciler.ts), never done here
// (docs/decisions/0010-runtime-transition-convergence.md). HTTP routes only translate
// the result; nothing here knows about requests.

/**
 * `status` is the HTTP status the routes have always answered with, and
 * `error` the message shown to the user. `session` is what to show after
 * an accepted transition (absent where the route has always sent no body).
 */
export type TransitionResult =
  // `permissionMode`: the mode a launch or a handoff starts its CLI in;
  // `permissionFallbackFrom`: the saved mode it couldn't use (this host
  // can't now), so it starts in cli_default instead.
  | { ok: true; status: 200 | 202; session?: ManagedSession; permissionMode?: PermissionMode; permissionFallbackFrom?: PermissionMode }
  | { ok: false; status: 400 | 404 | 409 | 503; code: ErrorCode; error: string; params?: ErrorParams };

const accepted = (session: ManagedSession | undefined, status: 200 | 202 = 202): TransitionResult => ({ ok: true, status, session });
const refused = (status: 400 | 404 | 409 | 503, code: ErrorCode, error: string, params?: ErrorParams): TransitionResult => (
  { ok: false, status, code, error, ...(params ? { params } : {}) }
);

async function runnable(executable: string, cwd: string): Promise<boolean> {
  // Bare command names are resolved by the destination tmux pane's shell,
  // which is the same environment that runs provider launch commands. The
  // API may be a systemd service with a narrower PATH, so checking its PATH
  // here incorrectly rejects valid commands such as `~/.local/bin/claude`.
  if (!executable) return false;
  if (!path.isAbsolute(executable) && !executable.includes('/')) return true;
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : [path.resolve(cwd, executable)];
  for (const candidate of candidates) {
    try { await access(candidate, fsConstants.X_OK); return true; } catch { /* try next PATH entry */ }
  }
  return false;
}

async function readableDirectory(value: string): Promise<boolean> {
  if (!path.isAbsolute(value)) return false;
  try {
    return (await stat(value)).isDirectory() && (await access(value, fsConstants.R_OK), true);
  } catch { return false; }
}

// Whether the session's working directory is still there to reopen its
// tmux in. A tmux can't start in a folder that was moved or deleted, and a
// CLI resumed elsewhere might not find its conversation.
async function directoryExists(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch { return false; }
}


/**
 * Whether a recorded conversation can be reopened right now: its runtime
 * resumes in place (runtimes/resume.ts), its saved launch profile still
 * builds a runnable resume command whose home and conversation folder
 * exist, and its CLI transcript is still the conversation's own. Returns
 * that command's argv. Shared by recovering a dead tmux and switching
 * conversations, so the two can't drift apart.
 *
 * The provider session id is what identifies the transcript; the recorded
 * file is only where it was last seen. A lookup that finds the same id
 * (by its id-based identity) at another path — the CLI moved it, a
 * worktree took it over — is still this conversation: `movedTo` carries
 * the new path for the caller to record before claiming.
 */
async function verifyResumable(conversation: ConversationSegment, cwd: string): Promise<{ ok: true; argv: string[]; movedTo: string | null } | { ok: false; code: ErrorCode; error: string }> {
  const profile = conversation.launchProfile;
  const runtime = resumableRuntime(conversation);
  const argv = runtime && profile && conversation.providerSessionId
    ? buildLaunchCommand(runtime, profile, cwd, { kind: 'resume', providerSessionId: conversation.providerSessionId })?.argv ?? null
    : null;
  if (!runtime || !profile || !argv || !(await readableDirectory(profile.home ?? '')) || !(await readableDirectory(profile.conversationRoot ?? '')) || !(await runnable(profile.delegate.executable, cwd))) {
    return { ok: false, code: 'resume_profile_unavailable', error: t('session.transition.resumeProfileUnavailable') };
  }
  const lookup = await runtime.locateSessionFile({
    cwd,
    providerSessionId: conversation.providerSessionId!,
    launchedAfter: conversation.startedAt,
    conversationRoot: profile.conversationRoot,
  });
  const missing = { ok: false as const, code: 'resume_transcript_missing' as const, error: t('session.transition.resumeTranscriptMissing') };
  if (lookup.status !== 'resolved' || !lookup.file) return missing;
  if (path.resolve(lookup.file) === path.resolve(conversation.transcript.file!)) return { ok: true, argv, movedTo: null };
  // Elsewhere: only a lookup that found it by the session id itself counts.
  if (lookup.identity !== 'pinned_id' && lookup.identity !== 'verified_metadata') return missing;
  return { ok: true, argv, movedTo: lookup.file };
}

// Records where a conversation's transcript is now (verifyResumable's
// movedTo) in one registry write: the segment's file, and for the active
// conversation the session's mirrors of it too (registry.updateConversation),
// so polling never sees a half-moved binding and re-imports nothing — turns
// are matched by their timestamps, not by file.
export async function recordMovedTranscript(session: ManagedSession, conversation: ConversationSegment, movedTo: string | null): Promise<void> {
  if (!movedTo) return;
  await registry.updateConversation(session.id, conversation.id, { transcript: { ...conversation.transcript, file: movedTo } });
}

/**
 * What reopening a conversation may ask of the rest of the app. Injected by
 * the route so the transition service stays free of continuity/ (which
 * itself drives transitions).
 */
export type ResumeDeps = {
  // When the account behind this saved launch profile is known to be over
  // its usage limit, the time it resets; null otherwise.
  accountLimitedUntil?(profile: LaunchProfileSnapshot): Promise<string | null>;
};

// A conversation is only reopened on the account it was recorded on (a
// thread lives in that account's own home). One known to be over its
// limit couldn't answer anyway: refused, with when it resets. After a
// handoff this is the usual reason the earlier conversation can't be
// switched back to yet.
async function accountLimitRefusal(conversation: ConversationSegment, deps: ResumeDeps): Promise<TransitionResult | null> {
  if (!conversation.launchProfile || !deps.accountLimitedUntil) return null;
  const until = await deps.accountLimitedUntil(conversation.launchProfile);
  return until
    ? refused(409, 'resume_account_limited', t('session.transition.resumeAccountLimited', { until }), { until })
    : null;
}

// Opens a session's tmux again (it ended; recovering or switching needs
// one), on this install's own server: an older session that was on the
// default server moves over with it, its record first so every later
// command goes to the new one (tmux.ts SocketLookup).
async function reopenTmux(session: ManagedSession): Promise<void> {
  if (session.tmuxSocket !== TMUX_SOCKET) await registry.updateSession(session.id, { tmuxSocket: TMUX_SOCKET });
  await tmuxCli.newSession(session.tmuxName, session.cwd, await tmuxEnvFor(session.id));
}

// A command the pane's shell can't find would only print "command not found"
// and leave the launch waiting out the whole startup grace. Only a definite
// "missing" refuses; an unclear check launches as before.
async function refuseMissingCommand(executable: string, session: ManagedSession): Promise<TransitionResult | null> {
  if (await checkCommandAvailable(executable, { tmuxName: session.tmuxName, cwd: session.cwd }) !== 'missing') return null;
  return refused(409, 'launch_cli_not_found', t('session.transition.cliNotFound', { command: executable }), { command: executable });
}

const PERMISSION_REFUSALS = {
  permission_mode_unsupported: 'session.transition.permissionModeUnsupported',
  permission_mode_unavailable: 'session.transition.permissionModeUnavailable',
  permission_mode_conflict: 'session.transition.permissionModeConflict',
} as const satisfies Record<string, MessageKey>;

/**
 * The snapshot a launch of `profile` in this tmux starts from, with its
 * permission mode: the
 * launch's own `requested` one, else the tmux's or the global setting. A
 * native profile whose own args already decide permissions refuses a mode
 * chosen for this launch; one only inherited from a setting gives way to
 * the profile's args (cli_default) instead of blocking every launch of it.
 */
async function snapshotWithMode(
  sessionId: string, runtime: RuntimeDriver, profile: LaunchProfile, requested: PermissionMode | undefined,
): Promise<{ ok: true; snapshot: LaunchProfileSnapshot; fallbackFrom?: PermissionMode } | { ok: false; result: TransitionResult }> {
  const resolved = await permissionModes.launchMode({ sessionId, runtimeId: runtime.runtimeId, ...(requested ? { requested } : {}) });
  if (!resolved.ok) return { ok: false, result: refused(400, resolved.code, t(PERMISSION_REFUSALS[resolved.code])) };
  const fallback = resolved.fallbackFrom ? { fallbackFrom: resolved.fallbackFrom } : {};
  const snapshot = snapshotLaunchProfile(runtime, profile, resolved.mode);
  const refusal = permissionModeRefusal(runtime, snapshot);
  if (!refusal) return { ok: true, snapshot, ...fallback };
  if (requested === undefined) return { ok: true, snapshot: snapshotLaunchProfile(runtime, profile), fallbackFrom: resolved.mode };
  return { ok: false, result: refused(409, refusal, t(PERMISSION_REFUSALS[refusal])) };
}

/**
 * Starts a profile's CLI in a tmux with none bound. With `fork`, the CLI
 * forks that conversation (of session `sessionId`) instead of starting
 * fresh — a branch line's native fork (ADR 0023 決策 3): the profile must
 * run the runtime that recorded it, and the runtime must fork.
 */
export async function launch(
  sessionId: string,
  request: { profileId: string; name?: string; fork?: { sessionId: string; conversation: ConversationSegment }; permissionMode?: PermissionMode },
): Promise<TransitionResult> {
  const catalog = await getLaunchProfileCatalog();
  const profile = catalog.profiles.find((candidate) => candidate.id === request.profileId);
  if (!profile) return refused(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
  const session = await registry.getSession(sessionId);
  if (!session) return refused(404, 'not_found', 'not found');
  if (session.status === 'dead' || await endIfTmuxGone(session)) return refused(409, 'session_dead', 'session is dead');
  if (session.status === 'launching' && session.launchPending) return refused(409, 'launch_unconfirmed', t('session.transition.launchUnconfirmed'));
  if (session.provider !== null) {
    return refused(409, 'cli_already_running', 'an active CLI is already bound to this tmux session; wait for it to exit before launching another');
  }

  const provider = profile.provider;
  const runtimeId = profile.runtimeId ?? getRuntimeDriverForProvider(provider).runtimeId;
  const runtime = getRuntimeDriver(runtimeId);
  if (!runtime || runtime.provider !== provider) return refused(409, 'runtime_unrecognized', t('session.transition.runtimeUnrecognized'));
  const snapshot = await snapshotWithMode(session.id, runtime, profile, request.permissionMode);
  if (!snapshot.ok) return snapshot.result;
  const launchProfile = snapshot.snapshot;
  const from = request.fork?.conversation;
  if (from && (conversationForkBlocked(from) || segmentRuntime(from)?.runtimeId !== runtimeId)) {
    return refused(409, 'launch_config_incomplete', t('session.transition.forkProfileUnusable'));
  }
  const command = buildLaunchCommand(runtime, launchProfile, session.cwd, from
    ? { kind: 'fork', fromProviderSessionId: from.providerSessionId! }
    : { kind: 'fresh', name: request.name });
  if (!command) return refused(409, 'launch_config_incomplete', t('session.transition.launchConfigIncomplete'));
  const missing = await refuseMissingCommand(launchProfile.delegate.executable, session);
  if (missing) return missing;
  const launchedAt = new Date().toISOString();

  // Preserve the existing visible launch state, but do not bind provider/profile
  // or create a conversation until pane liveness positively confirms startup.
  const pending = await registry.beginPendingLaunch(session.id, {
    provider,
    runtimeId,
    providerSessionId: command.providerSessionId,
    providerLaunchedAt: launchedAt,
    previousStatus: session.status,
    previousTurnPhase: session.turnPhase,
    launchProfile,
    ...(request.fork ? { fork: { fromSessionId: request.fork.sessionId, fromConversationId: request.fork.conversation.id } } : {}),
  });
  if (!pending) return refused(409, 'cli_already_running', 'another launch or active CLI is already bound to this tmux session');
  // Claim, then dispatch exactly once. Whether the CLI actually started is
  // judged by the poller under the one startup rule every transition shares.
  try {
    await tmuxCli.sendCommandLine(session.tmuxName, command.argv);
  } catch {
    // The keys may have reached tmux before the error surfaced. Keep the
    // claim and let the poller observe; sending again could start a twin.
    await registry.updateSession(session.id, { lastError: t('session.transition.launchDeliveryUncertain') });
    return refused(503, 'launch_delivery_uncertain', t('session.transition.launchDeliveryUncertain'));
  } finally {
    registry.releaseLaunchAttempt(session.id, launchedAt);
  }
  return {
    ok: true, status: 202, session: (await registry.getSession(session.id)) ?? pending, permissionMode: launchProfile.permissionMode ?? 'cli_default',
    ...(snapshot.fallbackFrom ? { permissionFallbackFrom: snapshot.fallbackFrom } : {}),
  };
}

/**
 * The user gave up on a launch still waiting for its startup to be
 * confirmed: the pane is reset to a fresh shell — ending whatever the
 * command started, so no unbound CLI is left behind — and the session goes
 * back to where it was before the launch, ready for another one.
 */
export async function cancelLaunch(sessionId: string): Promise<TransitionResult> {
  const session = await registry.getSession(sessionId);
  if (!session) return refused(404, 'not_found', 'not found');
  const attempt = session.launchPending;
  // Still between claim and dispatch: the launch request itself decides.
  if (session.status !== 'launching' || !attempt || registry.ownsLaunchAttemptLocally(session.id, attempt.providerLaunchedAt)) {
    return refused(409, 'no_launch_to_cancel', t('session.transition.noLaunchToCancel'));
  }
  const claimed = await registry.claimPendingLaunch(session.id, attempt.providerLaunchedAt);
  if (!claimed) return refused(409, 'no_launch_to_cancel', t('session.transition.noLaunchToCancel'));
  try {
    try {
      await tmuxCli.respawnPane(claimed.tmuxName, claimed.cwd);
    } catch {
      return refused(503, 'pane_reset_failed', t('session.transition.paneResetFailed'));
    }
    forgetStartupObservation(session.id);
    const updated = await registry.rollbackPendingLaunch(session.id, null, attempt.providerLaunchedAt);
    return accepted(updated, 200);
  } finally {
    // If reset or persistence failed, the pending launch remains recoverable:
    // the poller judges the pane instead of replaying the destructive reset.
    registry.releaseLaunchAttempt(session.id, attempt.providerLaunchedAt);
  }
}

/**
 * The app's exact `/clear`: asks the running CLI to exit through its
 * runtime's verified exit, then (in the poller, once the old CLI is
 * observed gone) starts a fresh one from the same saved profile as a new
 * conversation segment. `session` is the one the message route already
 * checked has a live, bound CLI.
 */
export async function clearAndRelaunch(session: ManagedSession): Promise<TransitionResult> {
  return exitAndRelaunch(session, null);
}

/**
 * Hands the session over to another launch profile (continuity/): the same
 * exit-then-launch as /clear, in the same tmux, except the new conversation
 * runs `profileId`. The conversation being left stays listed. The new CLI
 * starts in `permissionMode` when the user chose one for this handoff,
 * else in the tmux's or the global setting for its runtime — never in the
 * mode the conversation being left was started in.
 */
export async function handOff(
  session: ManagedSession, profileId: string, options: { force?: boolean; expectedConversationId?: string; permissionMode?: PermissionMode } = {},
): Promise<TransitionResult> {
  const catalog = await getLaunchProfileCatalog();
  const profile = catalog.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) return refused(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
  const runtime = getRuntimeDriver(profile.runtimeId ?? getRuntimeDriverForProvider(profile.provider).runtimeId);
  if (!runtime || runtime.provider !== profile.provider) return refused(409, 'runtime_unrecognized', t('session.transition.runtimeUnrecognized'));
  const snapshot = await snapshotWithMode(session.id, runtime, profile, options.permissionMode);
  if (!snapshot.ok) return snapshot.result;
  const result = await exitAndRelaunch(session, { runtime, launchProfile: snapshot.snapshot }, options);
  return result.ok
    ? { ...result, permissionMode: snapshot.snapshot.permissionMode ?? 'cli_default', ...(snapshot.fallbackFrom ? { permissionFallbackFrom: snapshot.fallbackFrom } : {}) }
    : result;
}

async function exitAndRelaunch(
  session: ManagedSession,
  target: { runtime: NonNullable<ReturnType<typeof getRuntimeDriver>>; launchProfile: LaunchProfileSnapshot } | null,
  options: { force?: boolean; expectedConversationId?: string } = {},
): Promise<TransitionResult> {
  if (options.expectedConversationId !== undefined && session.activeConversationId !== options.expectedConversationId) {
    return refused(409, 'clear_state_changed', t('session.transition.handoffSourceChanged'));
  }
  const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
  const profile = conversation?.launchProfile;
  const runtime = conversation ? recordedRuntime(session, conversation) : undefined;
  if (!conversation || !profile || profile.provider !== session.provider || !runtime || runtime.provider !== session.provider) {
    return refused(409, 'clear_profile_missing', t('session.transition.clearProfileMissing'));
  }
  if (runtime.buildExitPlan().status !== 'supported') {
    return refused(409, 'clear_exit_unverified', t('session.transition.clearExitUnverified'));
  }
  // The turn phase is read here, before the claim moves the session to launching.
  const replyPhase = activeTurnPhase(session);
  // A reply that can't be interrupted safely is waited out, unless the user
  // chose to force it: then the pane is reset instead (forcePendingExit's
  // way), ending the CLI and its reply without any key sent to it.
  const forced = !canRequestExit(runtime, replyPhase);
  if (forced && !options.force) {
    return refused(409, 'clear_interrupt_unverified', t('session.transition.clearInterruptUnverified'));
  }
  // Nothing to exit, and nowhere to launch, once the tmux itself is gone.
  if (await endIfTmuxGone(session)) return refused(409, 'session_dead', 'session is dead');
  const launched = target ?? { runtime, launchProfile: profile };
  const command = buildLaunchCommand(launched.runtime, launched.launchProfile, session.cwd, { kind: 'fresh' });
  if (!command) return refused(409, 'clear_config_incomplete', t('session.transition.clearConfigIncomplete'));
  // A handoff starts another profile's CLI: check it is there before the
  // running one is asked to exit. /clear restarts the CLI already running.
  if (target) {
    const missing = await refuseMissingCommand(target.launchProfile.delegate.executable, session);
    if (missing) return missing;
  }
  const attemptId = randomUUID();
  const pending = await registry.beginPendingClear(session.id, {
    attemptId,
    // Rechecked against current state by beginPendingClear after every await.
    conversationId: options.expectedConversationId ?? conversation.id,
    provider: launched.runtime.provider,
    runtimeId: launched.runtime.runtimeId,
    newProviderSessionId: command.providerSessionId,
    launchArgv: command.argv,
    startedAt: new Date().toISOString(),
    previousStatus: session.status,
    previousTurnPhase: session.turnPhase,
    phase: 'waiting_exit',
    delivery: 'exit_uncertain',
    launchStartedAt: null,
    ...(target ? { exitProvider: session.provider!, launchProfile: target.launchProfile } : {}),
  });
  if (!pending) return refused(409, 'clear_state_changed', t('session.transition.clearStateChanged'));
  let delivered: Awaited<ReturnType<typeof registry.notePendingClearDelivery>>;
  try {
    // Interrupts an in-flight reply first (a Codex C-c mid-turn would only
    // interrupt it and leave the CLI running).
    if (forced) await tmuxCli.respawnPane(session.tmuxName, session.cwd);
    else await requestRuntimeExit(session.tmuxName, runtime, replyPhase);
    delivered = await registry.notePendingClearDelivery(session.id, attemptId, 'confirmed');
  } catch {
    await registry.notePendingClearDelivery(session.id, attemptId, 'exit_uncertain', t('session.transition.clearExitDeliveryUncertain'));
    registry.releaseClearAttempt(session.id, attemptId);
    return refused(503, 'clear_exit_delivery_uncertain', t('session.transition.clearExitDeliveryUncertain'));
  }
  registry.releaseClearAttempt(session.id, attemptId);
  // The old CLI is on its way out: its turn is over.
  const confirmed = delivered ?? pending;
  const left = await applyRuntimeLeftReady(confirmed);
  return accepted(left ?? confirmed);
}

// Resume only the exact active conversation attached to this dead managed
// tmux, and only for a runtime that resumes in place (runtimes/resume.ts).
// The request carries no provider id, executable, profile, or path: those
// are private registry snapshots.
export async function recoverDeadSession(sessionId: string, deps: ResumeDeps = {}): Promise<TransitionResult> {
  const session = await registry.getSession(sessionId);
  if (!session) return refused(404, 'not_found', 'not found');
  const recovery = deadSessionRecovery(session);
  if (!recovery.ok) {
    return recovery.blocked === 'session'
      ? refused(409, 'not_recoverable', 'this session is not an eligible dead session to recover')
      : refused(409, 'recovery_record_incomplete', t('session.transition.recoveryRecordIncomplete'));
  }
  const { conversation, runtime } = recovery;
  if (!(await directoryExists(session.cwd))) return refused(409, 'recovery_cwd_missing', t('session.transition.cwdMissing'));
  const resumable = await verifyResumable(conversation, session.cwd);
  if (!resumable.ok) return refused(409, resumable.code, resumable.error);
  const limited = await accountLimitRefusal(conversation, deps);
  if (limited) return limited;
  const { argv } = resumable;
  await recordMovedTranscript(session, conversation, resumable.movedTo);

  // An existing same-name tmux is safe only when it is still the expected
  // working directory and the pane is demonstrably back at a shell. A live
  // provider, unknown process, or conflicting cwd must not get a second CLI.
  const exists = await tmuxCli.sessionExists(session.tmuxName);
  if (exists) {
    const [liveness, panePath] = await Promise.all([
      tmuxCli.getPaneLiveness(session.tmuxName, runtime.processIdentity),
      tmuxCli.getPaneCurrentPath(session.tmuxName),
    ]);
    if (liveness !== 'dead' || !panePath || path.resolve(panePath) !== path.resolve(session.cwd)) {
      return refused(409, 'recovery_tmux_conflict', t('session.transition.recoveryTmuxConflict'));
    }
  }

  const attemptId = randomUUID();
  const pending = await registry.beginPendingResume(session.id, { attemptId, conversationId: conversation.id, startedAt: new Date().toISOString() });
  if (!pending) return refused(409, 'recovery_state_changed', t('session.transition.recoveryStateChanged'));

  try {
    if (!exists) {
      try { await reopenTmux(session); }
      catch {
        await registry.rollbackPendingResume(session.id, attemptId, t('session.transition.tmuxRebuildFailed'));
        return refused(409, 'recovery_tmux_failed', t('session.transition.recoveryTmuxFailed'));
      }
    }
    const [safeLiveness, safePanePath] = await Promise.all([
      tmuxCli.getPaneLiveness(session.tmuxName, runtime.processIdentity),
      tmuxCli.getPaneCurrentPath(session.tmuxName),
    ]);
    if (safeLiveness !== 'dead' || !safePanePath || path.resolve(safePanePath) !== path.resolve(session.cwd)) {
      await registry.rollbackPendingResume(session.id, attemptId, t('session.transition.recoveryTmuxChangedCancelled'));
      return refused(409, 'recovery_tmux_changed', t('session.transition.recoveryTmuxChanged'));
    }
    try {
      await tmuxCli.sendCommandLine(session.tmuxName, argv);
    } catch {
      // Delivery may have succeeded even if the tmux command failed to report
      // completion. Leave the durable claim in place; polling can inspect but
      // must never send this command a second time.
      return refused(503, 'recovery_unconfirmed', t('session.transition.recoveryUnconfirmed'));
    }
    // Dispatched once; the poller confirms startup under the shared rule.
    return accepted((await registry.getSession(session.id)) ?? pending);
  } finally {
    registry.releaseResumeAttempt(session.id, attemptId);
  }
}

// Continue an earlier conversation in this same tmux (one whose runtime
// resumes in place: conversationResumeBlocked). Only one CLI
// ever runs per tmux: a running one is asked to exit first through its
// runtime's verified exit (interrupting an in-flight reply before that), and
// if it won't — or its runtime has no verified exit — the user is asked
// before anything is forced (forceConversationSwitch). The actual launch
// and its confirmation happen in polling, on the same claim as a /clear, so
// the resume command is never sent twice.
export async function switchConversation(sessionId: string, conversationId: string, deps: ResumeDeps = {}): Promise<TransitionResult> {
  const session = await registry.getSession(sessionId);
  if (!session) return refused(404, 'not_found', 'not found');
  if (session.status === 'launching' || session.launchPending || session.resumePending || session.clearPending) {
    return refused(409, 'transition_in_progress', t('session.transition.inProgress'));
  }
  const target = session.conversations?.find((conversation) => conversation.id === conversationId);
  if (!target) return refused(404, 'conversation_not_found', 'not found');
  const blocked = conversationResumeBlocked(target);
  if (blocked) return refused(409, blocked.code, blocked.message, blocked.params);
  if (target.id === session.activeConversationId && !target.endedAt && session.status !== 'dead') {
    return refused(409, 'conversation_running', t('session.transition.conversationRunning'));
  }
  const resumable = await verifyResumable(target, session.cwd);
  if (!resumable.ok) return refused(409, resumable.code, resumable.error);
  const limited = await accountLimitRefusal(target, deps);
  if (limited) return limited;

  // What's in the pane right now decides how the exit starts. A shell back
  // in the session's own cwd needs no exit at all; a running CLI whose
  // runtime has a verified exit is asked to leave that way; anything else
  // (an unknown process, a shell somewhere else) goes straight to asking
  // the user.
  const exists = await tmuxCli.sessionExists(session.tmuxName);
  if (!exists && !(await directoryExists(session.cwd))) return refused(409, 'recovery_cwd_missing', t('session.transition.cwdMissing'));
  const exitProvider = session.provider ?? 'claude';
  const leaving = session.conversations?.find((conversation) => conversation.id === session.activeConversationId && !conversation.endedAt);
  const running = session.provider ? recordedRuntime(session, leaving) : undefined;
  const replyPhase = activeTurnPhase(session);
  let phase: 'waiting_exit' | 'awaiting_force' = 'waiting_exit';
  let sendExit = false;
  if (exists) {
    const [liveness, panePath] = await Promise.all([
      // Without a known runtime only a plain shell can be recognized.
      tmuxCli.getPaneLiveness(session.tmuxName, running?.processIdentity ?? { commands: [], wrappers: [] }),
      tmuxCli.getPaneCurrentPath(session.tmuxName),
    ]);
    if (liveness === 'alive' && running && canRequestExit(running, replyPhase)) sendExit = true;
    else if (liveness !== 'dead' || !panePath || path.resolve(panePath) !== path.resolve(session.cwd)) phase = 'awaiting_force';
  }
  await recordMovedTranscript(session, target, resumable.movedTo);
  const attemptId = randomUUID();
  const now = new Date().toISOString();
  const pending = await registry.beginConversationSwitch(session.id, {
    attemptId,
    conversationId: leaving?.id ?? null,
    targetConversationId: target.id,
    newProviderSessionId: target.providerSessionId!,
    launchArgv: resumable.argv,
    startedAt: now,
    previousStatus: session.status,
    previousTurnPhase: session.turnPhase,
    phase,
    launchStartedAt: null,
    exitProvider,
    exitRequestedAt: now,
  });
  if (!pending) return refused(409, 'switch_state_changed', t('session.transition.switchStateChanged'));

  try {
    // Whatever CLI was running is on its way out: its turn is over.
    await applyRuntimeLeftReady(pending);
    if (!exists) {
      try { await reopenTmux(session); }
      catch {
        await registry.failPendingClear(session.id, attemptId, t('session.transition.tmuxRebuildFailed'), { exited: false, tmuxMissing: true });
        return refused(409, 'switch_tmux_failed', t('session.transition.tmuxRebuildFailed'));
      }
    }
    if (sendExit && running) {
      try {
        // Interrupts an in-flight reply first with the runtime's verified key.
        await requestRuntimeExit(session.tmuxName, running, replyPhase);
      } catch {
        await registry.failPendingClear(session.id, attemptId, t('session.transition.switchExitDeliveryUncertain'), { exited: false });
        return refused(503, 'switch_exit_delivery_uncertain', t('session.transition.switchExitDeliveryUncertain'));
      }
    }
    return accepted((await registry.getSession(session.id)) ?? pending);
  } finally {
    registry.releaseClearAttempt(session.id, attemptId);
  }
}

// A switch and a /clear share one pending record; a switch has a target.
type PendingExitKind = 'switch' | 'clear';
const isKind = (attempt: ManagedSession['clearPending'], kind: PendingExitKind) =>
  !!attempt && (kind === 'switch') === !!attempt.targetConversationId;
const PENDING_EXIT_REFUSALS = {
  switch: {
    notAwaiting: { code: 'no_switch_awaiting_force', message: 'session.transition.noSwitchAwaitingForce' },
    changed: { code: 'switch_changed', message: 'session.transition.switchChanged' },
    nothingToCancel: { code: 'no_switch_to_cancel', message: 'session.transition.noSwitchToCancel' },
  },
  clear: {
    notAwaiting: { code: 'no_clear_awaiting_force', message: 'session.transition.noClearAwaitingForce' },
    changed: { code: 'clear_changed', message: 'session.transition.clearChanged' },
    nothingToCancel: { code: 'no_clear_to_cancel', message: 'session.transition.noClearToCancel' },
  },
} as const;

// The user agreed to force-close a CLI that wouldn't exit: reset the pane
// to a fresh shell (the tmux itself and every transcript stay), then let
// polling launch the resume or the new conversation exactly as after a
// normal exit.
async function forcePendingExit(sessionId: string, kind: PendingExitKind): Promise<TransitionResult> {
  const refusals = PENDING_EXIT_REFUSALS[kind];
  const session = await registry.getSession(sessionId);
  if (!session) return refused(404, 'not_found', 'not found');
  const attempt = session.clearPending;
  if (!attempt || !isKind(attempt, kind) || attempt.phase !== 'awaiting_force') return refused(409, refusals.notAwaiting.code, t(refusals.notAwaiting.message));
  try {
    await tmuxCli.respawnPane(session.tmuxName, session.cwd);
  } catch {
    return refused(503, 'pane_reset_failed', t('session.transition.paneResetFailed'));
  }
  const updated = await registry.setPendingExitPhase(session.id, attempt.attemptId, 'awaiting_force', 'waiting_exit');
  if (!updated) return refused(409, refusals.changed.code, t(refusals.changed.message));
  return accepted(updated, 200);
}

// Declined the force prompt: drop the switch or the /clear and leave the
// running CLI as it is. Only before the new command has been sent.
async function cancelPendingExit(sessionId: string, kind: PendingExitKind): Promise<TransitionResult> {
  const session = await registry.getSession(sessionId);
  if (!session) return refused(404, 'not_found', 'not found');
  const attempt = session.clearPending;
  if (!attempt || !isKind(attempt, kind) || attempt.phase === 'launching') return refused(409, PENDING_EXIT_REFUSALS[kind].nothingToCancel.code, t(PENDING_EXIT_REFUSALS[kind].nothingToCancel.message));
  return accepted(await registry.failPendingClear(session.id, attempt.attemptId, null, { exited: false }), 200);
}

export const forceConversationSwitch = (sessionId: string) => forcePendingExit(sessionId, 'switch');
export const cancelConversationSwitch = (sessionId: string) => cancelPendingExit(sessionId, 'switch');
export const forceClear = (sessionId: string) => forcePendingExit(sessionId, 'clear');
export const cancelClear = (sessionId: string) => cancelPendingExit(sessionId, 'clear');
