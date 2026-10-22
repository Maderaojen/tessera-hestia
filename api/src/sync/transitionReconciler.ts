import { RUNTIME_EXIT_TIMEOUT_MS } from '../config.js';
import * as registry from '../registry.js';
import { getRuntimeDriver } from '../runtimes/index.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import { runtimeForProvider } from '../runtimes/types.js';
import * as tmuxCli from '../tmux.js';
import type { ManagedSession } from '../types.js';
import { activeConversation } from './binding.js';
import { settleResumedIdentity } from './resumeIdentity.js';
import { forgetStartupObservation, judgeStartup } from './startup.js';
import { t } from '../i18n/index.js';

// The poller's half of every CLI transition the transition service
// (services/transitions.ts) starts: observing the pane until the claim can
// be committed or failed. A transition is confirmed here, never in the
// request that sent it, and survives API restarts
// (docs/decisions/0010-runtime-transition-convergence.md). While the request that
// claimed an attempt still owns it in this process, it is left alone.

/**
 * A /clear or conversation switch: exit the old CLI first; only an observed
 * shell permits the new launch, sent once. A durable 'launching' phase is
 * never replayed after a process restart.
 */
export async function reconcileClear(session: ManagedSession): Promise<void> {
  const attempt = session.clearPending;
  if (!attempt || registry.ownsClearAttemptLocally(session.id, attempt.attemptId)) return;
  if (!(await tmuxCli.sessionExists(session.tmuxName))) {
    forgetStartupObservation(session.id);
    await registry.failPendingClear(
      session.id,
      attempt.attemptId,
      attempt.targetConversationId
        ? t('session.sync.tmuxEndedSwitch')
        : t('session.sync.tmuxEndedClear'),
      { exited: false, tmuxMissing: true },
    );
    return;
  }
  // Once launching, the CLI to recognize is the one being started: for a
  // switch the target conversation's runtime (the session is still bound
  // to the CLI that just exited until the switch commits), for a /clear
  // the runtime the attempt recorded.
  if (attempt.phase === 'launching') {
    const target = attempt.targetConversationId
      ? session.conversations?.find((conversation) => conversation.id === attempt.targetConversationId)
      : undefined;
    const launched = target
      ? recordedRuntime(session, target)
      : getRuntimeDriver(attempt.runtimeId ?? runtimeForProvider(attempt.provider ?? session.provider ?? 'claude'));
    if (!launched || (!target && launched.provider !== (attempt.provider ?? session.provider ?? 'claude'))) return;
    const liveness = await tmuxCli.getPaneLiveness(session.tmuxName, launched.processIdentity);
    await judgeRelaunch(session, attempt, liveness, target ? { runtime: launched, conversation: target } : null);
    return;
  }
  // Before launching, "dead" means the CLI being left has exited — which
  // for a switch may not be the one it switches to. That is the runtime
  // still bound to the session (a CLI that already exited has none; only a
  // shell is recognized then).
  const exitingProvider = attempt.exitProvider ?? attempt.provider ?? session.provider ?? 'claude';
  const observedRuntime = recordedRuntime(session, activeConversation(session));
  if (observedRuntime && observedRuntime.provider !== exitingProvider) return;
  const liveness = await tmuxCli.getPaneLiveness(session.tmuxName, observedRuntime?.processIdentity ?? { commands: [], wrappers: [] });
  forgetStartupObservation(session.id);
  if (liveness !== 'dead') {
    // Never wait silently on an exit that isn't happening, and never
    // re-send it. Past the timeout a switch or a /clear hands the decision
    // to the user: force-reset the pane, or cancel. (e.g. Codex 0.157.1
    // only interrupts on C-c while it works — a background subagent the
    // app took for idle — and stays running.)
    const requestedAt = Date.parse(attempt.exitRequestedAt ?? attempt.startedAt);
    const overdue = !Number.isFinite(requestedAt) || Date.now() - requestedAt >= RUNTIME_EXIT_TIMEOUT_MS;
    if (overdue && attempt.phase === 'waiting_exit') {
      await registry.setPendingExitPhase(session.id, attempt.attemptId, 'waiting_exit', 'awaiting_force');
    }
    return;
  }
  const launching = await registry.beginPendingClearLaunch(session.id, attempt.attemptId);
  const launchAttempt = launching?.clearPending;
  if (!launchAttempt) return;
  try {
    await tmuxCli.sendCommandLine(session.tmuxName, launchAttempt.launchArgv);
    await registry.notePendingClearDelivery(session.id, attempt.attemptId, 'confirmed');
  } catch (err) {
    // The send could have reached tmux before the error surfaced. Keep
    // the claim and observe only; sending it again could start a twin.
    console.error(`[polling] clear launch delivery uncertain for session ${session.id}`, err);
    await registry.notePendingClearDelivery(session.id, attempt.attemptId, 'launch_uncertain', t('session.sync.newCliResultUnconfirmed'));
  } finally {
    registry.releaseClearAttempt(session.id, attempt.attemptId);
  }
}

// The relaunch after a /clear or switch was sent: commit it once the new
// CLI is confirmed (for a switch, holding the very conversation it
// resumes), fail it once it has positively not started.
async function judgeRelaunch(
  session: ManagedSession,
  attempt: NonNullable<ManagedSession['clearPending']>,
  liveness: Awaited<ReturnType<typeof tmuxCli.getPaneLiveness>>,
  resumed: { runtime: NonNullable<ReturnType<typeof recordedRuntime>>; conversation: NonNullable<ManagedSession['conversations']>[number] } | null,
): Promise<void> {
  const startup = judgeStartup(session.id, `clear:${attempt.attemptId}`, liveness, attempt.launchStartedAt);
  if (startup.verdict === 'confirmed') {
    const identity = resumed
      ? await settleResumedIdentity({ session, ...resumed, dispatchedAt: attempt.launchStartedAt })
      : { verdict: 'confirmed' as const };
    if (identity.verdict === 'confirmed') await registry.commitPendingClear(session.id, attempt.attemptId);
    else if (identity.verdict === 'failed') await registry.failPendingClear(session.id, attempt.attemptId, identity.message, { exited: true });
    else if (identity.message && session.lastError !== identity.message) await registry.updateSession(session.id, { lastError: identity.message });
  } else if (startup.verdict === 'failed') {
    await registry.failPendingClear(session.id, attempt.attemptId, t('session.sync.newCliFailed'), { exited: true });
  } else if (startup.reason !== 'grace') {
    const message = startup.reason === 'unknown'
      ? t('session.sync.newCliStateUnknown')
      : t('session.sync.newCliUnconfirmed');
    if (session.lastError !== message) await registry.updateSession(session.id, { lastError: message });
  }
}

/**
 * An explicit resume of a dead tmux's conversation. Its command is never replayed
 * after a process restart. Resolved only from observed tmux/provider
 * liveness; unknown stays claimed so a user cannot accidentally launch a
 * duplicate CLI.
 */
export async function reconcileResume(session: ManagedSession): Promise<void> {
  const attempt = session.resumePending;
  if (!attempt) return;
  // The request that claimed the attempt still owns the pre-dispatch and
  // liveness window. A polling tick must not clear its reservation while it
  // is creating the same-name tmux or sending the single resume command.
  // This owner set is process-local, so an API restart safely falls through
  // to durable liveness reconciliation below.
  if (registry.ownsResumeAttemptLocally(session.id, attempt.attemptId)) return;
  if (!(await tmuxCli.sessionExists(session.tmuxName))) {
    forgetStartupObservation(session.id);
    await registry.rollbackPendingResume(session.id, attempt.attemptId, t('session.sync.tmuxNotRecovered'));
    return;
  }
  // The CLI being resumed is the claimed conversation's runtime. The claim
  // required one that resumes; without it nothing can be recognized, and
  // the attempt stays claimed rather than guessing.
  const conversation = session.conversations?.find((item) => item.id === attempt.conversationId);
  const runtime = conversation && recordedRuntime(session, conversation);
  if (!runtime) return;
  const liveness = await tmuxCli.getPaneLiveness(session.tmuxName, runtime.processIdentity);
  // The claim is taken just before the resume command is sent.
  const startup = judgeStartup(session.id, `resume:${attempt.attemptId}`, liveness, attempt.startedAt);
  if (startup.verdict === 'confirmed') {
    // Only once the CLI holds this very conversation (sync/resumeIdentity.ts).
    const identity = await settleResumedIdentity({ session, runtime, conversation: conversation!, dispatchedAt: attempt.startedAt });
    if (identity.verdict === 'confirmed') await registry.commitPendingResume(session.id, attempt.attemptId);
    else if (identity.verdict === 'failed') await registry.rollbackPendingResume(session.id, attempt.attemptId, identity.message);
    else if (identity.message && session.lastError !== identity.message) await registry.updateSession(session.id, { lastError: identity.message });
  } else if (startup.verdict === 'failed') await registry.rollbackPendingResume(session.id, attempt.attemptId, t('session.sync.cliNotRecovered'));
}

/**
 * A fresh launch. Resolved only through an affirmative process check;
 * unknown remains pending and cannot create a conversation or import any
 * transcript.
 */
export async function reconcileLaunch(session: ManagedSession): Promise<void> {
  if (session.status !== 'launching' || !session.launchPending) return;
  const attemptAt = session.launchPending.providerLaunchedAt;
  // Claim before observing: cancellation must not reset the pane between a
  // positive observation and its commit, and an old poll snapshot must not
  // observe or roll back a subsequent launch.
  const claimed = await registry.claimPendingLaunch(session.id, attemptAt);
  if (!claimed) return;
  try {
    const attempt = claimed.launchPending!;
    const runtime = getRuntimeDriver(attempt.runtimeId ?? attempt.launchProfile.runtimeId ?? runtimeForProvider(attempt.provider));
    if (!runtime || runtime.provider !== attempt.provider) return;
    const liveness = await tmuxCli.getPaneLiveness(claimed.tmuxName, runtime.processIdentity);
    // providerLaunchedAt is stamped immediately before the command is sent.
    const startup = judgeStartup(session.id, `launch:${attemptAt}`, liveness, attemptAt);
    if (startup.verdict === 'confirmed') {
      await registry.commitConversationLaunch(session.id, {
        provider: attempt.provider,
        runtimeId: attempt.runtimeId,
        providerSessionId: attempt.providerSessionId,
        providerLaunchedAt: attemptAt,
        launchProfile: attempt.launchProfile,
      }, attemptAt);
    } else if (startup.verdict === 'failed') {
      await registry.rollbackPendingLaunch(session.id, t('session.sync.launchEnded'), attemptAt);
    }
  } finally {
    registry.releaseLaunchAttempt(session.id, attemptAt);
  }
}
