import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A delegation's or a branch line's worktree belongs to its project while
// it exists, read off its record, and is never one of the project's paths.

type Workspace = { isolation: 'worktree' | 'shared'; repoRoot: string | null; path: string; worktree: string | null; branch: string | null; baseCommit: string | null; removedAt?: string | null };
const records = vi.hoisted(() => ({
  delegations: [] as { id: string; title: string; workspace: Workspace; childSessionId: string | null; parentSessionId: string | null }[],
  forks: [] as { id: string; title: string; workspace: Workspace; childSessionId: string; origin: { sessionId: string }; cleanup: { result: string } | null }[],
  sessions: new Map<string, string>(),
}));
vi.mock('../../src/delegation/wiring.js', () => ({ delegation: { list: async () => records.delegations } }));
vi.mock('../../src/fork/wiring.js', () => ({ fork: { list: async () => records.forks } }));
vi.mock('../../src/registry.js', () => ({
  getSessionRecord: async (id: string) => (records.sessions.has(id) ? { id, projectId: records.sessions.get(id) } : undefined),
}));

let dir: string;
let projects: typeof import('../../src/project-store.js');
let roots: typeof import('../../src/spawn/roots.js');

const worktree = (folder: string, extra: Partial<Workspace> = {}): Workspace => ({
  isolation: 'worktree', repoRoot: path.join(dir, 'repo'), path: folder, worktree: folder, branch: `delegate/${path.basename(folder)}`, baseCommit: 'abc', removedAt: null, ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-spawn-roots-'));
  process.env.HESTIA_STATE_DIR = path.join(dir, 'state');
  projects = await import('../../src/project-store.js');
  roots = await import('../../src/spawn/roots.js');
  records.delegations = [];
  records.forks = [];
  records.sessions = new Map();
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('spawn worktree roots', () => {
  it('lists the project\'s delegation and branch line worktrees that are still there', async () => {
    const live = path.join(dir, 'repo-delegate-a1');
    const forkTree = path.join(dir, 'repo-fork-f1');
    const gone = path.join(dir, 'repo-delegate-a2');
    const removed = path.join(dir, 'repo-delegate-a3');
    await Promise.all([mkdir(live), mkdir(forkTree), mkdir(removed)]);
    records.sessions.set('child-a1', 'p1').set('parent', 'p1').set('other', 'p2');
    records.delegations = [
      { id: 'a1', title: 'Live', workspace: worktree(live), childSessionId: 'child-a1', parentSessionId: 'parent' },
      // Its folder deleted by hand: not there, whatever the record says.
      { id: 'a2', title: 'Gone', workspace: worktree(gone), childSessionId: null, parentSessionId: 'parent' },
      { id: 'a3', title: 'Cleaned up', workspace: worktree(removed, { removedAt: '2026-10-06T00:00:00.000Z' }), childSessionId: null, parentSessionId: 'parent' },
      { id: 'a4', title: 'Shared', workspace: { ...worktree(dir), isolation: 'shared', worktree: null }, childSessionId: null, parentSessionId: 'parent' },
      { id: 'a5', title: 'Another project', workspace: worktree(live), childSessionId: null, parentSessionId: 'other' },
    ];
    // Its own session gone: the project of the session it was started from.
    records.forks = [{ id: 'f1', title: 'Branch', workspace: worktree(forkTree), childSessionId: 'trashed', origin: { sessionId: 'parent' }, cleanup: null }];

    expect(await roots.spawnRoots('p1')).toEqual([
      { path: live, kind: 'delegation', id: 'a1', title: 'Live', branch: 'delegate/repo-delegate-a1' },
      { path: forkTree, kind: 'fork', id: 'f1', title: 'Branch', branch: 'delegate/repo-fork-f1' },
    ]);
    records.forks[0]!.cleanup = { result: 'removed' };
    expect((await roots.spawnRoots('p1')).map((root) => root.id)).toEqual(['a1']);
  });

  it('leaves out one made under the state dir, which is never read', async () => {
    const underState = path.join(dir, 'state', 'worktrees', 'repo-delegate-c1');
    await mkdir(underState, { recursive: true });
    records.sessions.set('parent', 'p1');
    records.delegations = [{ id: 'c1', title: 'Old fallback', workspace: worktree(underState), childSessionId: null, parentSessionId: 'parent' }];
    expect(await roots.spawnRoots('p1')).toEqual([]);
  });

  it('takes worktree paths out of projects, keeping a project\'s last path', async () => {
    const tree = path.join(dir, 'repo-delegate-b1');
    records.delegations = [{ id: 'b1', title: 'Old', workspace: worktree(tree, { removedAt: '2026-10-06T00:00:00.000Z' }), childSessionId: null, parentSessionId: null }];
    const mixed = await projects.createProject('mixed');
    await projects.addProjectPath(mixed.id, path.join(dir, 'repo'));
    await projects.addProjectPath(mixed.id, tree);
    const only = await projects.createProject('only');
    await projects.addProjectPath(only.id, tree);

    expect(await roots.forgetSpawnWorktreePaths()).toBe(1);
    expect((await projects.getProject(mixed.id))?.paths.map((entry) => entry.path)).toEqual([path.join(dir, 'repo')]);
    expect((await projects.getProject(only.id))?.paths.map((entry) => entry.path)).toEqual([tree]);
    expect(await roots.forgetSpawnWorktreePaths()).toBe(0);
  });
});
