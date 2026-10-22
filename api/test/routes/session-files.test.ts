import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../src/auth.js';
import { STATE_DIR } from '../../src/config.js';
import { createApp } from '../../src/server.js';
import type { Project } from '../../src/project-store.js';
import type { FileRefResult } from '../../src/contract/session-files.js';
import type { ManagedSession } from '../../src/types.js';

// The chat's file links end to end, against
// real folders in a temp dir: which roots a session may read, what each
// path names there, and reading a file or an image.

vi.mock('../../src/registry.js', () => ({
  getSession: vi.fn(),
  getSessionRecord: vi.fn(),
  listSessions: vi.fn(async () => []),
  reconcile: vi.fn(async () => {}),
}));
const registry = await import('../../src/registry.js');

const store = vi.hoisted(() => ({ project: null as Project | null, spawnRoots: [] as { path: string; kind: 'delegation' | 'fork'; id: string; title: string; branch: string | null }[], spawned: [] as unknown[] }));
vi.mock('../../src/project-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/project-store.js')>();
  return { ...actual, getProject: vi.fn(async (id: string) => (store.project?.id === id ? store.project : undefined)) };
});
vi.mock('../../src/spawn/roots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spawn/roots.js')>();
  return { ...actual, spawnRoots: vi.fn(async () => store.spawnRoots), spawned: vi.fn(async () => store.spawned) };
});

const TOOL_TOKEN = 'tool-token-for-tests';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5c2e5d40000000049454e44ae426082', 'hex');

let base: string;
let project: string;
let other: string;
let cwd: string;
let spawnPath: string;
let worktree: string;
let elsewhere: string;
let login: string;

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const session = () => ({ id: 's1', cwd, projectId: 'p1', status: 'ready' }) as unknown as ManagedSession;
const refs = async (paths: string[], token = login) => request(createApp()).post('/api/sessions/s1/file-refs').set('Authorization', token).send({ paths });
const byInput = (body: { refs: FileRefResult[] }) => Object.fromEntries(body.refs.map((ref) => [ref.input, ref]));
const get = (url: string) => request(createApp()).get(url).set('Authorization', login);
const q = (target: string) => `path=${encodeURIComponent(target)}`;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hestia-session-files-')));
  project = path.join(base, 'project');
  other = path.join(base, 'other');
  cwd = path.join(base, 'cwd-outside-project');
  spawnPath = path.join(base, 'spawn/wt/sub');
  worktree = path.join(base, 'own-wt');
  elsewhere = path.join(base, 'elsewhere');
  write(path.join(project, 'src/a.ts'), 'export const a = 1;\n');
  write(path.join(project, 'README.md'), '# r\n');
  write(path.join(project, '.env'), 'SECRET=1\n');
  write(path.join(project, '.env.example'), 'SECRET=\n');
  write(path.join(project, 'keys/server.pem'), 'pem');
  write(path.join(project, '.git/config'), '[core]\n');
  write(path.join(project, 'img/logo.png'), PNG);
  write(path.join(project, 'img/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  write(path.join(project, 'img/page.html'), '<script>alert(1)</script>');
  write(path.join(project, 'img/huge.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  write(path.join(project, 'bin/blob.dat'), Buffer.from([0, 1, 2]));
  write(path.join(project, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  write(path.join(other, 'docs/b.md'), '# b\n');
  write(path.join(cwd, 'notes/c.md'), '# c\n');
  write(path.join(spawnPath, 'd.ts'), 'd\n');
  write(path.join(worktree, 'e.ts'), 'e\n');
  write(path.join(elsewhere, 'secret.txt'), 'outside\n');
  symlinkSync(elsewhere, path.join(project, 'escape'));
  symlinkSync(path.join(project, 'src'), path.join(project, 'src-link'));
  symlinkSync(path.join(project, '.env'), path.join(project, 'innocent.txt'));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path.join(STATE_DIR, 'auth.json'), '{}');
  symlinkSync(STATE_DIR, path.join(project, 'state'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  login = `Bearer ${auth.issueSessionToken()}`;
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  vi.mocked(registry.getSession).mockImplementation(async (id: string) => (id === 's1' ? session() : undefined));
  store.project = {
    id: 'p1', name: 'proj', createdAt: '2026-10-01T00:00:00.000Z', deletedAt: null,
    paths: [project, other].map((p, i) => ({ path: p, primary: i === 0, addedAt: '2026-10-01T00:00:00.000Z' })),
  };
  store.spawnRoots = [{ path: spawnPath, kind: 'fork', id: 'f1', title: 'fork', branch: 'b' }];
  store.spawned = [{
    kind: 'delegation', id: 'd1', title: 'mine', removed: false, status: 'running', ended: false, sessionId: 's1', sessionIds: ['s1'],
    workspace: { isolation: 'worktree', repoRoot: project, path: path.join(worktree), worktree, branch: 'x', baseCommit: null },
  }];
});

afterEach(() => {
  auth.__setLocalToolTokenForTests(null);
  vi.clearAllMocks();
});

describe('POST /api/sessions/:id/file-refs', () => {
  it('finds files in every allowed root: project paths, cwd outside the project, spawn roots, its own worktree', async () => {
    const res = await refs([
      path.join(project, 'src/a.ts'), `${path.join(other, 'docs/b.md')}:3`, path.join(cwd, 'notes/c.md'),
      path.join(spawnPath, 'd.ts'), `${path.join(worktree, 'e.ts')}#L2`, 'notes/c.md:4:2', 'src/a.ts', `file://${path.join(project, 'README.md')}`,
    ]);
    expect(res.status).toBe(200);
    const found = byInput(res.body);
    expect(found[path.join(project, 'src/a.ts')]).toEqual({
      input: path.join(project, 'src/a.ts'), status: 'file', root: project, path: path.join(project, 'src/a.ts'), relative: 'src/a.ts', repoRoot: true, size: 20, kind: 'text',
    });
    expect(found[`${path.join(other, 'docs/b.md')}:3`]).toMatchObject({ status: 'file', root: other, line: 3, repoRoot: true });
    expect(found[path.join(cwd, 'notes/c.md')]).toMatchObject({ status: 'file', root: cwd, repoRoot: false });
    expect(found[path.join(spawnPath, 'd.ts')]).toMatchObject({ status: 'file', root: spawnPath, relative: 'd.ts', repoRoot: true });
    expect(found[`${path.join(worktree, 'e.ts')}#L2`]).toMatchObject({ status: 'file', root: worktree, line: 2, repoRoot: false });
    // Relative: from the cwd first, then the primary path.
    expect(found['notes/c.md:4:2']).toMatchObject({ status: 'file', root: cwd, line: 4, col: 2 });
    expect(found['src/a.ts']).toMatchObject({ status: 'file', root: project });
    expect(found[`file://${path.join(project, 'README.md')}`]).toMatchObject({ status: 'file', relative: 'README.md' });
    // Never any contents.
    expect(JSON.stringify(res.body)).not.toContain('export const');
  });

  it('answers outside, missing, not_file and blocked', async () => {
    const res = await refs([
      path.join(elsewhere, 'secret.txt'), '../elsewhere/secret.txt', 'src/../../elsewhere/secret.txt', path.join(project, 'escape/secret.txt'),
      path.join(project, 'src/gone.ts'), path.join(project, 'src'), 'src-link/a.ts',
      path.join(project, '.env'), path.join(project, '.env.example'), 'keys/server.pem', path.join(project, '.git/config'), 'innocent.txt',
      path.join(project, 'state/auth.json'), path.join(STATE_DIR, 'auth.json'), '~/x.ts', 'https://x.dev/a.ts',
    ]);
    const found = byInput(res.body);
    expect(found[path.join(elsewhere, 'secret.txt')]!.status).toBe('outside');
    expect(found['../elsewhere/secret.txt']!.status).toBe('outside');
    expect(found['src/../../elsewhere/secret.txt']!.status).toBe('outside');
    expect(found[path.join(project, 'escape/secret.txt')]!.status).toBe('outside');
    expect(found[path.join(project, 'src/gone.ts')]).toMatchObject({ status: 'missing', root: project });
    expect(found[path.join(project, 'src')]!.status).toBe('not_file');
    expect(found['src-link/a.ts']!.status).toBe('file');
    expect(found[path.join(project, '.env')]).toEqual({ input: path.join(project, '.env'), status: 'blocked' });
    expect(found[path.join(project, '.env.example')]!.status).toBe('file');
    expect(found['keys/server.pem']!.status).toBe('blocked');
    expect(found[path.join(project, '.git/config')]!.status).toBe('blocked');
    // A symlink whose target is sensitive.
    expect(found['innocent.txt']!.status).toBe('blocked');
    expect(['outside', 'blocked']).toContain(found[path.join(project, 'state/auth.json')]!.status);
    expect(found[path.join(STATE_DIR, 'auth.json')]!.status).not.toBe('file');
    expect(found['~/x.ts']!.status).toBe('outside');
    expect(found['https://x.dev/a.ts']!.status).toBe('outside');
  });

  it('kinds: image, binary_or_large, text', async () => {
    const found = byInput((await refs(['img/logo.png', 'img/huge.png', 'bin/blob.dat', 'big.txt', 'img/logo.svg'])).body);
    expect(found['img/logo.png']!.kind).toBe('image');
    expect(found['img/huge.png']!.kind).toBe('binary_or_large');
    expect(found['bin/blob.dat']!.kind).toBe('binary_or_large');
    expect(found['big.txt']!.kind).toBe('binary_or_large');
    expect(found['img/logo.svg']!.kind).toBe('text');
  });

  it('refuses more than 50 paths, a path over 1024 characters, the tool token, an unknown session', async () => {
    expect((await refs(Array.from({ length: 51 }, (_, i) => `src/f${i}.ts`))).status).toBe(400);
    expect((await refs(['a'.repeat(1025)])).status).toBe(400);
    const tool = await request(createApp()).post('/api/sessions/s1/file-refs').set('X-Hestia-Token', TOOL_TOKEN).send({ paths: ['src/a.ts'] });
    expect(tool.status).toBe(403);
    expect(tool.body.code).toBe('login_required');
    expect((await request(createApp()).post('/api/sessions/s1/file-refs').send({ paths: [] })).status).toBe(401);
    const unknown = await request(createApp()).post('/api/sessions/nope/file-refs').set('Authorization', login).send({ paths: ['src/a.ts'] });
    expect(unknown.status).toBe(404);
  });
});

describe('GET /api/sessions/:id/files', () => {
  it('reads a file with where it is', async () => {
    const res = await get(`/api/sessions/s1/files?${q(`${path.join(project, 'src/a.ts')}:1`)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: 'src/a.ts', rev: null, size: 20, binary: false, tooLarge: false, text: 'export const a = 1;\n',
      root: project, relative: 'src/a.ts', absolute: path.join(project, 'src/a.ts'), repoRoot: true,
    });
    expect((await get(`/api/sessions/s1/files?${q('big.txt')}`)).body).toMatchObject({ tooLarge: true, text: null });
    expect((await get(`/api/sessions/s1/files?${q('bin/blob.dat')}`)).body).toMatchObject({ binary: true, text: null });
  });

  it('checks everything again when reading', async () => {
    expect((await get(`/api/sessions/s1/files?${q(path.join(project, '.env'))}`)).body.code).toBe('path_sensitive');
    expect((await get(`/api/sessions/s1/files?${q('innocent.txt')}`)).body.code).toBe('path_sensitive');
    expect((await get(`/api/sessions/s1/files?${q(path.join(elsewhere, 'secret.txt'))}`)).body.code).toBe('path_outside_project');
    expect((await get(`/api/sessions/s1/files?${q(path.join(project, 'escape/secret.txt'))}`)).body.code).toBe('path_outside_project');
    expect((await get(`/api/sessions/s1/files?${q('src/gone.ts')}`)).status).toBe(404);
    expect((await get(`/api/sessions/s1/files?${q('src')}`)).body.code).toBe('path_not_found');
    expect((await request(createApp()).get(`/api/sessions/s1/files?${q('src/a.ts')}`).set('X-Hestia-Token', TOOL_TOKEN)).status).toBe(403);
    expect((await get('/api/sessions/nope/files?path=src/a.ts')).status).toBe(404);
  });
});

describe('GET /api/sessions/:id/files/raw', () => {
  it('serves an image with headers that keep it inert', async () => {
    const res = await get(`/api/sessions/s1/files/raw?${q('img/logo.png')}`).buffer(true).parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toBe('inline');
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('refuses SVG, HTML and text (415), an image over 10 MB, sensitive and outside paths', async () => {
    for (const target of ['img/logo.svg', 'img/page.html', 'src/a.ts']) {
      const res = await get(`/api/sessions/s1/files/raw?${q(target)}`);
      expect([target, res.status, res.body.code]).toEqual([target, 415, 'unsupported_media']);
    }
    expect((await get(`/api/sessions/s1/files/raw?${q('img/huge.png')}`)).status).toBe(413);
    expect((await get(`/api/sessions/s1/files/raw?${q('keys/server.pem')}`)).body.code).toBe('path_sensitive');
    expect((await get(`/api/sessions/s1/files/raw?${q(path.join(elsewhere, 'secret.txt'))}`)).body.code).toBe('path_outside_project');
    expect((await request(createApp()).get(`/api/sessions/s1/files/raw?${q('img/logo.png')}`).set('X-Hestia-Token', TOOL_TOKEN)).status).toBe(403);
  });
});
