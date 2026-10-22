import { randomUUID } from 'node:crypto';
import { projectsForDirectory } from '../cli/projectMatch.js';
import * as projectStore from '../project-store.js';
import * as registry from '../registry.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import { beginClosing, endClosing } from '../sync/closing.js';
import { canRequestExit, requestRuntimeExit } from '../sync/exit.js';
import { applyRuntimeLeftReady } from '../sync/turnEffects.js';
import * as tmuxCli from '../tmux.js';
import { recordSessionEvent } from '../session-events.js';
import { activeTurnPhase, type ManagedSession } from '../types.js';

// A managed session's life outside the registry: its tmux, and what its
// project learns from it. The registry only records; this is where a
// session is opened, closed, deleted and checked against tmux.

/**
 * Opens a tmux in `cwd`, then records it as a managed session of the
 * project. `id`: one chosen beforehand (a delegation saves it before the
 * session exists, to find it again after a restart); `env`: variables set
 * on the tmux session (tmux.ts newSession); `forkOrigin`: a branch line's,
 * where it was forked from; `delegationOrigin`: a delegate's, the delegation
 * it works on.
 */
export async function createSession(
  cwd: string, projectId: string, options: {
    id?: string; env?: Record<string, string>; rememberPath?: boolean;
    forkOrigin?: ManagedSession['forkOrigin']; delegationOrigin?: ManagedSession['delegationOrigin'];
  } = {},
): Promise<ManagedSession> {
  const id = options.id ?? randomUUID();
  const sessionNumber = await projectStore.reserveSessionNumber(projectId);
  if (sessionNumber === undefined) throw new Error('project not found');
  // The tmux first: a failure leaves no record of a session that never ran.
  await tmuxCli.newSession(registry.tmuxNameFor(id), cwd, options.env);
  const created = await registry.createSession(cwd, projectId, sessionNumber, id);
  const origins: Partial<ManagedSession> = {
    ...(options.forkOrigin ? { forkOrigin: { ...options.forkOrigin } } : {}),
    ...(options.delegationOrigin ? { delegationOrigin: { ...options.delegationOrigin } } : {}),
  };
  const session = Object.keys(origins).length ? (await registry.updateSession(id, origins)) ?? created : created;
  // The project remembers where its tmux sessions are opened — unless it's
  // already within one of its paths (a subfolder isn't a new place), or the
  // place is a delegation's or a branch line's own worktree (`rememberPath`
  // false), which belongs to it only while it exists (spawn/roots.ts).
  if (options.rememberPath === false) return session;
  const project = await projectStore.getProject(projectId);
  if (!project || projectsForDirectory([project], cwd).length === 0) await projectStore.addProjectPath(projectId, cwd);
  return session;
}

/**
 * The app's delete: ends the session's tmux (whatever runs in it), lets
 * the reconcile end the turn its CLI was in like any tmux that died, then
 * moves the record to its project's trash (registry.trashSession), from
 * where it can be restored. An unknown or already-trashed id is a no-op
 * (false).
 */
export async function removeSession(id: string): Promise<boolean> {
  const session = await registry.getSession(id);
  if (!session) return false;
  await tmuxCli.killSession(session.tmuxName);
  await reconcileWithTmux({ endedByApp: id });
  await registry.trashSession(id);
  return true;
}

// How long a CLI gets to exit on its own before the close gives up and asks
// whether to force it. Claude Code runs its SessionEnd hooks on the way
// out (up to their own timeouts, 10s for the diary hook here).
const CLOSE_EXIT_TIMEOUT_MS = 20_000;
const CLOSE_EXIT_POLL_MS = 500;

export type CloseResult =
  | { status: 'closed'; session: ManagedSession }
  | { status: 'not_found' }
  // Another launch, restart or switch is in progress, or another close.
  | { status: 'in_transition' }
  // The CLI is replying and has no verified way to be interrupted first.
  | { status: 'cli_busy' }
  // Asked to exit, it didn't within CLOSE_EXIT_TIMEOUT_MS.
  | { status: 'exit_unverified' };

/**
 * The app's "關閉此 tmux": asks the CLI running in it to exit through its
 * runtime's verified exit (interrupting a reply first where that's
 * verified), so it can finish on its own terms — hooks, last writes — then
 * ends the tmux. `force` skips the exit and ends the tmux as it is.
 * Unlike removeSession the record stays live, as a tmux that died leaves it:
 * listed as ended, its conversations kept, and resumable where the runtime
 * can resume.
 */
export async function closeSession(id: string, options: { force?: boolean } = {}): Promise<CloseResult> {
  const session = await registry.getSession(id);
  if (!session) return { status: 'not_found' };
  if (session.clearPending || session.launchPending || session.resumePending) return { status: 'in_transition' };
  if (!beginClosing(id)) return { status: 'in_transition' };
  try {
    if (!options.force && session.status !== 'dead') {
      const exited = await exitRunningCli(session);
      if (exited !== 'exited') return { status: exited };
    }
    await tmuxCli.killSession(session.tmuxName);
    await reconcileWithTmux({ endedByApp: id });
    const closed = await registry.getSession(id);
    return closed ? { status: 'closed', session: closed } : { status: 'not_found' };
  } finally {
    endClosing(id);
  }
}

async function exitRunningCli(session: ManagedSession): Promise<'exited' | 'cli_busy' | 'exit_unverified'> {
  const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
  const runtime = session.provider ? recordedRuntime(session, conversation) : undefined;
  // No CLI of ours in it (never launched, already gone, or its whole tmux
  // gone): nothing to ask.
  if (!runtime || await cliGone(session, runtime)) return 'exited';
  // Still at its start-up prompt, no conversation has begun, and an exit's
  // Enter would answer the prompt (Codex's starts on "Trust"): nothing to
  // finish, so the tmux just ends.
  if (session.startupPrompt) return 'exited';
  const phase = activeTurnPhase(session);
  if (!canRequestExit(runtime, phase)) return 'cli_busy';
  try {
    await requestRuntimeExit(session.tmuxName, runtime, phase);
  } catch {
    return 'exit_unverified';
  }
  for (let waited = 0; waited < CLOSE_EXIT_TIMEOUT_MS; waited += CLOSE_EXIT_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, CLOSE_EXIT_POLL_MS));
    if (await cliGone(session, runtime)) return 'exited';
  }
  return 'exit_unverified';
}

/**
 * Whether the CLI in this tmux is gone: its pane is back at a shell, or the
 * tmux itself no longer exists (killed outside the app, its server gone).
 * A pane that can't be read counts as gone only once tmux confirms the
 * session is missing; any other doubt keeps the CLI counted as running.
 */
async function cliGone(session: ManagedSession, runtime: NonNullable<ReturnType<typeof recordedRuntime>>): Promise<boolean> {
  const liveness = await tmuxCli.getPaneLiveness(session.tmuxName, runtime.processIdentity);
  if (liveness !== 'unknown') return liveness === 'dead';
  return await tmuxCli.sessionPresence(session.tmuxName) === 'gone';
}

/**
 * The check before anything is sent to a session's tmux: when tmux confirms
 * it no longer exists, the session is reconciled (marked dead, its turn
 * ended) and true is returned, so the caller refuses instead of typing
 * into nothing.
 */
export async function endIfTmuxGone(session: ManagedSession): Promise<boolean> {
  if (await tmuxCli.sessionPresence(session.tmuxName) !== 'gone') return false;
  await reconcileWithTmux();
  return true;
}

/**
 * Cross-checks the registry against what tmux actually has running: a
 * session whose tmux is gone is marked dead, and the turn its CLI was in
 * ends with it. Returns those sessions. Each one is logged as found gone
 * (session-events.ts), except `endedByApp`: the app just ended that tmux
 * itself and logs it as its own close or delete.
 */
export async function reconcileWithTmux(options: { endedByApp?: string } = {}): Promise<ManagedSession[]> {
  const recorded = new Set((await registry.listSessions()).map((session) => session.tmuxName));
  let listed: string[];
  try {
    listed = await tmuxCli.listManagedSessionNames(recorded);
  } catch (err) {
    // tmux couldn't say what is running; that is no reason to end anything.
    console.error('[sessions] tmux session list failed; nothing reconciled', err);
    return [];
  }
  const running = new Set(listed);
  const died = await registry.markDeadUnlessRunning(running);
  for (const session of died) await applyRuntimeLeftReady(session);
  const unexplained = died.filter((session) => session.id !== options.endedByApp);
  if (unexplained.length > 0) {
    // Whether the whole server went (a reboot, a kill-server) or only these sessions.
    const serverRunning = await tmuxCli.serverRunning();
    for (const session of unexplained) {
      await recordSessionEvent({ sessionId: session.id, action: 'tmux_gone', result: 'dead', source: 'reconcile', detail: { tmuxName: session.tmuxName, serverRunning } });
    }
  }
  return died;
}
