import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Where a repo's new delegation and branch line worktrees go.

let dir: string;
let repo: string;
let workspace: typeof import('../../src/spawn/workspace.js');

beforeEach(async () => {
  vi.resetModules();
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hestia-wt-home-')));
  process.env.HESTIA_STATE_DIR = path.join(dir, 'state');
  repo = path.join(dir, 'parent', 'proj');
  await mkdir(repo, { recursive: true });
  workspace = await import('../../src/spawn/workspace.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await chmod(path.join(dir, 'parent'), 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('worktreesHome', () => {
  const fallback = () => path.join(dir, 'data', 'worktrees');

  it('puts them in one folder beside the repo', async () => {
    expect(await workspace.worktreesHome(repo, { configured: null, fallback: fallback() })).toBe(path.join(dir, 'parent', 'proj-worktrees'));
  });

  it('takes the configured folder, unless it is somewhere the git panel never reads', async () => {
    const configured = path.join(dir, 'mine');
    expect(await workspace.worktreesHome(repo, { configured, fallback: fallback() })).toBe(configured);
    const underState = path.join(dir, 'state', 'worktrees');
    expect(await workspace.worktreesHome(repo, { configured: underState, fallback: fallback() })).toBe(path.join(dir, 'parent', 'proj-worktrees'));
  });

  it('falls back outside the state dir when the repo\'s parent can\'t be written, but uses a writable folder already there', async () => {
    await chmod(path.join(dir, 'parent'), 0o555);
    expect(await workspace.worktreesHome(repo, { configured: null, fallback: fallback() })).toBe(fallback());
    await chmod(path.join(dir, 'parent'), 0o755);
    await mkdir(path.join(dir, 'parent', 'proj-worktrees'));
    await chmod(path.join(dir, 'parent'), 0o555);
    expect(await workspace.worktreesHome(repo, { configured: null, fallback: fallback() })).toBe(path.join(dir, 'parent', 'proj-worktrees'));
  });

  it('refuses rather than fall back under the state dir', async () => {
    await chmod(path.join(dir, 'parent'), 0o555);
    await expect(workspace.worktreesHome(repo, { configured: null, fallback: path.join(dir, 'state', 'worktrees') })).rejects.toThrow(/HESTIA_WORKTREES_DIR/);
  });
});
