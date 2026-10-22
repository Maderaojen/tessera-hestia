import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { Project } from '../../src/project-store.js';
import type { RepoTreeEntry } from '../../src/contract/repo.js';

// The project's file tree and file contents (phase 2), end to end against
// a real repo in a temp folder (git 2.43+ on the test host).

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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

let base: string;
let work: string;
let plain: string;
let outside: string;
let auth: string;

const api = (url: string) => request(createApp()).get(url).set('Authorization', auth);
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const names = (entries: RepoTreeEntry[]) => entries.map((entry) => entry.name);

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'hestia-tree-'));
  work = path.join(base, 'work');
  plain = path.join(base, 'plain');
  outside = path.join(base, 'outside');
  write(path.join(outside, 'secret.txt'), 'outside\n');
  write(path.join(plain, 'notes.md'), '# plain\n');
  write(path.join(plain, 'sub/inner.txt'), 'inner\n');
  write(path.join(plain, 'sub/.env'), 'SECRET=1\n');
  write(path.join(plain, 'sub/.env.example'), 'SECRET=\n');
  write(path.join(plain, 'sub/.aws/config'), '[default]\n');

  run(base, 'init', work);
  // A folder rule, a file rule, and a rule a tracked file also matches.
  write(path.join(work, '.gitignore'), 'build/\n*.log\nkeep.log\n');
  write(path.join(work, 'src/app.ts'), 'export const a = 1;\n');
  write(path.join(work, 'src/old.ts'), 'old\n');
  write(path.join(work, 'README.md'), 'readme\n');
  write(path.join(work, 'keep.log'), 'tracked anyway\n');
  write(path.join(work, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  run(work, 'add', '.');
  run(work, 'add', '-f', 'keep.log');
  run(work, 'commit', '-m', 'first');

  unlinkSync(path.join(work, 'src/old.ts'));
  write(path.join(work, 'build/out.js'), 'built\n');
  write(path.join(work, 'build/deep/more.js'), 'more\n');
  write(path.join(work, 'debug.log'), 'log\n');
  write(path.join(work, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  symlinkSync(outside, path.join(work, 'escape'));
  symlinkSync(path.join(work, 'src'), path.join(work, 'src-link'));
  symlinkSync(path.join(work, 'nowhere'), path.join(work, 'dangling'));
  // A nested repo of its own.
  run(work, 'init', path.join(work, 'vendor/lib'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
  store.project = {
    id: 'p1', name: 'proj', createdAt: '2026-10-01T00:00:00.000Z', deletedAt: null,
    paths: [work, plain].map((p, i) => ({ path: p, primary: i === 0, addedAt: '2026-10-01T00:00:00.000Z' })),
  };
});

describe('GET /api/projects/:id/repo/tree', () => {
  it('requires auth', async () => {
    const res = await request(createApp()).get(`/api/projects/p1/repo/tree?${q({ root: work })}`);
    expect(res.status).toBe(401);
  });

  it('lists the root folders first, hides .git and ignored entries, keeps tracked files a rule matches', async () => {
    const res = await api(`/api/projects/p1/repo/tree?${q({ root: work })}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ root: work, dir: '', isRepo: true, truncated: false });
    const entries = res.body.entries as RepoTreeEntry[];
    expect(names(entries)).toEqual(['src', 'src-link', 'vendor', '.gitignore', 'big.txt', 'dangling', 'escape', 'image.bin', 'keep.log', 'README.md']);
    expect(entries.find((entry) => entry.name === 'keep.log')).toMatchObject({ type: 'file', ignored: false, size: 15 });
    expect(entries.find((entry) => entry.name === 'src-link')).toMatchObject({ type: 'symlink', linkTarget: 'dir' });
    expect(entries.find((entry) => entry.name === 'escape')).toMatchObject({ type: 'symlink', linkTarget: 'outside' });
    expect(entries.find((entry) => entry.name === 'dangling')).toMatchObject({ type: 'symlink', linkTarget: 'broken' });
  });

  it('shows ignored entries, marked, with ignored=1 — a folder rule matches the folder, and what is inside it', async () => {
    const res = await api(`/api/projects/p1/repo/tree?${q({ root: work, ignored: '1' })}`);
    const entries = res.body.entries as RepoTreeEntry[];
    expect(entries.find((entry) => entry.name === 'build')).toMatchObject({ type: 'dir', ignored: true });
    expect(entries.find((entry) => entry.name === 'debug.log')).toMatchObject({ ignored: true });
    expect(entries.find((entry) => entry.name === 'src')).toMatchObject({ ignored: false });

    const inside = await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: 'build', ignored: '1' })}`);
    expect(names(inside.body.entries)).toEqual(['deep', 'out.js']);
    expect((inside.body.entries as RepoTreeEntry[]).every((entry) => entry.ignored)).toBe(true);
  });

  it('marks a nested repo as a submodule', async () => {
    const res = await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: 'vendor' })}`);
    expect(res.body.entries).toEqual([{ name: 'lib', path: 'vendor/lib', type: 'submodule', size: null, ignored: false }]);
  });

  it('lists a subfolder by its path', async () => {
    const res = await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: 'src' })}`);
    expect(res.body.entries).toEqual([{ name: 'app.ts', path: 'src/app.ts', type: 'file', size: 20, ignored: false }]);
  });

  it('works outside a git work tree too', async () => {
    const res = await api(`/api/projects/p1/repo/tree?${q({ root: plain })}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isRepo: false, entries: [{ name: 'sub', type: 'dir', ignored: false }, { name: 'notes.md', type: 'file' }] });
  });

  it('refuses paths out of the root, into .git, through an outward symlink, or that aren\'t folders', async () => {
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: '../outside' })}`)).body.code).toBe('path_outside_project');
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: '.git' })}`)).body.code).toBe('path_outside_project');
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: 'escape' })}`)).body.code).toBe('path_outside_project');
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: 'README.md' })}`)).body.code).toBe('path_not_a_directory');
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: work, dir: 'nope' })}`)).body.code).toBe('path_not_found');
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: outside })}`)).body.code).toBe('repo_root_unknown');
  });
});

describe('GET /api/projects/:id/repo/file', () => {
  it('reads a text file from the work tree', async () => {
    const res = await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'src/app.ts' })}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: 'src/app.ts', rev: null, size: 20, binary: false, tooLarge: false, text: 'export const a = 1;\n' });
  });

  it('says binary and too large instead of sending them', async () => {
    const binary = await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'image.bin' })}`);
    expect(binary.body).toMatchObject({ binary: true, text: null, size: 7 });
    const big = await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'big.txt' })}`);
    expect(big.body).toMatchObject({ tooLarge: true, text: null, size: 1024 * 1024 + 1 });
  });

  it('opens an ignored file too', async () => {
    const res = await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'debug.log' })}`);
    expect(res.body.text).toBe('log\n');
  });

  it('reads a deleted file\'s last version with rev=HEAD', async () => {
    const missing = await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'src/old.ts' })}`);
    expect(missing.body.code).toBe('path_not_found');
    const res = await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'src/old.ts', rev: 'HEAD' })}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: 'src/old.ts', text: 'old\n', binary: false });
    expect(res.body.rev).toMatch(/^[0-9a-f]{40}$/);
    expect((await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'debug.log', rev: 'HEAD' })}`)).body.code).toBe('path_not_found');
  });

  it('refuses a bad rev, a folder, and paths out of the root', async () => {
    expect((await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'README.md', rev: 'main~1' })}`)).body.code).toBe('invalid_request');
    expect((await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'src' })}`)).body.code).toBe('invalid_request');
    expect((await api(`/api/projects/p1/repo/file?${q({ root: work, path: 'escape/secret.txt' })}`)).body.code).toBe('path_outside_project');
    expect((await api(`/api/projects/p1/repo/file?${q({ root: work, path: '.git/config' })}`)).body.code).toBe('path_outside_project');
    expect((await api(`/api/projects/p1/repo/file?${q({ root: plain, path: 'notes.md', rev: 'HEAD' })}`)).body.code).toBe('not_a_git_repo');
  });

  it('reads a file outside a git work tree', async () => {
    const res = await api(`/api/projects/p1/repo/file?${q({ root: plain, path: 'sub/inner.txt' })}`);
    expect(res.body.text).toBe('inner\n');
  });

  it('lists files that may hold secrets marked, never opens them (path_sensitive)', async () => {
    const tree = await api(`/api/projects/p1/repo/tree?${q({ root: plain, dir: 'sub' })}`);
    const entries = tree.body.entries as RepoTreeEntry[];
    expect(entries.find((entry) => entry.name === '.env')).toMatchObject({ type: 'file', sensitive: true });
    expect(entries.find((entry) => entry.name === '.aws')).toMatchObject({ type: 'dir', sensitive: true });
    expect(entries.find((entry) => entry.name === '.env.example')!.sensitive).toBeUndefined();
    expect(entries.find((entry) => entry.name === 'inner.txt')!.sensitive).toBeUndefined();
    expect(JSON.stringify(tree.body)).not.toContain('SECRET');
    const file = await api(`/api/projects/p1/repo/file?${q({ root: plain, path: 'sub/.env' })}`);
    expect([file.status, file.body.code]).toEqual([403, 'path_sensitive']);
    expect((await api(`/api/projects/p1/repo/file?${q({ root: plain, path: 'sub/.aws/config' })}`)).body.code).toBe('path_sensitive');
    expect((await api(`/api/projects/p1/repo/tree?${q({ root: plain, dir: 'sub/.aws' })}`)).body.code).toBe('path_sensitive');
    expect((await api(`/api/projects/p1/repo/file?${q({ root: plain, path: 'sub/.env.example' })}`)).body.text).toBe('SECRET=\n');
  });
});
