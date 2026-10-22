import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Delegation } from '../../src/contract/delegation.js';
import { delegationPorts } from '../../src/delegation/wiring.js';
import { branchExists, currentBranch } from '../../src/git/worktree.js';

// A delegation's worktree against a real git repo in a temp folder.

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'delegation-ws-')));
  repo = path.join(root, 'proj');
  await mkdir(path.join(repo, 'api'), { recursive: true });
  await writeFile(path.join(repo, 'api', 'index.ts'), 'export {};\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const plan = (parentCwd: string, isolation: 'worktree' | 'shared' = 'worktree') => (
  delegationPorts.planWorkspace({ id: 'ab12cd34', branch: 'delegate/ab12cd34-json', parentCwd, isolation })
);

describe('a delegation\'s workspace', () => {
  it('plans a worktree in the folder beside the repo, in the same subfolder, from the current HEAD', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await plan(path.join(repo, 'api'))).toEqual({
      isolation: 'worktree',
      repoRoot: repo,
      path: path.join(root, 'proj-worktrees', 'proj-delegate-ab12cd34', 'api'),
      worktree: path.join(root, 'proj-worktrees', 'proj-delegate-ab12cd34'),
      branch: 'delegate/ab12cd34-json',
      baseCommit: head,
      headAtDelivery: null,
    });
  });

  it('makes it on a new branch, takes it as it is a second time, and reads whether its work is committed', async () => {
    const workspace = await plan(path.join(repo, 'api'));
    await delegationPorts.ensureWorkspace(workspace);
    await delegationPorts.ensureWorkspace(workspace);
    expect(await currentBranch(workspace.worktree!)).toBe('delegate/ab12cd34-json');
    expect(await delegationPorts.workspaceState(workspace)).toEqual({ clean: true, head: workspace.baseCommit });

    // The brief and its folder never count as uncommitted work.
    const delegation = { id: 'ab12cd34', workspace, briefFile: path.join(workspace.path, '.hestia', 'delegations', 'ab12cd34', 'brief.md') } as Delegation;
    await delegationPorts.writeBrief(delegation, '# brief');
    expect((await delegationPorts.workspaceState(workspace)).clean).toBe(true);

    await writeFile(path.join(workspace.path, 'new.ts'), 'export const x = 1;\n');
    expect((await delegationPorts.workspaceState(workspace)).clean).toBe(false);
    git(workspace.path, 'add', '.');
    git(workspace.path, 'commit', '-q', '-m', 'work');
    const after = await delegationPorts.workspaceState(workspace);
    expect(after.clean).toBe(true);
    expect(after.head).not.toBe(workspace.baseCommit);
    // The delegating session's own checkout is untouched.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('refuses a folder already there on another branch', async () => {
    const workspace = await plan(path.join(repo, 'api'));
    await mkdir(workspace.worktree!, { recursive: true });
    await expect(delegationPorts.ensureWorkspace(workspace)).rejects.toThrow(/already exists/);
  });

  it('tells whether the delegating folder has uncommitted changes', async () => {
    expect(await delegationPorts.parentDirty(repo)).toBe(false);
    await writeFile(path.join(repo, 'api', 'index.ts'), 'export const changed = 1;\n');
    expect(await delegationPorts.parentDirty(repo)).toBe(true);
  });

  it('shares the folder when it is not a git repo, when asked, or with no commit to branch from', async () => {
    const plain = path.join(root, 'plain');
    await mkdir(plain);
    expect(await plan(plain)).toMatchObject({ isolation: 'shared', repoRoot: null, path: plain, branch: null, worktree: null });
    expect(await plan(path.join(repo, 'api'), 'shared')).toMatchObject({ isolation: 'shared', repoRoot: repo, path: path.join(repo, 'api'), branch: null });
    const empty = path.join(root, 'empty');
    await mkdir(empty);
    git(empty, 'init', '-q');
    expect(await plan(empty)).toMatchObject({ isolation: 'shared', baseCommit: null });
    expect(await delegationPorts.workspaceState(await plan(plain))).toEqual({ clean: true, head: null });
  });
});

describe('cleaning up a delegation\'s worktree', () => {
  const exists = (target: string) => stat(target).then(() => true, () => false);

  async function made() {
    const workspace = await plan(path.join(repo, 'api'));
    await delegationPorts.ensureWorkspace(workspace);
    // The brief and dependencies a delegate installed are ignored, and don't keep it.
    const delegation = { id: 'ab12cd34', workspace, briefFile: path.join(workspace.path, '.hestia', 'delegations', 'ab12cd34', 'brief.md') } as Delegation;
    await delegationPorts.writeBrief(delegation, '# brief');
    await writeFile(path.join(workspace.path, 'new.ts'), 'export const x = 1;\n');
    git(workspace.path, 'add', '.');
    git(workspace.path, 'commit', '-q', '-m', 'work');
    return workspace;
  }

  it('keeps a worktree with uncommitted work', async () => {
    const workspace = await made();
    expect(await delegationPorts.workspaceRemovable(workspace, { deleteBranch: false })).toBeNull();
    await writeFile(path.join(workspace.path, 'more.ts'), 'export {};\n');
    // Asked before the delegate's tmux is closed, and again when removing.
    expect(await delegationPorts.workspaceRemovable(workspace, { deleteBranch: false })).toMatchObject({ ok: false, code: 'workspace_dirty' });
    expect(await delegationPorts.removeWorkspace(workspace, { deleteBranch: false })).toMatchObject({ ok: false, code: 'workspace_dirty' });
    expect(await exists(workspace.worktree!)).toBe(true);
  });

  it('removes a clean one, keeping its branch', async () => {
    const workspace = await made();
    expect(await delegationPorts.removeWorkspace(workspace, { deleteBranch: false })).toEqual({ ok: true, removed: true, branchDeleted: false });
    expect(await exists(workspace.worktree!)).toBe(false);
    expect(await branchExists(repo, workspace.branch!)).toBe(true);
  });

  it('deletes the branch only once merged, refusing before removing anything', async () => {
    const workspace = await made();
    expect(await delegationPorts.workspaceRemovable(workspace, { deleteBranch: true })).toMatchObject({ ok: false, code: 'branch_not_merged' });
    expect(await delegationPorts.removeWorkspace(workspace, { deleteBranch: true })).toMatchObject({ ok: false, code: 'branch_not_merged' });
    expect(await exists(workspace.worktree!)).toBe(true);
    git(repo, 'merge', '-q', '--no-edit', workspace.branch!);
    expect(await delegationPorts.removeWorkspace(workspace, { deleteBranch: true })).toEqual({ ok: true, removed: true, branchDeleted: true });
    expect(await exists(workspace.worktree!)).toBe(false);
    expect(await branchExists(repo, workspace.branch!)).toBe(false);
  });

  it('forgets a worktree removed by hand, and deletes the branch later', async () => {
    const workspace = await made();
    await rm(workspace.worktree!, { recursive: true, force: true });
    expect(await delegationPorts.removeWorkspace(workspace, { deleteBranch: false })).toEqual({ ok: true, removed: true, branchDeleted: false });
    expect(git(repo, 'worktree', 'list')).not.toContain('proj-delegate-ab12cd34');
    git(repo, 'merge', '-q', '--no-edit', workspace.branch!);
    const removed = { ...workspace, removedAt: '2026-10-06T10:00:00.000Z' };
    expect(await delegationPorts.removeWorkspace(removed, { deleteBranch: true })).toEqual({ ok: true, removed: false, branchDeleted: true });
  });
});
