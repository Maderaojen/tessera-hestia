import path from 'node:path';
import type { ErrorCode } from '../contract/errors.js';
import { newLaunchGuard } from '../contract/launch-guard.js';
import { FORK_MESSAGES, type CloseForkRequest, type Fork, type ForkCloseOutcome, type ForkPreview, type StartForkRequest } from '../contract/fork.js';
import type { JsonFileStore } from '@maderaojen/json-file-store';
import { t, type MessageKey } from '../i18n/index.js';
import { branchName } from '../spawn/naming.js';
import { advanceSpawn, newStartup, type SpawnAttention, type StepOutcome } from '../spawn/startup.js';
import { formatForkBrief } from './brief.js';
import { chooseMemory, forkTitle, gateForkQuota, type ForkRefusal } from './policy.js';
import type { ForkPorts } from './ports.js';

export type { ForkPorts } from './ports.js';

// Branch lines. Knows nothing of tmux, git or the registry:
// everything goes through ForkPorts (wired up in wiring.ts), and all it
// keeps is one JSON file, so a restart (every deploy) picks up where it
// was. A branch line has no flow of its own (決策 5): its start is
// spawn/startup.ts's, and the rest is a record of where it came from.

// A branch line still starting moves one step this often.
export const FORK_TICK_MS = 5_000;

export type ForkState = { version: 1; forks: Record<string, Fork> };

export function emptyForkState(): ForkState {
  return { version: 1, forks: {} };
}

/** Whatever is on disk, made the current shape; anything unreadable is dropped. */
export function decodeForkState(raw: unknown): ForkState {
  const state = emptyForkState();
  if (!raw || typeof raw !== 'object') return state;
  for (const [id, fork] of Object.entries((raw as Partial<ForkState>).forks ?? {})) {
    if (!fork || typeof fork !== 'object' || typeof fork.id !== 'string' || !fork.origin || !fork.workspace) continue;
    state.forks[id] = fork;
  }
  return state;
}

export type ForkResult = { ok: true; fork: Fork } | ForkRefusal;
export type PreviewResult = { ok: true; preview: ForkPreview } | ForkRefusal;
export type CloseResult = { ok: true; fork: Fork; outcome: ForkCloseOutcome } | ForkRefusal;

export type ForkEngine = {
  start(): void;
  stop(): void;
  // Moves every branch line still starting one step on, and notices one
  // whose session is gone.
  advance(): Promise<void>;
  list(filter: { sessionId?: string; open?: boolean }): Promise<Fork[]>;
  get(id: string): Promise<Fork | null>;
  preview(parentSessionId: string, profileId?: string): Promise<PreviewResult>;
  startFork(request: StartForkRequest): Promise<ForkResult>;
  close(id: string, request: CloseForkRequest): Promise<CloseResult>;
  // Its CLI is gone (a failed launch, or a CLI that quit): started again in
  // its tmux with the same profile, and its brief sent again (ADR 0030).
  relaunch(id: string): Promise<ForkResult>;
};

const refuse = (status: ForkRefusal['status'], code: ErrorCode, message: string, params?: Record<string, string>): ForkRefusal => (
  { ok: false, status, code, message, ...(params ? { params } : {}) }
);

/** The brief: in the branch line's cwd, under .hestia/forks/<id>/. */
export function briefFileOf(cwd: string, id: string): string {
  return path.join(cwd, '.hestia', 'forks', id, 'brief.md');
}

export function briefMessage(fork: Pick<Fork, 'briefFile' | 'instruction'>): string {
  return FORK_MESSAGES.brief(fork.briefFile, !!fork.instruction?.trim());
}

// What the user is told about a start that needs them, by reason.
const ISSUE_TEXT: Record<string, MessageKey> = {
  cli_exited: 'fork.attention.cliExited',
  workspace_trust: 'fork.attention.workspaceTrust',
  startup_prompt: 'fork.attention.startupPrompt',
  brief_not_delivered: 'fork.attention.briefNotDelivered',
};
const issueText = (reason: string) => (ISSUE_TEXT[reason] ? t(ISSUE_TEXT[reason]) : reason);

// The preview's worktree, before an id is chosen.
const UNCHOSEN_ID = '…';

export function createForkEngine(ports: ForkPorts, store: JsonFileStore<ForkState>): ForkEngine {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Steps and API actions all read-modify-write one file; one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const notify = (fork: Fork, body: string) => {
    void ports.notify(structuredClone(fork), body).catch((err: unknown) => console.warn('[fork] notify failed', err));
  };

  // Its session removed: the branch line is closed, but its worktree is
  // left for the user to clean up (a session in the trash may come back to
  // it; docs/specs/worktree-management.md). They are told once, so it isn't
  // left there unseen.
  function sessionRemoved(fork: Fork, at: string): void {
    fork.closedAt = at;
    fork.closedReason = 'session_removed';
    const ws = fork.workspace;
    if (ws.isolation === 'worktree' && ws.worktree && !ws.removedAt) {
      notify(fork, t('fork.push.sessionDeletedWorktreeKept', { worktree: ws.worktree }));
    }
  }

  async function step(fork: Fork): Promise<void> {
    const now = ports.now();
    const at = now.toISOString();
    // A failed start stays as it was (its worktree kept) until the user closes it.
    if (fork.failedAt) return;
    const startup = fork.startup;
    if (!startup) {
      // Open: only its session going away changes anything.
      if (!(await ports.readChild(fork.childSessionId))) sessionRemoved(fork, at);
      return;
    }
    await advanceSpawn({ ports, now }, { startup, childSessionId: fork.childSessionId, briefFile: fork.briefFile }, {
      message: briefMessage(fork),
      prepare: () => prepare(fork),
      ensureSession: () => ensureSession(fork),
      async launch() {
        const from = fork.memory === 'native' ? { sessionId: fork.origin.sessionId, conversationId: fork.origin.conversationId } : null;
        const result = await ports.launch(fork.childSessionId, fork.profileId, from, fork.permissionMode);
        return result.ok ? result : { ok: false, detail: result.reason };
      },
      // Only the user opens a branch line: that is their consent to this
      // worktree being worked in (as a delegation they start, ADR 0015 決策 4a).
      trustAllowed: () => true,
      trustAnswered: () => undefined,
      failed(detail) {
        fork.failedAt = at;
        fork.startup = null;
        fork.issue = { reason: 'launch_failed', detail, at };
        notify(fork, t('fork.push.launchFailed', { detail }));
      },
      attention(issue: SpawnAttention) {
        // Told once per reason; it stays until the start gets past it.
        if (fork.issue?.reason !== issue.reason) {
          notify(fork, issue.detail ? t('format.text.labelValue', { label: issueText(issue.reason), value: issue.detail }) : issueText(issue.reason));
        }
        fork.issue = { reason: issue.reason, detail: issue.detail, at: fork.issue?.reason === issue.reason ? fork.issue.at : at };
        // Given up on: the branch line is open; the user tells it by hand.
        if (issue.final) fork.startup = null;
      },
      gone() {
        sessionRemoved(fork, at);
        fork.startup = null;
      },
      briefed() {
        fork.startup = null;
        fork.issue = null;
      },
      relaunching: () => notify(fork, t('spawn.startup.relaunched')),
    });
  }

  async function prepare(fork: Fork): Promise<StepOutcome> {
    try {
      await ports.ensureWorkspace(fork.workspace);
    } catch (err) {
      return { ok: false, detail: t('spawn.prepare.workspaceFailed', { error: (err as Error).message }) };
    }
    const parent = await ports.readParent(fork.origin.sessionId);
    const parentDirty = fork.workspace.isolation === 'worktree' && parent ? await ports.parentDirtyFiles(parent.cwd).catch(() => null) : null;
    const upstream = fork.memory === 'brief'
      ? await ports.readUpstream(fork.origin.sessionId, fork.origin.conversationId, fork.origin.turnsAtFork).catch((err: unknown) => {
        console.warn(`[fork] ${fork.id}: reading where the upstream conversation is failed`, err);
        return null;
      })
      : null;
    const brief = formatForkBrief({
      fork,
      parent: { cwd: parent?.cwd ?? fork.workspace.path, profileLabel: parent?.profileLabel ?? null },
      parentDirty,
      upstream,
    });
    try {
      await ports.writeBrief(fork, brief);
    } catch (err) {
      return { ok: false, detail: t('fork.prepare.briefFailed', { error: (err as Error).message }) };
    }
    return { ok: true };
  }

  async function ensureSession(fork: Fork): Promise<StepOutcome> {
    const parent = await ports.readParent(fork.origin.sessionId);
    if (!parent) return { ok: false, detail: t('fork.prepare.parentGone') };
    try {
      await ports.ensureChildSession({ sessionId: fork.childSessionId, cwd: fork.workspace.path, projectId: parent.projectId, fork, alias: fork.title });
    } catch (err) {
      return { ok: false, detail: t('spawn.prepare.tmuxFailed', { error: (err as Error).message }) };
    }
    return { ok: true };
  }

  async function advanceOnce(): Promise<void> {
    const state = await store.load();
    let changed = false;
    for (const fork of Object.values(state.forks)) {
      if (fork.closedAt) continue;
      const before = JSON.stringify(fork);
      try {
        await step(fork);
      } catch (err) {
        // Tried again on the next tick.
        console.error(`[fork] step for ${fork.id} failed`, err);
      }
      if (JSON.stringify(fork) !== before) changed = true;
    }
    if (changed) await store.save(state);
  }

  const advance = () => serial(advanceOnce);

  // Right after a change, rather than on the next tick, while running.
  function kick(): void {
    if (timer) setImmediate(() => void advance().catch((err: unknown) => console.error('[fork] step failed', err)));
  }

  /** What a branch line from this session would be: refused when there is nothing to fork. */
  async function plan(parentSessionId: string, profileId: string | undefined) {
    const parent = await ports.readParent(parentSessionId);
    if (!parent) return refuse(404, 'not_found', 'the main line\'s session was not found');
    if (!parent.conversationId || parent.turns === 0) return refuse(409, 'nothing_to_fork', 'the main line has no conversation with a turn to fork yet');
    const profiles = await ports.listProfiles();
    const chosen = profileId ?? parent.profileId;
    if (!chosen) return refuse(400, 'invalid_request', 'profileId is required (the main line has no launch profile)');
    const profile = profiles.find((candidate) => candidate.id === chosen);
    if (!profile) return refuse(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
    const memory = chooseMemory({ parentProfileId: parent.profileId, profileId: profile.id, forkBlocked: parent.forkBlocked });
    return { ok: true as const, parent, profile, memory };
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void advance().catch((err: unknown) => console.error('[fork] step failed', err));
      }, FORK_TICK_MS);
      timer.unref?.();
      kick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    advance,
    async list(filter) {
      const state = await store.load();
      return Object.values(state.forks)
        .filter((fork) => !filter.sessionId || fork.origin.sessionId === filter.sessionId || fork.childSessionId === filter.sessionId)
        .filter((fork) => !filter.open || !fork.closedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((fork) => structuredClone(fork));
    },
    async get(id) {
      const found = (await store.load()).forks[id];
      return found ? structuredClone(found) : null;
    },
    async preview(parentSessionId, profileId) {
      const planned = await plan(parentSessionId, profileId);
      if (!planned.ok) return planned;
      const { parent, profile, memory } = planned;
      const workspace = await ports.planWorkspace({ id: UNCHOSEN_ID, branch: branchName('fork', UNCHOSEN_ID, ''), parentCwd: parent.cwd });
      const dirty = workspace.isolation === 'worktree' ? await ports.parentDirtyFiles(parent.cwd).catch(() => null) : null;
      return {
        ok: true,
        preview: {
          memory: memory.memory,
          memoryReason: memory.reason,
          profileId: profile.id,
          workspace: { isolation: workspace.isolation, path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, repoRoot: workspace.repoRoot },
          parentDirtyFiles: dirty ? dirty.map((file) => file.path) : null,
          turnsAtFork: parent.turns,
        },
      };
    },
    startFork(request) {
      return serial(async (): Promise<ForkResult> => {
        const planned = await plan(request.parentSessionId, request.profileId);
        if (!planned.ok) return planned;
        const { parent, profile, memory } = planned;
        const low = gateForkQuota(await ports.readQuota(profile.id), ports.now(), request.confirmLowQuota === true);
        if (low) return low;
        const permission = await ports.launchPermissionMode({
          sessionId: request.parentSessionId, profileId: profile.id, ...(request.permissionMode ? { requested: request.permissionMode } : {}),
        });
        if (!permission.ok) return refuse(400, permission.code, permission.message);
        const state = await store.load();
        const now = ports.now().toISOString();
        let id = ports.newId();
        while (state.forks[id]) id = ports.newId();
        const instruction = request.instruction?.trim() || null;
        const title = forkTitle({ title: request.title, instruction, parentTitle: parent.title });
        const workspace = await ports.planWorkspace({ id, branch: branchName('fork', id, title), parentCwd: parent.cwd });
        const fork: Fork = {
          id,
          title,
          createdAt: now,
          origin: {
            sessionId: request.parentSessionId,
            conversationId: parent.conversationId!,
            tmuxName: parent.tmuxName,
            profileId: parent.profileId,
            turnsAtFork: parent.turns,
            commit: workspace.baseCommit,
          },
          profileId: profile.id,
          profileLabel: profile.label,
          permissionMode: permission.mode,
          memory: memory.memory,
          instruction,
          // Chosen and saved before anything is made, so a restart finds it.
          childSessionId: ports.newSessionId(),
          workspace,
          briefFile: briefFileOf(workspace.path, id),
          startup: newStartup(now),
          issue: null,
          failedAt: null,
          closedAt: null,
          closedReason: null,
          cleanup: null,
        };
        state.forks[id] = fork;
        await store.save(state);
        kick();
        return { ok: true, fork: structuredClone(fork) };
      });
    },
    relaunch(id) {
      return serial(async (): Promise<ForkResult> => {
        const state = await store.load();
        const fork = state.forks[id];
        if (!fork || fork.closedAt) return refuse(404, 'not_found', 'no open branch line with that id');
        const child = await ports.readChild(fork.childSessionId);
        if (child && (child.running || child.switching || child.launching)) {
          // Stuck on a screen before its brief went in (an update menu, one
          // the app doesn't know): it has done no work yet, so its tmux is
          // closed first and made again by the start (ADR 0030).
          const stuck = !!fork.issue && fork.startup?.stage === 'briefing' && !fork.startup.deliveredAt && !child.switching;
          if (!stuck) return refuse(409, 'cli_already_running', 'its CLI is still running');
          const closed = await ports.closeChild(fork.childSessionId, true);
          if (!closed.ok) return refuse(409, 'cli_already_running', `its CLI could not be ended: ${closed.reason}`);
        }
        // From the top: each step finds what is already there and moves on.
        // The automatic relaunches already done still count against their cap.
        const relaunches = fork.startup?.guard?.relaunches ?? 0;
        fork.startup = { ...newStartup(ports.now().toISOString()), guard: { ...newLaunchGuard(), relaunches } };
        fork.failedAt = null;
        fork.issue = null;
        await store.save(state);
        kick();
        return { ok: true, fork: structuredClone(fork) };
      });
    },
    close(id, request) {
      return serial(async (): Promise<CloseResult> => {
        const state = await store.load();
        const fork = state.forks[id];
        if (!fork) return refuse(404, 'not_found', 'not found');
        // Nothing is left running in a folder about to go: its tmux first.
        const closed = await ports.closeChild(fork.childSessionId, request.force === true);
        if (!closed.ok) {
          return refuse(409, 'fork_still_running', `the branch line's CLI did not exit (${closed.reason}); close it with force, or in its tmux`, { reason: closed.reason });
        }
        const at = ports.now().toISOString();
        const outcome: ForkCloseOutcome = { tmuxClosed: closed.closed, workspace: 'shared' };
        const ws = fork.workspace;
        if (ws.isolation === 'worktree' && ws.worktree && ws.repoRoot) {
          if (ws.removedAt) {
            outcome.workspace = 'removed';
          } else {
            // Kept, not refused: an unmerged branch or uncommitted work is
            // the user's to deal with, and the branch line closes anyway.
            const refusal = await ports.workspaceRemovable(ws);
            const removed = refusal ? refusal : await ports.removeWorkspace(ws);
            if (removed.ok) {
              ws.removedAt = at;
              if (removed.branchDeleted) ws.branchDeletedAt = at;
              outcome.workspace = 'removed';
            } else {
              outcome.workspace = 'kept';
              outcome.keptReason = removed.code;
            }
          }
        }
        fork.startup = null;
        if (!fork.closedAt) {
          fork.closedAt = at;
          fork.closedReason = 'user';
        }
        fork.cleanup = { at, result: outcome.workspace, ...(outcome.keptReason ? { reason: outcome.keptReason } : {}) };
        await store.save(state);
        return { ok: true, fork: structuredClone(fork), outcome };
      });
    },
  };
}
