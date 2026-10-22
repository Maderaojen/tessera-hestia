import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { Project } from '../../src/project-store.js';
import type { RepoLogPage } from '../../src/contract/repo.js';

// The history the git graph draws (phase 3), against real repos in a temp
// folder: local branches, their upstreams, the default branch, paging.

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

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8' });
}

let counter = 0;
function commit(cwd: string, message: string): string {
  counter += 1;
  writeFileSync(path.join(cwd, `f${counter}.txt`), `${counter}\n`);
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-m', message);
  return run(cwd, 'rev-parse', 'HEAD').trim();
}

let base: string;
let hist: string; // main + feat (merged) + zeta, with a remote
let detached: string; // HEAD detached on a commit of its own
let develop: string; // origin/HEAD names develop
let configured: string; // no remote; init.defaultBranch names base
let plainMain: string; // no remote, no config: main
let moving: string; // gets a new commit mid-paging
let auth: string;

function useProject(...paths: string[]): void {
  store.project = {
    id: 'p1', name: 'proj', createdAt: '2026-10-01T00:00:00.000Z', deletedAt: null,
    paths: paths.map((p, i) => ({ path: p, primary: i === 0, addedAt: '2026-10-01T00:00:00.000Z' })),
  };
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
async function log(root: string, params: Record<string, string> = {}) {
  return request(createApp()).get(`/api/projects/p1/repo/log?${q({ root, ...params })}`).set('Authorization', auth);
}
async function allPages(root: string, limit: number): Promise<RepoLogPage['commits']> {
  const commits: RepoLogPage['commits'] = [];
  let cursor: string | null = null;
  do {
    const res = await log(root, { limit: String(limit), ...(cursor ? { cursor } : {}) });
    expect(res.status).toBe(200);
    commits.push(...res.body.commits);
    cursor = res.body.nextCursor;
  } while (cursor);
  return commits;
}

let mergeSha: string;
let zetaSha: string;
let detachedSha: string;

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'hestia-log-'));
  const remote = path.join(base, 'remote.git');
  hist = path.join(base, 'hist');
  run(base, 'init', '--bare', remote);
  run(base, 'init', hist);
  commit(hist, 'first');
  run(hist, 'remote', 'add', 'origin', remote);
  run(hist, 'push', '-u', 'origin', 'main');
  run(hist, 'remote', 'set-head', 'origin', 'main');
  run(hist, 'switch', '-c', 'feat');
  commit(hist, 'feat one');
  commit(hist, 'feat two');
  run(hist, 'switch', 'main');
  commit(hist, 'main two');
  run(hist, 'merge', '--no-ff', '-m', 'Merge feat', 'feat');
  mergeSha = run(hist, 'rev-parse', 'HEAD').trim();
  // A branch whose upstream the remote has since dropped.
  run(hist, 'switch', '-c', 'old');
  commit(hist, 'old work');
  run(hist, 'push', '-u', 'origin', 'old');
  run(hist, 'push', 'origin', '--delete', 'old');
  run(hist, 'fetch', '--prune', 'origin');
  run(hist, 'switch', 'main');
  run(hist, 'switch', '-c', 'zeta');
  zetaSha = commit(hist, 'zeta');
  run(hist, 'switch', 'main');

  detached = path.join(base, 'detached');
  run(base, 'init', detached);
  commit(detached, 'one');
  commit(detached, 'two');
  run(detached, 'switch', '--detach', 'HEAD~1');
  detachedSha = commit(detached, 'off on its own');

  develop = path.join(base, 'develop');
  const developRemote = path.join(base, 'develop.git');
  run(base, 'init', '--bare', developRemote);
  run(base, 'init', develop);
  commit(develop, 'base');
  run(develop, 'switch', '-c', 'develop');
  run(develop, 'remote', 'add', 'origin', developRemote);
  run(develop, 'push', '-u', 'origin', 'develop', 'main');
  run(develop, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');

  configured = path.join(base, 'configured');
  run(base, 'init', configured);
  commit(configured, 'one');
  run(configured, 'branch', 'base');
  run(configured, 'config', 'init.defaultBranch', 'base');

  plainMain = path.join(base, 'plain');
  run(base, 'init', plainMain);
  commit(plainMain, 'one');
  run(plainMain, 'branch', 'other');

  moving = path.join(base, 'moving');
  mkdirSync(moving);
  run(base, 'init', moving);
  for (let i = 0; i < 4; i += 1) commit(moving, `m${i}`);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
  useProject(hist, detached, develop, configured, plainMain, moving);
});

describe('GET /api/projects/:id/repo/log', () => {
  it('requires auth', async () => {
    const res = await request(createApp()).get(`/api/projects/p1/repo/log?${q({ root: hist })}`);
    expect(res.status).toBe(401);
  });

  it('answers the local branches with the first page, upstreams and what no remote has', async () => {
    const res = await log(hist);
    expect(res.status).toBe(200);
    const page = res.body as RepoLogPage;
    expect(page.refs).not.toBeNull();
    const refs = page.refs!;
    expect(refs.head).toMatchObject({ branch: 'main' });
    expect(refs.defaultBranch).toBe('main');
    expect(refs.branches.map((branch) => branch.name)).toEqual(['feat', 'main', 'old', 'zeta']);
    const main = refs.branches.find((branch) => branch.name === 'main')!;
    expect(main).toMatchObject({ upstream: 'origin/main', ahead: 4, behind: 0, upstreamGone: false });
    expect(main.upstreamTip).toMatch(/^[0-9a-f]{40}$/);
    expect(refs.branches.find((branch) => branch.name === 'old')).toMatchObject({ upstream: 'origin/old', upstreamTip: null, ahead: null, upstreamGone: true });
    expect(refs.branches.find((branch) => branch.name === 'zeta')).toMatchObject({ upstream: null, upstreamTip: null });
    expect(refs.unpushedBase).toBe('remotes');
    expect(refs.unpushed).toContain(mergeSha);
    expect(refs.unpushed).toContain(zetaSha);
    // Every commit, children before parents.
    const shas = page.commits.map((c) => c.sha);
    expect(shas).toContain(zetaSha);
    for (const c of page.commits) for (const parent of c.parents) {
      if (shas.includes(parent)) expect(shas.indexOf(parent)).toBeGreaterThan(shas.indexOf(c.sha));
    }
    expect(page.nextCursor).toBeNull();
  });

  it('pages continuously: page by page is the whole history in the same order', async () => {
    const whole = (await log(hist)).body.commits.map((c: { sha: string }) => c.sha);
    const paged = (await allPages(hist, 2)).map((c) => c.sha);
    expect(paged).toEqual(whole);
    const second = await log(hist, { limit: '2' });
    expect(second.body.refs).not.toBeNull();
    const next = await log(hist, { limit: '2', cursor: second.body.nextCursor });
    expect(next.body.refs).toBeNull();
  });

  it('answers 409 repo_changed for a cursor from before a branch moved', async () => {
    const first = await log(moving, { limit: '2' });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    commit(moving, 'moved');
    const res = await log(moving, { limit: '2', cursor: first.body.nextCursor });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('repo_changed');
  });

  it('refuses a cursor it never handed out', async () => {
    const res = await log(hist, { cursor: 'bm90LWEtY3Vyc29y' });
    expect(res.status).toBe(400);
  });

  it('includes a detached HEAD\'s own commits', async () => {
    const res = await log(detached);
    expect(res.status).toBe(200);
    expect(res.body.refs.head).toEqual({ branch: null, oid: detachedSha });
    expect(res.body.commits.map((c: { sha: string }) => c.sha)).toContain(detachedSha);
    expect(res.body.commits).toHaveLength(3);
    expect(res.body.refs.unpushedBase).toBe('none');
  });

  it('tells the default branch: origin/HEAD, then init.defaultBranch, then main', async () => {
    expect((await log(develop)).body.refs.defaultBranch).toBe('develop');
    expect((await log(configured)).body.refs.defaultBranch).toBe('base');
    expect((await log(plainMain)).body.refs.defaultBranch).toBe('main');
  });

  it('answers not_a_git_repo for a folder that isn\'t one', async () => {
    const plain = path.join(base, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    useProject(plain);
    const res = await log(plain);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_a_git_repo');
  });
});
