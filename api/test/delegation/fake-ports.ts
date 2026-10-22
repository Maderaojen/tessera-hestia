import type { DelegationWorkspace } from '../../src/contract/delegation.js';
import type { ScreenReading } from '../../src/launch-guard/decide.js';
import type { PermissionMode } from '../../src/contract/permissions.js';
import type { ChildView, DelegationPorts, ParentView, ProfileInfo, SendOutcome } from '../../src/delegation/ports.js';
import { capForLlm } from '../../src/permission-modes/policy.js';

// An in-memory app for delegation/ tests: the delegating session, the
// delegate's session as it comes up, launch profiles, the workspace, and a
// log of what was done.

export function childView(patch: Partial<ChildView> = {}): ChildView {
  return {
    profileId: null, running: true, switching: false, phase: 'idle', lastTurnAt: null, lastSentAt: null,
    provider: 'claude', launching: false, startupPrompt: null, interaction: false, lastError: null,
    ...patch,
  };
}

export type World = {
  now: Date;
  parents: Map<string, ParentView>;
  children: Map<string, ChildView>;
  profiles: ProfileInfo[];
  ids: string[];
  sessionIds: string[];
  // What planWorkspace answers for the delegating session's folder.
  repo: boolean;
  workspaceError: string | null;
  workspaces: DelegationWorkspace[];
  briefs: Map<string, string>;
  createdSessions: { sessionId: string; cwd: string; projectId: string; delegationId: string; alias: string }[];
  launches: { sessionId: string; profileId: string; permissionMode?: PermissionMode }[];
  // The delegating tmux's (or global) setting for a delegate's runtime, and what that runtime supports.
  permissionSetting: PermissionMode;
  permissionSupported: PermissionMode[];
  launchOutcome: { ok: true } | { ok: false; reason: string };
  // How a launch shows up: the child as it is once launched.
  launchedChild: ChildView;
  trustAnswers: string[];
  trustAnswer: 'answered' | 'unsure';
  sent: { sessionId: string; text: string }[];
  sendOutcome: SendOutcome;
  delivery: 'exact' | 'partial' | 'missing' | 'unknown';
  // What the launch guard reads off the pane.
  screen: ScreenReading | null;
  firstReply: string | null;
  continuityBusy: boolean;
  // Per session: continuity busy on that one (the delegate's or the delegating one's).
  busySessions: Set<string>;
  // The target account's quota, per profile (absent: unknown).
  quota: Map<string, { remainingPercent: number | null; limitedUntil: string | null }>;
  // What the delegating session's folder got: path → content.
  parentReports: Map<string, string>;
  parentReportError: string | null;
  clean: boolean;
  head: string | null;
  interrupted: string[];
  notices: { id: string; body: string }[];
  // What the delegate's folder got: feedback file → content.
  feedback: Map<string, string>;
  // Per delegating session: it has moved on to other work.
  movedOn: Set<string>;
  // What removeWorkspace answers, and what it was asked.
  removeOutcome: { ok: true; removed: boolean; branchDeleted: boolean } | { ok: false; code: 'workspace_dirty' | 'branch_not_merged'; message: string } | null;
  // The branch a delivery is merged into (deliveryMergedInto), for one delivered.
  mergedInto: string | null;
  removals: { worktree: string | null; deleteBranch: boolean }[];
  // What closing the delegate's tmux answers, and which were closed.
  closeOutcome: { ok: true; closed: boolean } | { ok: false; reason: 'cli_busy' | 'exit_unverified' | 'in_transition' };
  closed: string[];
  // Per session: continuity waits for the usage limit to reset until then.
  limitWaits: Map<string, string>;
  // The delegating conversation's turns (Turn.index, request), and what was asked of it.
  upstreamTurns: { index: number; request: string }[];
  upstreamReads: { sessionId: string; conversationId: string; upTo: number | null }[];
};

export function newWorld(): World {
  return {
    now: new Date('2026-10-06T10:00:00.000Z'),
    parents: new Map([['p1', {
      cwd: '/work/hestia/api', projectId: 'proj1', tmuxName: 'hestia-p1', conversationId: 'c1', profileId: 'native:claude', profileLabel: 'Claude Code',
    }]]),
    // The delegating session's own CLI, idle (for what is sent back to it).
    children: new Map([['p1', childView({ profileId: 'native:claude', lastTurnAt: '2026-10-06T09:00:00.000Z' })]]),
    profiles: [{ id: 'native:codex', label: 'Codex CLI' }, { id: 'native:claude', label: 'Claude Code' }],
    ids: ['ab12cd34', 'ef56ab78'],
    sessionIds: ['child-1', 'child-2'],
    repo: true,
    workspaceError: null,
    workspaces: [],
    briefs: new Map(),
    createdSessions: [],
    launches: [],
    permissionSetting: 'cli_default',
    permissionSupported: ['cli_default', 'auto', 'yolo'],
    launchOutcome: { ok: true },
    launchedChild: childView({ running: false, launching: true, switching: true, phase: null }),
    trustAnswers: [],
    trustAnswer: 'answered',
    sent: [],
    sendOutcome: { status: 'sent' },
    delivery: 'exact',
    screen: { screen: { kind: 'input_ready' }, tail: '> ' },
    firstReply: null,
    continuityBusy: false,
    busySessions: new Set(),
    quota: new Map(),
    parentReports: new Map(),
    parentReportError: null,
    clean: true,
    head: 'f00dfeed',
    interrupted: [],
    notices: [],
    feedback: new Map(),
    movedOn: new Set(),
    removeOutcome: null,
    mergedInto: null,
    removals: [],
    closeOutcome: { ok: true, closed: true },
    closed: [],
    limitWaits: new Map(),
    upstreamTurns: [{ index: 1, request: '先看一下狀態' }, { index: 2, request: '把狀態加上 --json，交給 Codex 做' }],
    upstreamReads: [],
  };
}

export function fakePorts(world: World): DelegationPorts {
  return {
    now: () => world.now,
    newId: () => world.ids.shift() ?? 'zz99zz99',
    newSessionId: () => world.sessionIds.shift() ?? 'child-x',
    readParent: async (id) => world.parents.get(id) ?? null,
    listProfiles: async () => world.profiles,
    readQuota: async (profileId) => world.quota.get(profileId) ?? { remainingPercent: null, limitedUntil: null },
    planWorkspace: async ({ id, branch, parentCwd, isolation }) => (world.repo && isolation === 'worktree'
      ? {
        isolation: 'worktree', repoRoot: '/work/hestia', path: `/work/hestia-delegate-${id}/api`, worktree: `/work/hestia-delegate-${id}`,
        branch, baseCommit: 'base0001', headAtDelivery: null,
      }
      : { isolation: 'shared', repoRoot: world.repo ? '/work/hestia' : null, path: parentCwd, worktree: null, branch: null, baseCommit: null, headAtDelivery: null }),
    ensureWorkspace: async (workspace) => {
      if (world.workspaceError) throw new Error(world.workspaceError);
      world.workspaces.push(workspace);
    },
    workspaceState: async () => ({ clean: world.clean, head: world.head }),
    removeWorkspace: async (workspace, { deleteBranch }) => {
      world.removals.push({ worktree: workspace.worktree, deleteBranch });
      return world.removeOutcome ?? { ok: true, removed: !workspace.removedAt, branchDeleted: deleteBranch };
    },
    deliveryMergedInto: async (workspace) => (workspace.headAtDelivery ? world.mergedInto : null),
    workspaceRemovable: async () => (world.removeOutcome && !world.removeOutcome.ok ? world.removeOutcome : null),
    closeChild: async (id) => {
      if (world.closeOutcome.ok && world.closeOutcome.closed) world.closed.push(id);
      return world.closeOutcome;
    },
    writeFeedback: async (d, round, content) => {
      const file = `${d.briefFile.replace(/brief\.md$/, '')}feedback-${round}.md`;
      world.feedback.set(file, content);
      return file;
    },
    sameWork: async (sessionId) => !world.movedOn.has(sessionId),
    parentDirty: async () => true,
    readUpstream: async (sessionId, conversationId, upTo) => {
      world.upstreamReads.push({ sessionId, conversationId, upTo });
      const last = world.upstreamTurns[Math.min(upTo ?? world.upstreamTurns.length, world.upstreamTurns.length) - 1];
      return {
        archiveFile: `/state/dialogue/host/claude/hestia-p1/${conversationId}.jsonl`, transcriptFile: '/home/u/.claude/projects/p/abc.jsonl', transcriptFormat: 'jsonl',
        recapFile: null, lastRequest: last?.request ?? null, turns: world.upstreamTurns.length, lastIndex: last?.index ?? null,
      };
    },
    writeBrief: async (d, content) => { world.briefs.set(d.briefFile, content); },
    writeParentReport: async (d, content) => {
      const parent = d.parentSessionId ? world.parents.get(d.parentSessionId) : undefined;
      if (!parent) throw new Error('the delegating session is gone');
      if (world.parentReportError) throw new Error(world.parentReportError);
      const file = `${parent.cwd}/.hestia/delegations/${d.id}/report.md`;
      world.parentReports.set(file, content);
      return file;
    },
    ensureChildSession: async (input) => {
      if (world.children.has(input.sessionId)) return;
      world.createdSessions.push(input);
      world.children.set(input.sessionId, childView({ provider: null, running: false, phase: null }));
    },
    launchPermissionMode: async ({ requested, llm }) => {
      if (requested && !world.permissionSupported.includes(requested)) return { ok: false, code: 'permission_mode_unsupported', message: 'unsupported' };
      const mode = requested ?? world.permissionSetting;
      return { ok: true, mode: llm ? capForLlm(mode, world.permissionSupported) : mode };
    },
    launch: async (sessionId, profileId, permissionMode) => {
      world.launches.push({ sessionId, profileId, ...(permissionMode && permissionMode !== 'cli_default' ? { permissionMode } : {}) });
      if (world.launchOutcome.ok) world.children.set(sessionId, { ...world.launchedChild });
      return world.launchOutcome;
    },
    readChild: async (id) => world.children.get(id) ?? null,
    answerTrust: async (id) => {
      world.trustAnswers.push(id);
      if (world.trustAnswer === 'answered') world.children.set(id, { ...world.children.get(id)!, startupPrompt: null });
      return world.trustAnswer;
    },
    send: async (sessionId, text) => {
      if (world.sendOutcome.status === 'sent') {
        world.sent.push({ sessionId, text });
        world.children.set(sessionId, { ...world.children.get(sessionId)!, phase: 'replying', lastSentAt: world.now.toISOString() });
      }
      return world.sendOutcome;
    },
    checkDelivered: async () => world.delivery,
    readScreen: async () => world.screen,
    skipUpdate: async () => 'answered',
    firstReplyAfter: async () => world.firstReply,
    continuityBusy: async (id) => world.continuityBusy || world.busySessions.has(id),
    limitWaitUntil: async (id) => world.limitWaits.get(id) ?? null,
    interrupt: async (id) => { world.interrupted.push(id); },
    notify: async (d, body) => { world.notices.push({ id: d.id, body }); },
  };
}

export function later(world: World, ms: number): void {
  world.now = new Date(world.now.getTime() + ms);
}

/** The CLI's first turn after the brief ends (the launch guard watches it, ADR 0030); a step later the start is over. */
export function firstTurnOver(world: World, childId = 'child-1'): void {
  world.children.set(childId, { ...world.children.get(childId)!, phase: 'idle' });
  later(world, 4_000);
}
