import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorktreeList } from '../../src/git/worktree.js';

// A repo's worktrees for the git view, against a real repo in a temp
// folder.

type Workspace = { isolation: 'worktree'; repoRoot: string; path: string; worktree: string; branch: string; baseCommit: string; removedAt?: string | null };
const records = vi.hoisted(() => ({
  delegations: [] as { id: string; title: string; state: string; workspace: Workspace; childSessionId: string | null; parentSessionId: string | null }[],
  forks: [] as { id: string; title: string; workspace: Workspace; childSessionId: string; origin: { sessionId: string }; closedAt: string | null; failedAt: string | null; startup: null; cleanup: null }[],
}));
vi.mock('../../src/delegation/wiring.js', () => ({ delegation: { list: async () => records.delegations } }));
vi.mock('../../src/fork/wiring.js', () => ({ fork: { list: async () => records.forks } }));
vi.mock('../../src/registry.js', () => ({ getSessionRecord: async () => undefined }));

let dir: string;
let repo: string;
let worktrees: typeof import('../../src/spawn/worktrees.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

const workspace = (folder: string, branch: string): Workspace => ({ isolation: 'worktree', repoRoot: repo, path: folder, worktree: folder, branch, baseCommit: 'abc', removedAt: null });

beforeEach(async () => {
  vi.resetModules();
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hestia-worktrees-')));
  process.env.HESTIA_STATE_DIR = path.join(dir, 'state');
  repo = path.join(dir, 'proj');
  await mkdir(repo);
  git(repo, 'init', '-q');
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  records.delegations = [];
  records.forks = [];
  worktrees = await import('../../src/spawn/worktrees.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('parseWorktreeList', () => {
  it('reads every field, a worktree at a time', () => {
    const out = [
      'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /r-x', 'HEAD bbb', 'detached', 'locked claude agent', '',
      'worktree /gone', 'HEAD ccc', 'branch refs/heads/fork/f1', 'prunable gitdir file points to non-existent location', '', '',
    ].join('\0');
    expect(parseWorktreeList(out)).toEqual([
      { path: '/r', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/r-x', head: 'bbb', branch: null, detached: true, bare: false, locked: true, prunable: false },
      { path: '/gone', head: 'ccc', branch: 'fork/f1', detached: false, bare: false, locked: false, prunable: true },
    ]);
  });
});

describe('repoWorktrees', () => {
  it('lists every worktree of the repo, marks Hestia\'s own, and opens only the roots it is given', async () => {
    const other = path.join(dir, 'proj-other');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', other);
    const delegated = path.join(dir, 'proj-worktrees', 'proj-delegate-d1');
    git(repo, 'worktree', 'add', '-q', '-b', 'delegate/d1', delegated);
    await writeFile(path.join(delegated, 'work.txt'), 'work\n');
    git(delegated, 'add', '.');
    git(delegated, 'commit', '-q', '-m', 'work');
    const forked = path.join(dir, 'proj-worktrees', 'proj-fork-f1');
    git(repo, 'worktree', 'add', '-q', '-b', 'fork/f1', forked);
    await writeFile(path.join(forked, 'loose.txt'), 'not committed\n');
    const open = path.join(dir, 'proj-worktrees', 'proj-fork-f2');
    git(repo, 'worktree', 'add', '-q', '-b', 'fork/f2', open);
    const gone = path.join(dir, 'proj-worktrees', 'proj-fork-f3');
    git(repo, 'worktree', 'add', '-q', '-b', 'fork/f3', gone);
    await rm(gone, { recursive: true, force: true });

    records.delegations = [{ id: 'd1', title: 'Fix it', state: 'accepted', workspace: workspace(delegated, 'delegate/d1'), childSessionId: 's-d1', parentSessionId: 'p' }];
    const fork = (id: string, folder: string, closedAt: string | null) => ({
      id, title: `Branch ${id}`, workspace: workspace(folder, `fork/${id}`), childSessionId: `s-${id}`, origin: { sessionId: 'p' }, closedAt, failedAt: null, startup: null, cleanup: null,
    });
    records.forks = [fork('f1', forked, '2026-10-09T00:00:00.000Z'), fork('f2', open, null), fork('f3', gone, '2026-10-09T00:00:00.000Z')];

    const result = await worktrees.repoWorktrees(repo, [repo, delegated]);
    const byPath = new Map(result.worktrees.map((entry) => [entry.path, entry]));
    expect(result.worktrees.map((entry) => entry.path)).toEqual([repo, other, delegated, forked, open, gone]);
    expect(byPath.get(repo)).toMatchObject({ main: true, current: true, branch: 'main', exists: true, changedCount: 0, merged: null, root: repo, spawn: null });
    // Not Hestia's, not a root: listed, never opened.
    expect(byPath.get(other)).toMatchObject({ main: false, current: false, branch: 'other', merged: true, root: null, spawn: null });
    // Over and clean: its worktree goes, the unmerged branch stays.
    expect(byPath.get(delegated)).toMatchObject({
      root: delegated, merged: false, changedCount: 0,
      spawn: { kind: 'delegation', id: 'd1', title: 'Fix it', status: 'accepted', ended: true, cleanupBlocked: null, sessionId: 's-d1' },
    });
    // A closed branch line with uncommitted work is kept.
    expect(byPath.get(forked)).toMatchObject({ root: null, merged: true, changedCount: 1, spawn: { kind: 'fork', status: 'closed', ended: true, cleanupBlocked: 'workspace_dirty' } });
    // Still open: nothing to clean up yet.
    expect(byPath.get(open)?.spawn).toMatchObject({ status: 'open', ended: false, cleanupBlocked: null });
    expect(byPath.get(gone)).toMatchObject({ exists: false, changedCount: null, spawn: { ended: true, cleanupBlocked: null } });
    expect(result).toMatchObject({ endedKept: 2, endedKeptWarnAt: worktrees.ENDED_KEPT_WARN_AT });
  });

  it('marks the worktree the asked root is in, and opens a subfolder root as its worktree', async () => {
    const other = path.join(dir, 'proj-other');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', other);
    await mkdir(path.join(other, 'sub'));
    const result = await worktrees.repoWorktrees(other, [repo, path.join(other, 'sub')]);
    expect(result.worktrees.map((entry) => [entry.path, entry.current, entry.root])).toEqual([
      [repo, false, repo],
      [other, true, path.join(other, 'sub')],
    ]);
  });
});

describe('mergedInto', () => {
  it('names the branch once the repo has the delivered commit, and only a commit past the base', async () => {
    const { mergedInto } = await import('../../src/spawn/workspace.js');
    const base = git(repo, 'rev-parse', 'HEAD');
    const delegated = path.join(dir, 'proj-delegate');
    git(repo, 'worktree', 'add', '-q', '-b', 'delegate/d1', delegated);
    await writeFile(path.join(delegated, 'b.txt'), 'b\n');
    git(delegated, 'add', '.');
    git(delegated, 'commit', '-q', '-m', 'work');
    const delivered = git(delegated, 'rev-parse', 'HEAD');
    const ws = { ...workspace(delegated, 'delegate/d1'), baseCommit: base };

    expect(await mergedInto(ws, delivered)).toBeNull();
    expect(await mergedInto(ws, base)).toBeNull();
    expect(await mergedInto(ws, null)).toBeNull();
    expect(await mergedInto(ws, 'deadbeefdeadbeef')).toBeNull();

    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'delegate/d1');
    expect(await mergedInto(ws, delivered)).toBe('main');
    expect(await mergedInto({ ...ws, repoRoot: null }, delivered)).toBeNull();
  });
});
