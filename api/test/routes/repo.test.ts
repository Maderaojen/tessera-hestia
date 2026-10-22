import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { Project } from '../../src/project-store.js';

// The project files and git view, end to end against real repos in a temp
// folder (git 2.43+ on the test host).

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab'],
}));

const store = vi.hoisted(() => ({ project: null as Project | null }));
vi.mock('../../src/project-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/project-store.js')>();
  return { ...actual, getProject: vi.fn(async (id: string) => (store.project?.id === id ? store.project : undefined)) };
});

// A delegation's or branch line's worktree of the project (spawn/roots.ts).
const spawned = vi.hoisted(() => ({ roots: [] as { path: string; kind: 'delegation' | 'fork'; id: string; title: string; branch: string | null }[] }));
vi.mock('../../src/spawn/roots.js', () => ({ spawnRoots: vi.fn(async () => spawned.roots), spawned: vi.fn(async () => []) }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

let base: string;
let work: string; // a clone of `remote`, ahead of it, with changes
let solo: string; // no remote at all
let fresh: string; // no commit yet
let plain: string; // not a repo
let outside: string;
let mergeSha: string;
let rootSha: string;
let auth: string;

function useProject(...paths: string[]): void {
  store.project = {
    id: 'p1', name: 'proj', createdAt: '2026-10-01T00:00:00.000Z', deletedAt: null,
    paths: paths.map((p, i) => ({ path: p, primary: i === 0, addedAt: '2026-10-01T00:00:00.000Z' })),
  };
}

const api = (url: string) => request(createApp()).get(url).set('Authorization', auth);
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'hestia-repo-'));
  const remote = path.join(base, 'remote.git');
  work = path.join(base, 'work');
  solo = path.join(base, 'solo');
  fresh = path.join(base, 'fresh');
  plain = path.join(base, 'plain');
  outside = path.join(base, 'outside');
  mkdirSync(plain);
  write(path.join(outside, 'secret.txt'), 'outside\n');

  run(base, 'init', '--bare', remote);
  run(base, 'init', work);
  write(path.join(work, 'README.md'), 'one\ntwo\nthree\n');
  write(path.join(work, 'app/src/app.ts'), 'export const a = 1;\n');
  write(path.join(work, 'gone.txt'), 'bye\n');
  run(work, 'add', '.');
  run(work, 'commit', '-m', 'first');
  rootSha = run(work, 'rev-parse', 'HEAD').trim();
  run(work, 'remote', 'add', 'origin', remote);
  run(work, 'push', '-u', 'origin', 'main');

  // A merge from a side branch, then one more: two commits not pushed.
  run(work, 'switch', '-c', 'feat');
  write(path.join(work, 'feat.txt'), 'feature\n');
  write(path.join(work, 'api/server.ts'), 'server\n');
  run(work, 'add', '.');
  run(work, 'commit', '-m', 'feature work');
  run(work, 'switch', 'main');
  run(work, 'merge', '--no-ff', '-m', 'Merge feat', 'feat');
  mergeSha = run(work, 'rev-parse', 'HEAD').trim();

  // Uncommitted: modified, staged new, untracked file and folder, deleted.
  write(path.join(work, 'README.md'), 'one\nTWO\nthree\n');
  write(path.join(work, 'staged.txt'), 'staged\n');
  run(work, 'add', 'staged.txt');
  write(path.join(work, 'notes.txt'), 'untracked\n');
  write(path.join(work, 'build/out.js'), 'x\n');
  unlinkSync(path.join(work, 'gone.txt'));
  symlinkSync(outside, path.join(work, 'escape'));

  run(base, 'init', solo);
  write(path.join(solo, 'a.txt'), 'a\n');
  run(solo, 'add', '.');
  run(solo, 'commit', '-m', 'solo');

  run(base, 'init', fresh);
  write(path.join(fresh, 'first.txt'), 'hello\n');
  run(fresh, 'add', '.');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
  useProject(work, solo, fresh, plain, path.join(base, 'missing'));
});

describe('GET /api/projects/:id/repos', () => {
  it('requires auth', async () => {
    const res = await request(createApp()).get('/api/projects/p1/repos');
    expect(res.status).toBe(401);
  });

  it('describes each of the project\'s paths', async () => {
    const res = await api('/api/projects/p1/repos');
    expect(res.status).toBe(200);
    const [w, s, f, p, m] = res.body.roots;
    expect(w).toMatchObject({ path: work, primary: true, exists: true, repoError: null, repo: { prefix: '', branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 0 } } });
    // README, staged, notes, build/, gone — and the symlink, untracked too.
    expect(w.repo.changedCount).toBe(6);
    expect(s.repo.branch.upstream).toBeNull();
    expect(f.repo.branch).toMatchObject({ unborn: true, head: 'main', oid: null });
    expect(p).toMatchObject({ exists: true, repo: null });
    expect(m).toMatchObject({ exists: false, repo: null });
  });

  it('lists the project\'s delegation and branch line worktrees after its paths, and reads them', async () => {
    useProject(work);
    spawned.roots = [{ path: solo, kind: 'delegation', id: 'd1', title: 'Fix the bar', branch: 'delegate/fix-the-bar' }];
    try {
      const res = await api('/api/projects/p1/repos');
      expect(res.body.roots.map((root: { path: string; spawn: unknown }) => [root.path, root.spawn])).toEqual([
        [work, null],
        [solo, { kind: 'delegation', id: 'd1', title: 'Fix the bar', branch: 'delegate/fix-the-bar' }],
      ]);
      expect(res.body.roots[1]).toMatchObject({ primary: false, exists: true, repo: { prefix: '' } });
      expect((await api(`/api/projects/p1/repo/status?${q({ root: solo })}`)).status).toBe(200);
      // Gone from its records (cleaned up): no longer readable.
      spawned.roots = [];
      expect((await api(`/api/projects/p1/repo/status?${q({ root: solo })}`)).body.code).toBe('repo_root_unknown');
    } finally {
      spawned.roots = [];
      useProject(work, solo, fresh, plain, path.join(base, 'missing'));
    }
  });

  it('an unknown project is project_not_found', async () => {
    const res = await api('/api/projects/nope/repos');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('project_not_found');
  });
});

describe('GET /api/projects/:id/repo/worktrees', () => {
  it('lists the root\'s repo\'s worktrees, opening only the project\'s own roots', async () => {
    const other = path.join(base, 'solo-other');
    run(solo, 'worktree', 'add', '-q', '-b', 'other', other);
    try {
      const res = await api(`/api/projects/p1/repo/worktrees?${q({ root: solo })}`);
      expect(res.status).toBe(200);
      const real = realpathSync(solo);
      expect(res.body.worktrees.map((entry: { path: string; main: boolean; current: boolean; root: string | null }) => [entry.path, entry.main, entry.current, entry.root])).toEqual([
        [real, true, true, solo],
        [realpathSync(other), false, false, null],
      ]);
      expect(res.body).toMatchObject({ endedKept: 0, endedKeptWarnAt: 5 });
      // The other worktree is listed, not read.
      expect((await api(`/api/projects/p1/repo/worktrees?${q({ root: other })}`)).body.code).toBe('repo_root_unknown');
    } finally {
      run(solo, 'worktree', 'remove', other);
      run(solo, 'branch', '-D', 'other');
    }
  });

  it('is not_a_git_repo outside one, and needs a root', async () => {
    expect((await api(`/api/projects/p1/repo/worktrees?${q({ root: plain })}`)).body.code).toBe('not_a_git_repo');
    expect((await api('/api/projects/p1/repo/worktrees')).status).toBe(400);
  });
});

describe('GET /api/projects/:id/repo/status', () => {
  it('lists what isn\'t committed and what isn\'t pushed', async () => {
    const res = await api(`/api/projects/p1/repo/status?${q({ root: work })}`);
    expect(res.status).toBe(200);
    const byPath = Object.fromEntries(res.body.files.map((file: { path: string }) => [file.path, file]));
    expect(byPath['README.md']).toMatchObject({ staged: null, unstaged: 'modified' });
    expect(byPath['staged.txt']).toMatchObject({ staged: 'added', unstaged: null });
    expect(byPath['notes.txt']).toMatchObject({ unstaged: 'untracked' });
    expect(byPath['build/']).toMatchObject({ unstaged: 'untracked' });
    expect(byPath['gone.txt']).toMatchObject({ unstaged: 'deleted' });
    expect(res.body.unpushedBase).toBe('upstream');
    expect(res.body.unpushed.map((commit: { subject: string }) => commit.subject)).toEqual(['Merge feat', 'feature work']);
    expect(res.body.lastFetchAt).toBeNull();
    expect(res.body.refsFingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it('after a fetch, says when', async () => {
    run(work, 'fetch', 'origin');
    const res = await api(`/api/projects/p1/repo/status?${q({ root: work })}`);
    expect(Date.parse(res.body.lastFetchAt)).not.toBeNaN();
  });

  it('with no upstream, counts against the remotes; with no remote, nothing', async () => {
    run(work, 'switch', '-c', 'local-only');
    try {
      const res = await api(`/api/projects/p1/repo/status?${q({ root: work })}`);
      expect(res.body.unpushedBase).toBe('remotes');
      expect(res.body.unpushed).toHaveLength(2);
    } finally {
      run(work, 'switch', 'main');
    }
    const soloRes = await api(`/api/projects/p1/repo/status?${q({ root: solo })}`);
    expect(soloRes.body).toMatchObject({ unpushedBase: 'none', unpushed: [] });
  });

  it('a project path inside a repo sees only its own part, relative to it', async () => {
    useProject(path.join(work, 'app'));
    write(path.join(work, 'app/src/app.ts'), 'export const a = 2;\n');
    try {
      const res = await api(`/api/projects/p1/repo/status?${q({ root: path.join(work, 'app') })}`);
      expect(res.body.prefix).toBe('app/');
      expect(res.body.files.map((file: { path: string }) => file.path)).toEqual(['src/app.ts']);
    } finally {
      run(work, 'checkout', '--', 'app/src/app.ts');
    }
  });

  it('refuses what isn\'t a repo, a path not in the project, a project gone', async () => {
    expect((await api(`/api/projects/p1/repo/status?${q({ root: plain })}`)).body.code).toBe('not_a_git_repo');
    const unknown = await api(`/api/projects/p1/repo/status?${q({ root: outside })}`);
    expect([unknown.status, unknown.body.code]).toEqual([400, 'repo_root_unknown']);
    const missing = await api(`/api/projects/p1/repo/status?${q({ root: path.join(base, 'missing') })}`);
    expect([missing.status, missing.body.code]).toEqual([404, 'folder_not_found']);
    expect((await api(`/api/projects/nope/repo/status?${q({ root: work })}`)).body.code).toBe('project_not_found');
    expect((await api('/api/projects/p1/repo/status')).body.code).toBe('invalid_request');
  });

  it('a repo before its first commit', async () => {
    const res = await api(`/api/projects/p1/repo/status?${q({ root: fresh })}`);
    expect(res.body.branch.unborn).toBe(true);
    expect(res.body.files).toEqual([expect.objectContaining({ path: 'first.txt', staged: 'added' })]);
  });
});

describe('GET /api/projects/:id/repo/diff', () => {
  const diff = (params: Record<string, string>) => api(`/api/projects/p1/repo/diff?${q({ root: work, ...params })}`);

  it('a modified file against HEAD, both sides numbered', async () => {
    const res = await diff({ path: 'README.md' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: 'README.md', mode: 'worktree', status: 'modified', binary: false });
    expect(res.body.hunks[0].lines).toEqual([
      { kind: 'context', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2, newNo: null },
      { kind: 'add', text: 'TWO', oldNo: null, newNo: 2 },
      { kind: 'context', text: 'three', oldNo: 3, newNo: 3 },
    ]);
  });

  it('staged, untracked, an untracked folder, a deleted file', async () => {
    expect((await diff({ path: 'staged.txt', mode: 'staged' })).body.status).toBe('added');
    const untracked = await diff({ path: 'notes.txt' });
    expect(untracked.body).toMatchObject({ status: 'untracked', hunks: [{ lines: [{ kind: 'add', text: 'untracked' }] }] });
    expect((await diff({ path: 'build/' })).body).toMatchObject({ status: 'untracked', hunks: [] });
    expect((await diff({ path: 'gone.txt' })).body).toMatchObject({ status: 'deleted', hunks: [{ lines: [{ kind: 'del', text: 'bye' }] }] });
  });

  it('a file in a commit, and the first commit', async () => {
    const merged = await diff({ path: 'feat.txt', mode: 'commit', commit: mergeSha });
    expect(merged.body).toMatchObject({ status: 'added', hunks: [{ lines: [{ kind: 'add', text: 'feature' }] }] });
    const first = await diff({ path: 'README.md', mode: 'commit', commit: rootSha });
    expect(first.body.status).toBe('added');
  });

  it('a repo before its first commit diffs against nothing', async () => {
    const res = await api(`/api/projects/p1/repo/diff?${q({ root: fresh, path: 'first.txt' })}`);
    expect(res.body).toMatchObject({ status: 'added', hunks: [{ lines: [{ kind: 'add', text: 'hello' }] }] });
  });

  it('never leaves the project path: .., absolute, .git, a symlink out', async () => {
    for (const target of ['../outside/secret.txt', '/etc/passwd', '.git/config', 'escape/secret.txt']) {
      const res = await diff({ path: target });
      expect([target, res.status, res.body.code]).toEqual([target, 403, 'path_outside_project']);
    }
  });

  it('mode=commit needs a commit, which has to exist', async () => {
    expect((await diff({ path: 'a', mode: 'commit' })).body.code).toBe('invalid_request');
    expect((await diff({ path: 'a', mode: 'commit', commit: 'not-a-sha' })).body.code).toBe('invalid_request');
    const missing = await diff({ path: 'a', mode: 'commit', commit: 'deadbeef' });
    expect([missing.status, missing.body.code]).toEqual([404, 'commit_not_found']);
  });
});

describe('GET /api/projects/:id/repo/commit', () => {
  it('a merge, against its first parent', async () => {
    const res = await api(`/api/projects/p1/repo/commit?${q({ root: work, sha: mergeSha.slice(0, 10) })}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sha: mergeSha, subject: 'Merge feat', message: 'Merge feat', authorName: 'Test User', filesTruncated: false });
    expect(res.body.parents).toHaveLength(2);
    expect(res.body.files.map((file: { path: string; additions: number }) => [file.path, file.additions]).sort()).toEqual([['api/server.ts', 1], ['feat.txt', 1]]);
  });

  it('from a project path inside the repo, files elsewhere are ../ and marked', async () => {
    useProject(path.join(work, 'app'));
    const res = await api(`/api/projects/p1/repo/commit?${q({ root: path.join(work, 'app'), sha: rootSha })}`);
    const files = Object.fromEntries(res.body.files.map((file: { path: string; outsideRoot: boolean }) => [file.path, file.outsideRoot]));
    expect(files).toEqual({ '../README.md': true, '../gone.txt': true, 'src/app.ts': false });
  });

  it('an unknown commit', async () => {
    const res = await api(`/api/projects/p1/repo/commit?${q({ root: work, sha: '0123456789abcdef' })}`);
    expect([res.status, res.body.code]).toEqual([404, 'commit_not_found']);
  });
});
