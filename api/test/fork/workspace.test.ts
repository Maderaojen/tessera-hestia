import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForkEngine, decodeForkState, emptyForkState } from '../../src/fork/engine.js';
import { forkPorts } from '../../src/fork/wiring.js';
import { branchExists } from '../../src/git/worktree.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { fakePorts, newWorld } from './fake-ports.js';

// A branch line's worktree against a real git repo in a temp folder: made,
// briefed, and on close removed only when its branch is merged and clean.

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

const exists = (target: string) => stat(target).then(() => true, () => false);

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fork-ws-')));
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

// The engine with git, the brief and the worktree for real, the rest in memory.
function makeEngine(parentCwd: string, id: string) {
  const world = newWorld();
  world.ids = [id];
  world.parents.set('main', { ...world.parents.get('main')!, cwd: parentCwd });
  const ports = {
    ...fakePorts(world),
    planWorkspace: forkPorts.planWorkspace,
    ensureWorkspace: forkPorts.ensureWorkspace,
    parentDirtyFiles: forkPorts.parentDirtyFiles,
    writeBrief: forkPorts.writeBrief,
    workspaceRemovable: forkPorts.workspaceRemovable,
    removeWorkspace: forkPorts.removeWorkspace,
  };
  const engine = createForkEngine(ports, jsonFileStore({ path: path.join(root, 'fork.json'), empty: emptyForkState, decode: decodeForkState }));
  return { engine, world };
}

async function made(parentCwd: string, id = 'f1f1f1f1') {
  const { engine, world } = makeEngine(parentCwd, id);
  const result = await engine.startFork({ parentSessionId: 'main', title: 'Try layout' });
  if (!result.ok) throw new Error(result.message);
  await engine.advance(); // workspace: worktree and brief
  return { engine, world, fork: result.fork };
}

describe('a branch line\'s workspace', () => {
  it('opens a worktree beside the repo on its own branch, with the brief ignored by git and the main line\'s changes listed', async () => {
    await writeFile(path.join(repo, 'api', 'index.ts'), 'export const changed = 1;\n');
    const { fork } = await made(path.join(repo, 'api'));
    const worktree = path.join(root, 'proj-worktrees', `proj-fork-${fork.id}`);
    expect(fork.workspace).toMatchObject({ isolation: 'worktree', worktree, path: path.join(worktree, 'api'), branch: `fork/${fork.id}-try-layout`, repoRoot: repo });
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`fork/${fork.id}-try-layout`);
    const brief = await readFile(fork.briefFile, 'utf8');
    expect(brief).toContain('- `api/index.ts`（modified）');
    // The uncommitted change stays in the main line.
    expect(await readFile(path.join(worktree, 'api', 'index.ts'), 'utf8')).toBe('export {};\n');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('removes the worktree and branch when the branch has nothing unmerged (no commits at all, too)', async () => {
    const { engine, fork } = await made(path.join(repo, 'api'));
    const result = await engine.close(fork.id, {});
    expect(result).toMatchObject({ ok: true, outcome: { workspace: 'removed' } });
    expect(await exists(fork.workspace.worktree!)).toBe(false);
    expect(await branchExists(repo, fork.workspace.branch!)).toBe(false);
  });

  it('removes them once the branch is merged', async () => {
    const { engine, fork } = await made(path.join(repo, 'api'));
    const worktree = fork.workspace.worktree!;
    await writeFile(path.join(worktree, 'api', 'new.ts'), 'export {};\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'branch work');
    git(repo, 'merge', '-q', '--ff-only', fork.workspace.branch!);
    expect(await engine.close(fork.id, {})).toMatchObject({ ok: true, outcome: { workspace: 'removed' } });
    expect(await branchExists(repo, fork.workspace.branch!)).toBe(false);
  });

  it('keeps an unmerged branch, and uncommitted work, with the reason', async () => {
    const unmerged = await made(path.join(repo, 'api'));
    const worktree = unmerged.fork.workspace.worktree!;
    await writeFile(path.join(worktree, 'api', 'new.ts'), 'export {};\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'branch work');
    expect(await unmerged.engine.close(unmerged.fork.id, {})).toMatchObject({ ok: true, outcome: { workspace: 'kept', keptReason: 'branch_not_merged' } });
    expect(await exists(worktree)).toBe(true);
    expect(await branchExists(repo, unmerged.fork.workspace.branch!)).toBe(true);

    const dirty = await made(path.join(repo, 'api'), 'f2f2f2f2');
    await writeFile(path.join(dirty.fork.workspace.worktree!, 'api', 'index.ts'), 'export const wip = 1;\n');
    expect(await dirty.engine.close(dirty.fork.id, {})).toMatchObject({ ok: true, outcome: { workspace: 'kept', keptReason: 'workspace_dirty' } });
    expect(await exists(dirty.fork.workspace.worktree!)).toBe(true);
  });

  it('shares the main line\'s folder outside git, and leaves it alone on close', async () => {
    const plain = path.join(root, 'notes');
    await mkdir(plain);
    const { engine, fork } = await made(plain);
    expect(fork.workspace).toMatchObject({ isolation: 'shared', path: plain, worktree: null, branch: null });
    expect(await readFile(path.join(plain, '.hestia', '.gitignore'), 'utf8')).toBe('*\n');
    expect(await engine.close(fork.id, {})).toMatchObject({ ok: true, outcome: { workspace: 'shared' } });
    expect(await exists(plain)).toBe(true);
  });
});
