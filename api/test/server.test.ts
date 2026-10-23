import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { APP_WEBVIEW_ORIGINS, DEFAULT_CORS_ALLOWED_ORIGINS, DEFAULT_FRONTEND_ORIGIN } from '../src/config.js';

// Same mocking shape as registry.test.ts / polling.test.ts: never let this
// suite shell out to a real tmux binary.
vi.mock('../src/tmux.js', () => ({
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

// Wraps (not replaces) the real registry module — same technique
// registry.test.ts uses for node:fs/promises's writeFile — so every route
// but the error-handler test below gets real registry behavior (backed by
// the temp HESTIA_STATE_DIR), while still letting one call be forced
// to reject to exercise the error-handling middleware.
vi.mock('../src/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/registry.js')>();
  return { ...actual, listSessions: vi.fn(actual.listSessions) };
});

// The web frontend: not in the defaults (only the app is), so a backend
// that wants it lists it — webApp() is such a backend.
const ALLOWED_ORIGIN = DEFAULT_FRONTEND_ORIGIN;

let stateDir: string;
let createApp: typeof import('../src/server.js').createApp;
let allowedOrigins: typeof import('../src/server.js').allowedOrigins;
let auth: typeof import('../src/auth.js');
let registry: typeof import('../src/registry.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-server-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  process.env.AUTH_USERNAME = 'alice';
  auth = await import('../src/auth.js');
  process.env.AUTH_PASSWORD_HASH = auth.hashPassword('correct-horse-battery-staple');
  ({ createApp, allowedOrigins } = await import('../src/server.js'));
  registry = await import('../src/registry.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD_HASH;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('GET /api/health', () => {
  // The shell this runs in may be a dev install's own (HESTIA_COMMAND_NAME).
  const original = process.env.HESTIA_COMMAND_NAME;
  afterEach(() => {
    if (original === undefined) delete process.env.HESTIA_COMMAND_NAME;
    else process.env.HESTIA_COMMAND_NAME = original;
  });

  async function healthAs(name: string | undefined) {
    if (name === undefined) delete process.env.HESTIA_COMMAND_NAME;
    else process.env.HESTIA_COMMAND_NAME = name;
    vi.resetModules();
    ({ createApp } = await import('../src/server.js'));
    return request(createApp()).get('/api/health');
  }

  it('answers without a login, naming the install by its command (hestia unless set)', async () => {
    const res = await healthAs(undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: 'hestia' });
  });

  it('a dev install says hestia-dev, so the app can tell the two apart on one SSH server', async () => {
    expect((await healthAs('hestia-dev')).body).toEqual({ ok: true, name: 'hestia-dev' });
  });
});

describe('CORS', () => {
  const webApp = () => {
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
    return createApp();
  };

  it('does not send Access-Control-Allow-Origin for a disallowed origin', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('reflects the exact allowed origin, sets credentials + Vary', async () => {
    const app = webApp();
    const res = await request(app).get('/api/health').set('Origin', ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers.vary).toBe('Origin');
  });

  it('allows all app WebView origins by default, but never with credentials', async () => {
    expect(APP_WEBVIEW_ORIGINS).toEqual([
      'capacitor://localhost',
      'https://localhost',
      'tauri://localhost',
      'http://tauri.localhost',
    ]);
    expect(DEFAULT_CORS_ALLOWED_ORIGINS).toEqual(APP_WEBVIEW_ORIGINS);
    const app = createApp();
    for (const origin of APP_WEBVIEW_ORIGINS) {
      const res = await request(app).get('/api/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('does not set CORS headers at all when no Origin header is sent', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight OPTIONS with 204 and the right allow-methods/headers', async () => {
    const app = webApp();
    const res = await request(app)
      .options('/api/sessions')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
  });

  // Production calls this API cross-origin, so every PATCH route (note
  // edit, session/project rename) is dead in the browser unless the
  // preflight lists PATCH — same-origin tests never see it.
  it('allows PATCH in the preflight so cross-origin edits/renames are not blocked', async () => {
    const app = webApp();
    const res = await request(app)
      .options('/api/projects/p1/notes/n1')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'PATCH');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']?.split(',')).toContain('PATCH');
  });

  // The continuity settings (Settings → 額度用完時, a chat's own choice)
  // save with PUT; without it in the preflight every save fails in the
  // browser and nothing is ever stored.
  it('allows PUT in the preflight so cross-origin continuity saves are not blocked', async () => {
    const app = webApp();
    const res = await request(app)
      .options('/api/continuity')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'PUT');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']?.split(',')).toContain('PUT');
  });

  describe('CORS_ALLOWED_ORIGINS', () => {
    afterEach(() => {
      delete process.env.CORS_ALLOWED_ORIGINS;
    });

    it('allows exactly the listed origins, replacing the default', async () => {
      process.env.CORS_ALLOWED_ORIGINS = ' https://app.example.com/ , http://localhost:5173';
      const app = createApp();
      const listed = await request(app).get('/api/health').set('Origin', 'https://app.example.com');
      expect(listed.headers['access-control-allow-origin']).toBe('https://app.example.com');
      const dev = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
      expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      const old = await request(app).get('/api/health').set('Origin', ALLOWED_ORIGIN);
      expect(old.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('uses the exact four app WebView origins as defaults and rejects wildcard', () => {
      expect([...allowedOrigins(undefined)]).toEqual(APP_WEBVIEW_ORIGINS);
      expect([...allowedOrigins('')]).toEqual(APP_WEBVIEW_ORIGINS);
      expect([...allowedOrigins('*')]).toEqual([]);
    });

    it('by default allows each exact app WebView origin', async () => {
      const app = createApp();
      for (const origin of APP_WEBVIEW_ORIGINS) {
        const res = await request(app).get('/api/health').set('Origin', origin);
        expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
      }
      // Only those exact origins: something on another localhost port isn't the app.
      const other = await request(app).get('/api/health').set('Origin', 'https://localhost:8443');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('a list without the native app leaves it out: a list replaces the defaults whole', async () => {
      process.env.CORS_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
      const res = await request(createApp()).get('/api/health').set('Origin', 'capacitor://localhost');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('keeps all app origins bearer-only when they are explicitly listed', async () => {
      process.env.CORS_ALLOWED_ORIGINS = `https://web.example,${APP_WEBVIEW_ORIGINS.join(',')}`;
      const app = createApp();
      for (const origin of APP_WEBVIEW_ORIGINS) {
        const res = await request(app)
          .options('/api/auth/login')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'authorization,content-type');
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(res.headers['access-control-allow-headers']).toContain('Authorization');
      }
    });

    it('keeps the default when blank: the app alone, not the web frontend', async () => {
      process.env.CORS_ALLOWED_ORIGINS = '  ';
      const app = createApp();
      expect((await request(app).get('/api/health').set('Origin', 'capacitor://localhost')).headers['access-control-allow-origin']).toBe('capacitor://localhost');
      expect((await request(app).get('/api/health').set('Origin', ALLOWED_ORIGIN)).headers['access-control-allow-origin']).toBeUndefined();
    });

    it('never honors a wildcard — credentials and "*" must not meet', async () => {
      process.env.CORS_ALLOWED_ORIGINS = '*';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await request(createApp()).get('/api/health').set('Origin', 'https://evil.example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('still 204s a preflight from a disallowed origin, but without ACAO', async () => {
    const app = createApp();
    const res = await request(app).options('/api/sessions').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('requireAuth gate', () => {
  it('gates search and validates its bounded query parameters', async () => {
    const app = createApp();
    const url = '/api/sessions/search?q=%E4%B8%AD';
    expect((await request(app).get(url)).status).toBe(401);
    const authHeader = `Bearer ${auth.issueSessionToken()}`;
    const valid = await request(app).get(url).set('Authorization', authHeader);
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ results: [], nextCursor: null });
    for (const invalid of ['/api/sessions/search', '/api/sessions/search?q=+', '/api/sessions/search?q=x&limit=51', '/api/sessions/search?q=x&cursor=garbage']) {
      const response = await request(app).get(invalid).set('Authorization', authHeader);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_request');
    }
  });
  // Delegations: behind the gate like the rest; accepting needs a login,
  // not the local tool token (routes/login-guard.ts).
  it('serves /delegations behind the gate, and keeps accept to a login', async () => {
    const app = createApp();
    expect((await request(app).get('/api/delegations')).status).toBe(401);
    auth.__setLocalToolTokenForTests('tool');
    try {
      const list = await request(app).get('/api/delegations').set('X-Hestia-Token', 'tool');
      expect(list.status).toBe(200);
      expect(list.body).toEqual({ delegations: [] });
      const accept = await request(app).post('/api/delegations/x/accept').set('X-Hestia-Token', 'tool');
      expect(accept.status).toBe(403);
      expect(accept.body.code).toBe('login_required');
      const asUser = await request(app).post('/api/delegations/x/accept').set('Authorization', `Bearer ${auth.issueSessionToken()}`);
      expect(asUser.status).toBe(404);
    } finally {
      auth.__setLocalToolTokenForTests(null);
    }
  });
  it('401s a protected route with no login token', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'not_authenticated', message: 'not authenticated', error: 'not authenticated' });
  });

  // A cookie is never a credential: a browser attaches it to requests any
  // other site makes too (a cross-site form post needs no preflight).
  it('401s a valid login token sent as a cookie', async () => {
    const app = createApp();
    const token = auth.issueSessionToken();
    expect((await request(app).get('/api/sessions').set('Cookie', `hestia_session=${token}`)).status).toBe(401);
    expect((await request(app).post('/api/notes/uploads').set('Cookie', `hestia_session=${token}`)).status).toBe(401);
  });

  it('has the architecture map only when a folder is configured, and behind the login', async () => {
    const token = auth.issueSessionToken();
    expect((await request(createApp()).get('/api/architecture').set('Authorization', `Bearer ${token}`)).status).toBe(404);

    process.env.HESTIA_ARCHITECTURE_DIR = stateDir;
    try {
      const app = createApp();
      expect((await request(app).get('/api/architecture')).status).toBe(401);
      // Mounted: the folder just has no vision.json yet.
      const res = await request(app).get('/api/architecture').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    } finally {
      delete process.env.HESTIA_ARCHITECTURE_DIR;
    }
  });

  it('passes through with a valid bearer token, and 401s a garbage one', async () => {
    const app = createApp();
    const token = auth.issueSessionToken();
    expect((await request(app).get('/api/sessions').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/sessions').set('Authorization', 'Bearer not-a-real-token')).status).toBe(401);
    // The token alone, without the scheme, is not a bearer credential.
    expect((await request(app).get('/api/sessions').set('Authorization', token)).status).toBe(401);
  });

  // An optional module's routes sit behind the same gate as Hestia's own.
  it('mounts a module\'s routes behind the login', async () => {
    const { Router } = await import('express');
    const router = Router().get('/example/ping', (_req, res) => res.json({ pong: true }));
    const app = createApp({ modules: [{ id: 'example', capabilities: ['example_ping'], routes: [{ path: '/projects', router }] }] });
    expect((await request(app).get('/api/projects/example/ping')).status).toBe(401);
    const res = await request(app).get('/api/projects/example/ping').set('Authorization', `Bearer ${auth.issueSessionToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
    const meta = await request(app).get('/api/meta').set('Authorization', `Bearer ${auth.issueSessionToken()}`);
    expect(meta.body.modules).toEqual(['example']);
    expect(meta.body.capabilities).toContain('example_ping');
  });

  it('/health is reachable with no auth at all', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('/auth/status is reachable with no auth (it reports the state, it does not gate it)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });
});

describe('request body limits', () => {
  // A long message (a pasted document) was refused at Express's 100 KB
  // default, as a 500 that didn't say why (2026-10-20).
  it('takes a message up to 5 MB, and says when a body is over its route\'s limit', async () => {
    const app = createApp();
    const token = auth.issueSessionToken();
    const send = (text: string) => request(app).post('/api/sessions/missing/messages').set('Authorization', `Bearer ${token}`).send({ text });
    // Read past the body limit: the route itself answers (no such session).
    expect((await send('字'.repeat(200_000))).status).toBe(404);
    const over = await send('字'.repeat(1_800_000));
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ code: 'request_too_large', params: { limit: '5 MB' } });
    // Every other route keeps the 100 KB default.
    const other = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`).send({ name: 'x'.repeat(200_000) });
    expect(other.status).toBe(413);
    expect(other.body).toMatchObject({ code: 'request_too_large', params: { limit: '100 KB' } });
  });
});

describe('error handling middleware', () => {
  it('returns a generic 500 JSON body, never a stack trace, when a route throws', async () => {
    const app = createApp();
    const token = auth.issueSessionToken();
    vi.mocked(registry.listSessions).mockRejectedValueOnce(new Error('boom: sensitive internal detail'));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'internal_error', message: 'internal server error', error: 'internal server error' });
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain('boom');
    expect(bodyText).not.toContain('at ');
    consoleErrorSpy.mockRestore();
  });
});

describe('Host check for local requests (DNS rebinding)', () => {
  it('refuses a direct local request whose Host is some other site', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health').set('Host', 'evil.example');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('host_not_allowed');
    const login = await request(app).post('/api/auth/login').set('Host', 'evil.example:4791').send({ username: 'alice', password: 'correct-horse-battery-staple' });
    expect(login.status).toBe(403);
  });

  it('refuses a local request with an empty Host', async () => {
    const res = await request(createApp()).get('/api/health').set('Host', '');
    expect(res.status).toBe(403);
  });

  it('accepts loopback hostnames, with or without a port', async () => {
    const app = createApp();
    // supertest's own default: 127.0.0.1:<ephemeral port>.
    expect((await request(app).get('/api/health')).status).toBe(200);
    for (const host of ['127.0.0.1:4791', 'localhost', 'localhost:4791', 'LOCALHOST:3000', '[::1]:4791', '[::1]']) {
      const res = await request(app).get('/api/health').set('Host', host);
      expect(res.status, host).toBe(200);
    }
  });

  it('leaves relayed requests alone: they carry the public name', async () => {
    const app = createApp();
    const tailscale = await request(app).get('/api/health').set('Host', 'box.tailnet.ts.net').set('X-Forwarded-For', '100.64.0.5');
    expect(tailscale.status).toBe(200);
    const forwarded = await request(app).get('/api/health').set('Host', 'hestia.example.com').set('Forwarded', 'for=203.0.113.9');
    expect(forwarded.status).toBe(200);
  });

  it('parses Host names the way the check needs', async () => {
    const { hostnameOf } = await import('../src/server.js');
    expect(hostnameOf('127.0.0.1:4791')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:4791')).toBe('[::1]');
    expect(hostnameOf('::1')).toBe('::1');
    expect(hostnameOf('localhost.evil.example')).toBe('localhost.evil.example');
    expect(hostnameOf(undefined)).toBe('');
  });
});
