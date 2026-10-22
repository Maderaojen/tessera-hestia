import type { Fork } from '../../src/contract/fork.js';
import type { ScreenReading } from '../../src/launch-guard/decide.js';
import type { PermissionMode } from '../../src/contract/permissions.js';
import type { RepoFileChange } from '../../src/contract/repo.js';
import type { SpawnWorkspace } from '../../src/contract/workspace.js';
import type { ForkParentView, ForkPorts, ProfileInfo, UpstreamView } from '../../src/fork/ports.js';
import type { CloseOutcome } from '../../src/spawn/session.js';
import type { SendOutcome, SessionView } from '../../src/spawn/ports.js';
import type { RemovalRefusal } from '../../src/spawn/workspace.js';

// An in-memory app for fork/ tests: the main line, the branch line's
// session as it comes up, launch profiles, the workspace, and a log of what
// was done.

export function sessionView(patch: Partial<SessionView> = {}): SessionView {
  return {
    profileId: null, running: true, switching: false, phase: 'idle', lastTurnAt: null, lastSentAt: null,
    provider: 'claude', launching: false, startupPrompt: null, interaction: false, lastError: null,
    ...patch,
  };
}

export type World = {
  now: Date;
  parents: Map<string, ForkParentView>;
  upstream: UpstreamView;
  sessions: Map<string, SessionView>;
  profiles: ProfileInfo[];
  ids: string[];
  sessionIds: string[];
  repo: boolean;
  workspaceError: string | null;
  workspaces: SpawnWorkspace[];
  dirty: RepoFileChange[] | null;
  briefs: Map<string, string>;
  created: { sessionId: string; cwd: string; projectId: string; forkId: string; alias: string }[];
  launches: { sessionId: string; profileId: string; from: { sessionId: string; conversationId: string } | null; permissionMode?: PermissionMode }[];
  // The main line's tmux's (or global) setting for the branch line's runtime.
  permissionSetting: PermissionMode;
  launchOutcome: { ok: true } | { ok: false; reason: string };
  launchedSession: SessionView;
  trustAnswers: string[];
  sent: { sessionId: string; text: string }[];
  sendOutcome: SendOutcome;
  delivery: 'exact' | 'partial' | 'missing' | 'unknown';
  // What the launch guard reads off the pane.
  screen: ScreenReading | null;
  quota: Map<string, { remainingPercent: number | null; limitedUntil: string | null }>;
  closeOutcome: CloseOutcome;
  closed: { sessionId: string; force: boolean }[];
  removable: RemovalRefusal | null;
  removals: SpawnWorkspace[];
  notices: { id: string; body: string }[];
};

export function newWorld(): World {
  return {
    now: new Date('2026-10-08T10:00:00.000Z'),
    parents: new Map([['main', {
      cwd: '/work/hestia/api', projectId: 'proj1', tmuxName: 'hestia-main', title: 'hestia-main', conversationId: 'c1', turns: 12,
      profileId: 'native:claude', profileLabel: 'Claude Code', forkBlocked: null,
    }]]),
    upstream: {
      archiveFile: '/state/dialogue/host/claude/hestia-main/c1.jsonl', transcriptFile: '/home/u/.claude/projects/p/abc.jsonl', transcriptFormat: 'jsonl',
      recapFile: null, lastRequest: '把設定頁的排版改成兩欄', turns: 12, lastIndex: 12,
    },
    sessions: new Map([['main', sessionView({ profileId: 'native:claude' })]]),
    profiles: [{ id: 'native:claude', label: 'Claude Code' }, { id: 'native:codex', label: 'Codex CLI' }],
    ids: ['f1f1f1f1', 'f2f2f2f2'],
    sessionIds: ['branch-1', 'branch-2'],
    repo: true,
    workspaceError: null,
    workspaces: [],
    dirty: [{ path: 'web/src/App.vue', origPath: null, staged: null, unstaged: 'modified' } as RepoFileChange],
    briefs: new Map(),
    created: [],
    launches: [],
    permissionSetting: 'cli_default',
    launchOutcome: { ok: true },
    launchedSession: sessionView({ running: false, launching: true, switching: true, phase: null }),
    trustAnswers: [],
    sent: [],
    sendOutcome: { status: 'sent' },
    delivery: 'exact',
    screen: { screen: { kind: 'input_ready' }, tail: '> ' },
    quota: new Map(),
    closeOutcome: { ok: true, closed: true },
    closed: [],
    removable: null,
    removals: [],
    notices: [],
  };
}

export function fakePorts(world: World): ForkPorts {
  return {
    now: () => world.now,
    newId: () => world.ids.shift() ?? 'zz99zz99',
    newSessionId: () => world.sessionIds.shift() ?? 'branch-x',
    readParent: async (id) => world.parents.get(id) ?? null,
    readUpstream: async () => world.upstream,
    listProfiles: async () => world.profiles,
    readQuota: async (profileId) => world.quota.get(profileId) ?? { remainingPercent: null, limitedUntil: null },
    planWorkspace: async ({ id, branch, parentCwd }) => (world.repo
      ? { isolation: 'worktree', repoRoot: '/work/hestia', path: `/work/hestia-fork-${id}/api`, worktree: `/work/hestia-fork-${id}`, branch, baseCommit: 'base0001' }
      : { isolation: 'shared', repoRoot: null, path: parentCwd, worktree: null, branch: null, baseCommit: null }),
    ensureWorkspace: async (workspace) => {
      if (world.workspaceError) throw new Error(world.workspaceError);
      world.workspaces.push(workspace);
    },
    parentDirtyFiles: async () => world.dirty,
    writeBrief: async (fork: Fork, content) => { world.briefs.set(fork.briefFile, content); },
    ensureChildSession: async (input) => {
      if (world.sessions.has(input.sessionId)) return;
      world.created.push({ sessionId: input.sessionId, cwd: input.cwd, projectId: input.projectId, forkId: input.fork.id, alias: input.alias });
      world.sessions.set(input.sessionId, sessionView({ provider: null, running: false, phase: null }));
    },
    launchPermissionMode: async ({ requested }) => ({ ok: true, mode: requested ?? world.permissionSetting }),
    launch: async (sessionId, profileId, from, permissionMode) => {
      world.launches.push({ sessionId, profileId, from, ...(permissionMode && permissionMode !== 'cli_default' ? { permissionMode } : {}) });
      if (world.launchOutcome.ok) world.sessions.set(sessionId, { ...world.launchedSession });
      return world.launchOutcome;
    },
    closeChild: async (sessionId, force) => {
      // No tmux left to close.
      if (!world.sessions.has(sessionId)) return { ok: true, closed: false };
      world.closed.push({ sessionId, force });
      if (world.closeOutcome.ok && world.closeOutcome.closed) world.sessions.delete(sessionId);
      return world.closeOutcome;
    },
    workspaceRemovable: async () => world.removable,
    removeWorkspace: async (workspace) => {
      world.removals.push(workspace);
      return world.removable ?? { ok: true, removed: true, branchDeleted: true };
    },
    readChild: async (id) => world.sessions.get(id) ?? null,
    answerTrust: async (id) => {
      world.trustAnswers.push(id);
      world.sessions.set(id, { ...world.sessions.get(id)!, startupPrompt: null });
      return 'answered';
    },
    send: async (sessionId, text) => {
      if (world.sendOutcome.status === 'sent') {
        world.sent.push({ sessionId, text });
        world.sessions.set(sessionId, { ...world.sessions.get(sessionId)!, phase: 'replying' });
      }
      return world.sendOutcome;
    },
    checkDelivered: async () => world.delivery,
    readScreen: async () => world.screen,
    skipUpdate: async () => 'answered',
    notify: async (fork, body) => { world.notices.push({ id: fork.id, body }); },
  };
}

export function later(world: World, ms: number): void {
  world.now = new Date(world.now.getTime() + ms);
}

/** The CLI's first turn after the brief ends (the launch guard watches it, ADR 0030); a step later the start is over. */
export function firstTurnOver(world: World, childId = 'branch-1'): void {
  world.sessions.set(childId, { ...world.sessions.get(childId)!, phase: 'idle' });
  later(world, 4_000);
}
