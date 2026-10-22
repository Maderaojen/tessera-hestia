import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import { UPLOADS_DIR } from '../../src/config.js';
import { UPLOAD_MAX_BYTES } from '../../src/contract/attachments.js';
import type { ManagedSession } from '../../src/types.js';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  capturePane: vi.fn(async () => ''),
  getPaneSize: vi.fn(async () => null),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab'],
}));

vi.mock('../../src/registry.js', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
  removeSession: vi.fn(),
  reconcile: vi.fn(async () => {}),
}));

const registry = await import('../../src/registry.js');

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1',
    tmuxName: 'hestia-sess-1',
    cwd: '/some/project',
    projectId: 'proj-1',
    alias: null,
    createdAt: '2026-01-01T00:00:00Z',
    provider: null,
    providerSessionId: null,
    providerSessionFile: null,
    providerLaunchedAt: null,
    status: 'idle',
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    lastError: null,
    pendingInteraction: null,
    turns: [],
    turnsSourceFile: null,
    ...overrides,
  };
}

let auth: string;

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
});

afterEach(() => {
  // Reset, not just clear: a getSession answer a test queued but the route
  // never asked for (it refused the request first) would otherwise be what
  // the next test's request gets.
  vi.resetAllMocks();
});

describe('POST /api/sessions/:id/uploads', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nope/uploads')
      .set('Authorization', auth)
      .attach('file', Buffer.from('not-a-real-png'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
  });

  it('rejects excess fields before retaining any file', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const res = await request(createApp()).post('/api/sessions/sess-1/uploads').set('Authorization', auth)
      .field('unexpected', 'x'.repeat(2048)).attach('file', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(400);
  });

  it('400s when no file is attached', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/uploads').set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('keeps any other file in a folder of its own, under a name safe for a path', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ id: 'sess-1' }));
    const res = await request(createApp())
      .post('/api/sessions/sess-1/uploads')
      .set('Authorization', auth)
      .attach('file', Buffer.from('%PDF-1.4'), { filename: '季報 (final).pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    const id = res.body.attachment.id as string;
    expect(id).toMatch(/^sess-1\/[0-9a-f-]{36}\/季報_final_\.pdf$/);
    expect(res.body.attachment).toEqual({
      id, kind: 'file', name: '季報_final_.pdf', url: `/sessions/sess-1/uploads/${id.split('/')[1]}/${encodeURIComponent('季報_final_.pdf')}`,
      promptText: path.join(UPLOADS_DIR, id),
    });
    expect(readFileSync(path.join(UPLOADS_DIR, id), 'utf8')).toBe('%PDF-1.4');
  });

  it('saves an accepted image under UPLOADS_DIR/<sessionId>/ and returns its path', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ id: 'sess-1' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/uploads')
      .set('Authorization', auth)
      .attach('file', Buffer.from('fake-png-bytes'), { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(typeof res.body.path).toBe('string');
    expect(res.body.path).toContain('sess-1');
    expect(res.body.path.endsWith('.png')).toBe(true);
    expect(readFileSync(res.body.path, 'utf8')).toBe('fake-png-bytes');
    expect(statSync(res.body.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(res.body.path)).mode & 0o777).toBe(0o700);
    // The attachment: an id, where it loads from, and the text for the CLI.
    const file = path.basename(res.body.path as string);
    expect(res.body.attachment).toEqual({
      id: `sess-1/${file}`, kind: 'image', url: `/sessions/sess-1/uploads/${file}`, promptText: res.body.path as string,
    });
  });

  it('400s on a file over the size limit', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const big = Buffer.alloc(UPLOAD_MAX_BYTES + 1);
    const res = await request(app)
      .post('/api/sessions/sess-1/uploads')
      .set('Authorization', auth)
      .attach('file', big, { filename: 'huge.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sessions/:id/uploads/:filename', () => {
  const dir = path.join(UPLOADS_DIR, 'sess-1');
  const realFile = 'real-photo.png';

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, realFile), Buffer.from('fake-png-bytes'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/sessions/nope/uploads/x.png').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('404s on a disallowed/unrecognized extension', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/uploads/x.txt').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('404s when the file does not exist on disk', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/uploads/missing.png').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('ignores directory components in the filename param (path traversal)', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    // path.basename() strips the leading '..%2F' segments express itself
    // doesn't already normalize away — this must resolve to a 404 (no such
    // basename in this session's dir), never a file outside UPLOADS_DIR.
    const res = await request(app)
      .get('/api/sessions/sess-1/uploads/' + encodeURIComponent('../../../../etc/passwd'))
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('serves an existing file with the right content-type', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const res = await request(app).get(`/api/sessions/sess-1/uploads/${realFile}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(existsSync(path.join(dir, realFile))).toBe(true);
  });
});

describe('GET /api/sessions/:id/uploads/:folder/:name', () => {
  const folder = '0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c';
  const dir = path.join(UPLOADS_DIR, 'sess-1', folder);

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '報告.html'), '<script>alert(1)</script>');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a file as a download, never inline', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const res = await request(createApp()).get(`/api/sessions/sess-1/uploads/${folder}/${encodeURIComponent('報告.html')}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('報告.html')}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('404s on a folder or name that names no upload', async () => {
    for (const [dirName, name] of [['not-a-uuid', '報告.html'], [folder, '.hidden'], [folder, 'missing.txt']]) {
      vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
      const res = await request(createApp()).get(`/api/sessions/sess-1/uploads/${dirName}/${encodeURIComponent(name!)}`).set('Authorization', auth);
      expect(res.status, `${dirName}/${name}`).toBe(404);
    }
  });
});

describe('note images (/api/notes/uploads)', () => {
  const dir = path.join(UPLOADS_DIR, 'notes');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves an image under UPLOADS_DIR/notes/, tied to no session', async () => {
    const res = await request(createApp())
      .post('/api/notes/uploads')
      .set('Authorization', auth)
      .attach('file', Buffer.from('fake-png-bytes'), { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(path.dirname(res.body.path)).toBe(dir);
    expect(readFileSync(res.body.path, 'utf8')).toBe('fake-png-bytes');
    expect(res.body.attachment).toMatchObject({ id: `notes/${path.basename(res.body.path as string)}`, url: expect.stringMatching(/^\/notes\/uploads\//) });
    expect(registry.getSession).not.toHaveBeenCalled();
  });

  it('refuses what isn\'t an image, and serves one back', async () => {
    const app = createApp();
    const rejected = await request(app)
      .post('/api/notes/uploads')
      .set('Authorization', auth)
      .attach('file', Buffer.from('#!/bin/sh'), { filename: 'x.sh', contentType: 'application/x-sh' });
    expect(rejected.status).toBe(400);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'n.png'), Buffer.from('fake-png-bytes'));
    const served = await request(app).get('/api/notes/uploads/n.png').set('Authorization', auth);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
    const escaped = await request(app).get('/api/notes/uploads/' + encodeURIComponent('../../etc/passwd')).set('Authorization', auth);
    expect(escaped.status).toBe(404);
  });
});


describe('upload cancellation admission', () => {
  it.each([false, true])('releases aborted upload slots (file started: %s)', async (fileStarted) => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    const app = createApp();
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const clients = [0, 1].map(() => {
      const client = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/sessions/sess-1/uploads', headers: {
        Authorization: auth, 'Content-Type': 'multipart/form-data; boundary=upload-test',
      } });
      client.on('error', () => {});
      client.write(fileStarted ? '--upload-test\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\npartial' : '--upload-test\r\nContent-Dispo');
      return client;
    });
    try {
      let status = 0;
      for (let attempt = 0; attempt < 40; attempt++) {
        status = (await request(app).post('/api/sessions/sess-1/uploads').set('Authorization', auth)).status;
        if (status === 429) break;
        await delay(5);
      }
      expect(status).toBe(429);
      clients.forEach((client) => client.destroy());
      for (let attempt = 0; attempt < 40; attempt++) {
        status = (await request(app).post('/api/sessions/sess-1/uploads').set('Authorization', auth)).status;
        if (status === 400) break;
        await delay(5);
      }
      expect(status).toBe(400);
    } finally { clients.forEach((client) => client.destroy()); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
