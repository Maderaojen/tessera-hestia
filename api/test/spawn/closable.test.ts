import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delegation, DelegationStatus } from '../../src/contract/delegation.js';
import type { Fork } from '../../src/contract/fork.js';
import type { SpawnClosable, SpawnWorkspace } from '../../src/contract/workspace.js';
import { closableChildren } from '../../src/services/spawn-closable.js';
import { createClosableWatch, inspectClosable, mayBeClosable, type ClosableChild } from '../../src/spawn/closable.js';
import { ensureWorkspace, mergedInto, planWorkspace, workspaceState } from '../../src/spawn/workspace.js';
import type { ManagedSession } from '../../src/types.js';

// A finished branch line or delegation, offered for closing in the session
// list: the cheap rules, git against a real repo, the throttled watch, and
// which records' rules allow it.

const realGit = { state: workspaceState, mergedInto };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

const worktreeWs = (patch: Partial<SpawnWorkspace> = {}): SpawnWorkspace => ({
  isolation: 'worktree', repoRoot: '/r', path: '/w', worktree: '/w', branch: 'hestia/fork-x', baseCommit: 'base', ...patch,
});

describe('mayBeClosable', () => {
  const child = (patch: Partial<ClosableChild> = {}) => ({ activity: 'idle' as const, workspace: worktreeWs(), allowed: true, ...patch });

  it('asks git only for an allowed worktree, not removed, with its CLI at rest', () => {
    expect(mayBeClosable(child())).toBe(true);
    expect(mayBeClosable(child({ activity: 'ended' }))).toBe(true);
    expect(mayBeClosable(child({ activity: 'not_started' }))).toBe(true);
  });

  it('never for a busy CLI, a removed or shared workspace, or one its rules do not allow', () => {
    expect(mayBeClosable(child({ activity: 'busy' }))).toBe(false);
    expect(mayBeClosable(child({ activity: 'awaiting_approval' }))).toBe(false);
    expect(mayBeClosable(child({ activity: 'starting' }))).toBe(false);
    expect(mayBeClosable(child({ activity: 'stalled' }))).toBe(false);
    expect(mayBeClosable(child({ workspace: worktreeWs({ removedAt: '2026-10-01T00:00:00.000Z' }) }))).toBe(false);
    expect(mayBeClosable(child({ workspace: worktreeWs({ isolation: 'shared', worktree: null, branch: null }) }))).toBe(false);
    expect(mayBeClosable(child({ workspace: null }))).toBe(false);
    expect(mayBeClosable(child({ allowed: false }))).toBe(false);
  });
});

describe('inspectClosable against a real repo', () => {
  let root: string;
  let repo: string;
  let ws: SpawnWorkspace;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'closable-')));
    repo = path.join(root, 'proj');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    ws = await planWorkspace('fork', { id: 'c1c1c1c1', branch: 'hestia/fork-c1', parentCwd: repo, isolation: 'worktree' });
    ws = { ...ws, worktree: path.join(root, 'wt'), path: path.join(root, 'wt') };
    await ensureWorkspace(ws);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('nothing new and clean: unchanged', async () => {
    expect(await inspectClosable(ws, realGit)).toEqual({ reason: 'unchanged', into: null });
  });

  it('committed but not merged: not closable', async () => {
    await writeFile(path.join(ws.path, 'b.txt'), 'b\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '-q', '-m', 'work');
    expect(await inspectClosable(ws, realGit)).toBeNull();
  });

  it('merged into the branch the repo has checked out, and clean: merged', async () => {
    await writeFile(path.join(ws.path, 'b.txt'), 'b\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '-q', '-m', 'work');
    git(repo, 'merge', '-q', '--ff-only', 'hestia/fork-c1');
    expect(await inspectClosable(ws, realGit)).toEqual({ reason: 'merged', into: 'main' });
  });

  it('merged but with uncommitted work: not closable', async () => {
    await writeFile(path.join(ws.path, 'b.txt'), 'b\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '-q', '-m', 'work');
    git(repo, 'merge', '-q', '--ff-only', 'hestia/fork-c1');
    await writeFile(path.join(ws.path, 'c.txt'), 'dirty\n');
    expect(await inspectClosable(ws, realGit)).toBeNull();
  });

  it('nothing committed but files left uncommitted: not closable', async () => {
    await writeFile(path.join(ws.path, 'a.txt'), 'changed\n');
    expect(await inspectClosable(ws, realGit)).toBeNull();
  });
});

describe('createClosableWatch', () => {
  function setup(children: ClosableChild[], answer: SpawnClosable | null = { reason: 'merged', into: 'main' }) {
    let now = 1_000_000;
    const written: [string, SpawnClosable | null][] = [];
    const inspect = vi.fn(async () => answer);
    const watch = createClosableWatch({
      children: async () => children,
      inspect,
      write: async (id, closable) => {
        written.push([id, closable]);
        const child = children.find((item) => item.sessionId === id);
        if (child) child.current = closable;
      },
      now: () => now,
      refreshMs: 30_000,
    });
    return { watch, inspect, written, advance: (ms: number) => { now += ms; } };
  }
  const child = (patch: Partial<ClosableChild> = {}): ClosableChild => ({
    sessionId: 's1', activity: 'idle', current: null, workspace: worktreeWs(), allowed: true, ...patch,
  });

  it('asks git once per session per refresh interval, however often it runs', async () => {
    const { watch, inspect, written, advance } = setup([child()]);
    await watch.refresh();
    await watch.refresh();
    advance(10_000);
    await watch.refresh();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(written).toEqual([['s1', { reason: 'merged', into: 'main' }]]);
    advance(25_000);
    await watch.refresh();
    expect(inspect).toHaveBeenCalledTimes(2);
    // Nothing changed: nothing written again.
    expect(written).toHaveLength(1);
  });

  it('clears it without git once its CLI is at work again', async () => {
    const children = [child({ current: { reason: 'merged', into: 'main' }, activity: 'busy' })];
    const { watch, inspect, written } = setup(children);
    await watch.refresh();
    expect(inspect).not.toHaveBeenCalled();
    expect(written).toEqual([['s1', null]]);
  });

  it('never asks git for a session its rules do not allow, or a shared folder', async () => {
    const { watch, inspect, written } = setup([
      child({ sessionId: 'a', allowed: false }),
      child({ sessionId: 'b', workspace: worktreeWs({ isolation: 'shared', worktree: null }) }),
      child({ sessionId: 'c', workspace: worktreeWs({ removedAt: '2026-10-01T00:00:00.000Z' }) }),
    ]);
    await watch.refresh();
    expect(inspect).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it('writes when it was closed, only when that changes, and never asks git for it', async () => {
    const closed: [string, string | null][] = [];
    const children = [child({ closedAt: '2026-10-13T00:00:00.000Z', currentClosedAt: null, allowed: false })];
    const inspect = vi.fn(async () => null);
    const watch = createClosableWatch({
      children: async () => children,
      inspect,
      write: async () => {},
      writeClosed: async (id, at) => {
        closed.push([id, at]);
        children[0].currentClosedAt = at;
      },
      now: () => 0,
    });
    await watch.refresh();
    await watch.refresh();
    expect(closed).toEqual([['s1', '2026-10-13T00:00:00.000Z']]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('a git failure is taken as not closable', async () => {
    const written: [string, SpawnClosable | null][] = [];
    const failing = createClosableWatch({
      children: async () => [child({ current: { reason: 'unchanged', into: null } })],
      inspect: async () => { throw new Error('git gone'); },
      write: async (id, closable) => { written.push([id, closable]); },
      now: () => 0,
    });
    await failing.refresh();
    expect(written).toEqual([['s1', null]]);
  });
});

describe('closableChildren', () => {
  const session = (id: string, patch: Partial<ManagedSession>): ManagedSession => ({
    id, status: 'ready', turnPhase: 'idle', ...patch,
  }) as unknown as ManagedSession;
  const forkRecord = (patch: Partial<Fork> = {}): Fork => ({
    id: 'f1', childSessionId: 'sf', workspace: worktreeWs(), startup: null, failedAt: null, closedAt: null, ...patch,
  }) as unknown as Fork;
  const delegationRecord = (state: DelegationStatus): Delegation => ({
    id: 'd1', childSessionId: 'sd', state, workspace: { ...worktreeWs(), headAtDelivery: null },
  }) as unknown as Delegation;
  const forkSession = (patch: Partial<ManagedSession> = {}) => session('sf', { forkOrigin: { forkId: 'f1', fromSessionId: 'main', fromConversationId: 'c', sharedFolder: false }, ...patch });
  const delegateSession = session('sd', { delegationOrigin: { delegationId: 'd1', fromSessionId: 'main', fromConversationId: 'c' } });

  it('an open, started branch line is allowed; a closed, failed or still starting one is not', () => {
    expect(closableChildren([forkSession()], [forkRecord()], [])[0]).toMatchObject({ sessionId: 'sf', allowed: true, activity: 'idle' });
    expect(closableChildren([forkSession()], [forkRecord({ closedAt: 'x' })], [])[0].allowed).toBe(false);
    expect(closableChildren([forkSession()], [forkRecord({ failedAt: 'x' })], [])[0].allowed).toBe(false);
    expect(closableChildren([forkSession()], [forkRecord({ startup: {} as Fork['startup'] })], [])[0].allowed).toBe(false);
    // Its record gone: not allowed, no workspace.
    expect(closableChildren([forkSession()], [], [])[0]).toMatchObject({ allowed: false, workspace: null });
  });

  it('a busy branch line session reads as busy', () => {
    const [child] = closableChildren([forkSession({ turnPhase: 'replying', paneActivity: 'busy' } as Partial<ManagedSession>)], [forkRecord()], []);
    expect(child.activity).toBe('busy');
    expect(mayBeClosable(child)).toBe(false);
  });

  it('a delegation only once it is over: never while delivered (待驗收) or going', () => {
    const allowed = (state: DelegationStatus) => closableChildren([delegateSession], [], [delegationRecord(state)])[0].allowed;
    expect(allowed('accepted')).toBe(true);
    expect(allowed('rejected')).toBe(true);
    expect(allowed('stopped')).toBe(true);
    for (const state of ['proposed', 'starting', 'working', 'needs_attention', 'reviewing', 'delivered'] as const) {
      expect(allowed(state)).toBe(false);
    }
  });

  it('when it was closed: a fork closedAt, a delegation removed worktree', () => {
    expect(closableChildren([forkSession()], [forkRecord({ closedAt: '2026-10-13T00:00:00.000Z' })], [])[0]).toMatchObject({ closedAt: '2026-10-13T00:00:00.000Z', currentClosedAt: null });
    expect(closableChildren([forkSession({ spawnClosedAt: 'x' })], [forkRecord()], [])[0]).toMatchObject({ closedAt: null, currentClosedAt: 'x' });
    const removed = delegationRecord('accepted');
    removed.workspace.removedAt = '2026-10-13T01:00:00.000Z';
    expect(closableChildren([delegateSession], [], [removed])[0].closedAt).toBe('2026-10-13T01:00:00.000Z');
    expect(closableChildren([delegateSession], [], [delegationRecord('accepted')])[0].closedAt).toBeNull();
  });

  it('only branch line and delegate sessions are looked at', () => {
    expect(closableChildren([session('plain', {})], [], [])).toEqual([]);
  });
});
