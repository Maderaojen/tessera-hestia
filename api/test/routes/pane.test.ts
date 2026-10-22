import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { ManagedSession } from '../../src/types.js';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  capturePane: vi.fn(async () => 'pane text'),
  getPaneSize: vi.fn(async () => ({ cols: 133, rows: 40 })),
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
const tmuxCli = await import('../../src/tmux.js');

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1',
    tmuxName: 'hestia-sess-1',
    cwd: '/some/project',
    projectId: 'proj-1',
    alias: null,
    createdAt: '2026-01-01T00:00:00Z',
    provider: 'claude',
    providerSessionId: 'abc',
    providerSessionFile: null,
    providerLaunchedAt: '2026-01-01T00:00:00Z',
    status: 'ready',
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
  vi.clearAllMocks();
});

describe('GET /api/sessions/:id/pane', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/sessions/nope/pane').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('410s when the session is dead', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/pane').set('Authorization', auth);
    expect(res.status).toBe(410);
  });

  it('400s on a non-numeric/non-positive lines param', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    const app = createApp();
    const res1 = await request(app).get('/api/sessions/sess-1/pane?lines=abc').set('Authorization', auth);
    expect(res1.status).toBe(400);
    const res2 = await request(app).get('/api/sessions/sess-1/pane?lines=-5').set('Authorization', auth);
    expect(res2.status).toBe(400);
  });

  it('returns pane content, size, and capture metadata on success', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/pane?lines=100').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content: 'pane text', cols: 133, rows: 40, ansi: true, history: 100 });
    expect(res.body.capturedAt).toEqual(expect.any(String));
  });

  it('respects ansi=0 to disable ANSI capture', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/pane?ansi=0').set('Authorization', auth);
    expect(res.body.ansi).toBe(false);
  });

  it('410s when the underlying tmux capture throws (pane gone)', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    vi.mocked(tmuxCli.capturePane).mockRejectedValueOnce(new Error('no such pane'));
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/pane').set('Authorization', auth);
    expect(res.status).toBe(410);
  });
});

describe('GET /api/sessions/:id/pane/stream', () => {
  it('404s when the session does not exist (returns a normal JSON response, no SSE)', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/sessions/nope/pane/stream').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('410s when the session is dead', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/pane/stream').set('Authorization', auth);
    expect(res.status).toBe(410);
  });

  // A live SSE connection never ends, so supertest (which waits for the
  // response body to finish) can't be used here without hanging. Instead:
  // start a real ephemeral server, connect with a raw http request, assert
  // on the headers as soon as they arrive, then tear the connection down —
  // no attempt at a full streamed-body assertion (fragile, and not what
  // this endpoint's contract is really about).
  it('opens a text/event-stream with no-cache/keep-alive headers on success', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    const app = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/sessions/sess-1/pane/stream', headers: { Authorization: auth } },
          (res) => {
            resolve(res.headers);
            res.destroy();
            req.destroy();
          },
        );
        req.on('error', (err) => {
          // Destroying the socket right after reading headers can itself
          // surface as a benign ECONNRESET on this side — ignore it.
          if (!(err as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(err);
        });
      });
      expect(headers['content-type']).toMatch(/^text\/event-stream/);
      expect(headers['cache-control']).toBe('no-cache');
      expect(headers.connection).toBe('keep-alive');
    } finally {
      server.close();
    }
  });
});
