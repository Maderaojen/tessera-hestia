import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastRecordedCwd, readWorkspace } from '../../src/sync/workspace.js';

let dir: string;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'hestia-workspace-')));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('lastRecordedCwd', () => {
  it('takes the last folder named: Claude on the entry, Codex in its payload', async () => {
    const file = path.join(dir, 'claude.jsonl');
    await writeFile(file, [
      JSON.stringify({ type: 'user', cwd: '/repo', gitBranch: 'main' }),
      JSON.stringify({ type: 'assistant', cwd: '/repo/.claude/worktrees/x', gitBranch: 'worktree-x' }),
      JSON.stringify({ type: 'summary' }),
      '{"type":"assistant","cwd":"/half-writ',
    ].join('\n'));
    expect(await lastRecordedCwd(file)).toBe('/repo/.claude/worktrees/x');

    const codex = path.join(dir, 'codex.jsonl');
    await writeFile(codex, [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/a' } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/b' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
    ].join('\n'));
    expect(await lastRecordedCwd(codex)).toBe('/b');
  });

  it('null when nothing names a folder, or the file is gone', async () => {
    const file = path.join(dir, 'none.jsonl');
    await writeFile(file, JSON.stringify({ type: 'user' }));
    expect(await lastRecordedCwd(file)).toBeNull();
    expect(await lastRecordedCwd(path.join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('readWorkspace', () => {
  it('the main checkout on its default branch, a linked worktree on another, a detached HEAD', async () => {
    const repo = path.join(dir, 'repo');
    run(dir, 'init', '-q', '-b', 'main', repo);
    run(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const tree = path.join(dir, 'tree');
    run(repo, 'worktree', 'add', '-q', '-b', 'feat-x', tree);

    expect(await readWorkspace(repo)).toEqual({ root: repo, branch: 'main', linkedWorktree: false, defaultBranch: true });
    expect(await readWorkspace(tree)).toEqual({ root: tree, branch: 'feat-x', linkedWorktree: true, defaultBranch: false });

    run(tree, 'checkout', '-q', '--detach');
    expect(await readWorkspace(tree)).toEqual({ root: tree, branch: null, linkedWorktree: true, defaultBranch: false });
  });

  it('null outside a checkout', async () => {
    expect(await readWorkspace(tmpdir())).toBeNull();
  });
});
