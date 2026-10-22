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
  capturePane: vi.fn(async () => ''),
  getPaneSize: vi.fn(async () => null),
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

describe('GET /api/sessions/:id/events', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/sessions/nope/events').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  // Same rationale as pane.test.ts: an SSE connection never ends, so this
  // uses a raw http request against a real ephemeral server and only
  // checks headers + the very first pushed event, then tears the
  // connection down rather than trying to assert on a full open stream.
  it('opens a text/event-stream and immediately pushes the current session snapshot', async () => {
    const session = makeSession({ launchProfile: {
      id: 'janus:profile', provider: 'codex', source: 'janus', profileName: 'work',
      home: '/private/janus/home', conversationRoot: '/private/janus/home/sessions',
      delegate: { kind: 'janus', executable: '/private/bin/janus' },
    } });
    vi.mocked(registry.getSession).mockResolvedValue(session);
    const app = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const { headers, firstChunk } = await new Promise<{ headers: http.IncomingHttpHeaders; firstChunk: string }>(
        (resolve, reject) => {
          const req = http.get(
            { host: '127.0.0.1', port, path: '/api/sessions/sess-1/events', headers: { Authorization: auth } },
            (res) => {
              res.setEncoding('utf-8');
              res.once('data', (chunk: string) => {
                resolve({ headers: res.headers, firstChunk: chunk });
                res.destroy();
                req.destroy();
              });
            },
          );
          req.on('error', (err) => {
            if (!(err as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(err);
          });
        },
      );
      expect(headers['content-type']).toMatch(/^text\/event-stream/);
      expect(headers['cache-control']).toBe('no-cache');
      expect(headers.connection).toBe('keep-alive');
      expect(firstChunk).toContain('"type":"update"');
      expect(firstChunk).toContain(session.id);
      expect(firstChunk).not.toContain('/private/janus');
      expect(firstChunk).not.toContain('/private/bin/janus');
    } finally {
      server.close();
    }
  });
});

describe('GET /api/sessions/:id/events, when the session is deleted', () => {
  // Moving a session to the trash publishes `deleted` (registry/store.ts):
  // the open stream passes it on and ends.
  it('passes the deleted event on and ends the stream', async () => {
    const { publish } = await import('../../src/session-stream.js');
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    const server = createApp().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/sessions/sess-1/events', headers: { Authorization: auth } }, (res) => {
          let text = '';
          res.setEncoding('utf-8');
          res.once('data', () => setTimeout(() => publish('sess-1', { type: 'deleted' }), 20));
          res.on('data', (chunk: string) => { text += chunk; });
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
      });
      expect(body).toContain('"type":"update"');
      expect(body).toContain('"type":"deleted"');
    } finally {
      server.close();
    }
  });
});

describe('GET /api/sessions/events', () => {
  // Reads `data:` events off a live stream until `count` have arrived.
  function readEvents(port: number, count: number, onOpen: () => void = () => {}): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const events: unknown[] = [];
      let buffer = '';
      const req = http.get({ host: '127.0.0.1', port, path: '/api/sessions/events', headers: { Authorization: auth } }, (res) => {
        res.setEncoding('utf-8');
        onOpen();
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
          }
          if (events.length >= count) {
            resolve(events);
            res.destroy();
            req.destroy();
          }
        });
      });
      req.on('error', (err) => {
        if (!(err as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(err);
      });
    });
  }

  it('sends every session without the deprecated fields, then each change', async () => {
    const { publish } = await import('../../src/session-stream.js');
    const { toPublicManagedSession } = await import('../../src/session-dto.js');
    const first = makeSession({ id: 'a' });
    vi.mocked(registry.listSessions).mockResolvedValue([first, makeSession({ id: 'b' })]);
    const server = createApp().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const events = await readEvents(port, 4, () => {
        setTimeout(() => {
          publish('a', { type: 'update', session: toPublicManagedSession({ ...first, alias: 'renamed' }) });
          publish('b', { type: 'deleted' });
          publish('b', { type: 'restored', session: toPublicManagedSession(makeSession({ id: 'b', status: 'dead' })) });
        }, 50);
      }) as Array<Record<string, unknown>>;
      expect(events[0]).toMatchObject({ type: 'snapshot' });
      const snapshot = events[0]!.sessions as Array<Record<string, unknown>>;
      expect(snapshot.map((session) => session.id)).toEqual(['a', 'b']);
      for (const session of snapshot) {
        expect(session).not.toHaveProperty('turns');
        expect(session).not.toHaveProperty('status');
        expect(session).not.toHaveProperty('claudeClearPending');
        expect(session.lastActivityAt).toBe('2026-01-01T00:00:00Z');
      }
      expect(events[1]).toMatchObject({ type: 'update', session: { id: 'a', alias: 'renamed' } });
      expect((events[1] as { session: object }).session).not.toHaveProperty('turns');
      expect(events[2]).toEqual({ type: 'deleted', sessionId: 'b' });
      // Taken back out of the trash: its own type, without the deprecated fields.
      expect(events[3]).toMatchObject({ type: 'restored', session: { id: 'b' } });
      expect((events[3] as { session: object }).session).not.toHaveProperty('turns');
    } finally {
      server.close();
    }
  });
});

// `recap` events go only to a stream that asked for them (?include=recap):
// clients from before the trash take an unknown event on the list stream
// for a deleted session.
describe('recap events on the session streams', () => {
  const recapEvent = (sessionId: string) => ({
    type: 'recap' as const, sessionId, conversationId: 'c1', state: 'running' as const, coveredTurns: 0, totalTurns: 3, updatedAt: null,
  });

  // Reads `data:` events off a live stream until `count` have arrived;
  // `onOpen` runs once the stream has sent its first event.
  function readStream(port: number, streamPath: string, count: number, onOpen: () => void): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const events: Array<Record<string, unknown>> = [];
      let buffer = '';
      let opened = false;
      const req = http.get({ host: '127.0.0.1', port, path: streamPath, headers: { Authorization: auth } }, (res) => {
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
          }
          if (!opened && events.length > 0) {
            opened = true;
            setTimeout(onOpen, 30);
          }
          if (events.length >= count) {
            resolve(events);
            res.destroy();
            req.destroy();
          }
        });
      });
      req.on('error', (err) => {
        if (!(err as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(err);
      });
    });
  }

  async function withServer(run: (port: number) => Promise<void>): Promise<void> {
    const server = createApp().listen(0);
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      server.close();
    }
  }

  it.each([
    ['the list stream', '/api/sessions/events?include=recap'],
    ['the list stream, among other values', '/api/sessions/events?include=other,recap'],
    ['a session\'s stream', '/api/sessions/sess-1/events?include=recap'],
  ])('%s sends them when asked', async (_name, streamPath) => {
    const { publishRecap } = await import('../../src/recap/events.js');
    vi.mocked(registry.listSessions).mockResolvedValue([makeSession()]);
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    await withServer(async (port) => {
      const events = await readStream(port, streamPath, 2, () => {
        publishRecap(recapEvent('another-session'));
        publishRecap(recapEvent('sess-1'));
      });
      // A session's own stream leaves out the other session's.
      expect(events[1]).toEqual(streamPath.includes('sess-1/') ? recapEvent('sess-1') : recapEvent('another-session'));
    });
  });

  it.each([
    ['the list stream', '/api/sessions/events'],
    ['the list stream asking for something else', '/api/sessions/events?include=other'],
    ['a session\'s stream', '/api/sessions/sess-1/events'],
  ])('%s never sends them otherwise', async (_name, streamPath) => {
    const { publishRecap } = await import('../../src/recap/events.js');
    const { publish } = await import('../../src/session-stream.js');
    const { toPublicManagedSession } = await import('../../src/session-dto.js');
    vi.mocked(registry.listSessions).mockResolvedValue([makeSession()]);
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    await withServer(async (port) => {
      const events = await readStream(port, streamPath, 2, () => {
        publishRecap(recapEvent('sess-1'));
        publish('sess-1', { type: 'update', session: toPublicManagedSession(makeSession({ alias: 'after' })) });
      });
      expect(events.map((event) => event.type)).toEqual([streamPath.includes('sess-1/') ? 'update' : 'snapshot', 'update']);
      expect(events[1]).toMatchObject({ session: { alias: 'after' } });
    });
  });
});
