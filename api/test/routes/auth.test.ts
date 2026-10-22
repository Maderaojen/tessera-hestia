import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab'],
}));

const PASSWORD = 'correct-horse-battery-staple';

let stateDir: string;
let createApp: typeof import('../../src/server.js').createApp;

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-auth-route-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  process.env.AUTH_USERNAME = 'alice';
  const auth = await import('../../src/auth.js');
  process.env.AUTH_PASSWORD_HASH = auth.hashPassword(PASSWORD);
  ({ createApp } = await import('../../src/server.js'));
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD_HASH;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('POST /api/auth/login', () => {
  it('rejects a missing username/password with 400', async () => {
    const app = createApp();
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('succeeds with the right credentials, answering with the token and setting no cookie', async () => {
    const app = createApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('fails the same way for a wrong password as for an unknown username (401, same message)', async () => {
    const app = createApp();
    const wrongPassword = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
    const app2 = createApp();
    const unknownUser = await request(app2)
      .post('/api/auth/login')
      .send({ username: 'someone-else', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
    expect(wrongPassword.body).toEqual({ code: 'invalid_credentials', message: 'incorrect username or password', error: 'incorrect username or password' });
  });

  it('locks out after MAX_LOGIN_ATTEMPTS failures from the same source', async () => {
    const app = createApp();
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
      expect(res.status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
    expect(locked.status).toBe(429);

    // Even the *correct* password is locked out now.
    const lockedEvenWithRightPassword = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: PASSWORD });
    expect(lockedEvenWithRightPassword.status).toBe(429);
  });

  it('a successful login does not count toward, or get blocked by, a stale failure count', async () => {
    const app = createApp();
    for (let i = 0; i < 4; i++) {
      await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
    }
    const success = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    expect(success.status).toBe(200);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session so the token is no longer valid', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    const bearer = `Bearer ${login.body.token as string}`;

    const beforeLogout = await request(app).get('/api/auth/status').set('Authorization', bearer);
    expect(beforeLogout.body).toEqual({ authenticated: true, username: 'alice', host: os.hostname() });

    const logout = await request(app).post('/api/auth/logout').set('Authorization', bearer);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true });

    const afterLogout = await request(app).get('/api/auth/status').set('Authorization', bearer);
    expect(afterLogout.body).toEqual({ authenticated: false });
  });

  it('is a no-op (not an error) when there is no login token at all', async () => {
    const app = createApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /api/auth/status', () => {
  it('reports unauthenticated with no token', async () => {
    const app = createApp();
    const res = await request(app).get('/api/auth/status');
    expect(res.body).toEqual({ authenticated: false });
  });

  it('reports unauthenticated for a garbage token', async () => {
    const app = createApp();
    const res = await request(app).get('/api/auth/status').set('Authorization', 'Bearer garbage');
    expect(res.body).toEqual({ authenticated: false });
  });

  it('reports authenticated after a real login, naming the account and host only then', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    const bearer = `Bearer ${login.body.token as string}`;
    const res = await request(app).get('/api/auth/status').set('Authorization', bearer);
    expect(res.body).toEqual({ authenticated: true, username: 'alice', host: os.hostname() });
  });
});

describe('a local-only account (AUTH_LOCAL_USERS)', () => {
  const TOOL_PASSWORD = 'tool-secret';

  beforeEach(async () => {
    const auth = await import('../../src/auth.js');
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword(TOOL_PASSWORD)}`;
  });
  afterEach(() => {
    delete process.env.AUTH_LOCAL_USERS;
  });

  it('logs in from this machine, and is named as itself', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'ai-dev', password: TOOL_PASSWORD });
    expect(login.status).toBe(200);
    const bearer = `Bearer ${login.body.token as string}`;

    const status = await request(app).get('/api/auth/status').set('Authorization', bearer);
    expect(status.body).toEqual({ authenticated: true, username: 'ai-dev', host: os.hostname() });
    expect((await request(app).get('/api/projects').set('Authorization', bearer)).status).toBe(200);
  });

  it('cannot log in through a relay, answering exactly like a wrong password', async () => {
    const res = await request(createApp())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ username: 'ai-dev', password: TOOL_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'invalid_credentials', message: 'incorrect username or password', error: 'incorrect username or password' });
  });

  it('its token is worthless from outside', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'ai-dev', password: TOOL_PASSWORD });
    const bearer = `Bearer ${login.body.token as string}`;

    const relayed = await request(app).get('/api/projects').set('Authorization', bearer).set('X-Forwarded-For', '203.0.113.9');
    expect(relayed.status).toBe(401);
    const status = await request(app).get('/api/auth/status').set('Authorization', bearer).set('X-Forwarded-For', '203.0.113.9');
    expect(status.body).toEqual({ authenticated: false });
  });

  it('the main account still works through a relay', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ username: 'alice', password: PASSWORD });
    expect(login.status).toBe(200);
  });
});

describe('login lockout', () => {
  it('locks out the caller who kept guessing wrong, not everyone else behind the same relay', async () => {
    const app = createApp();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', '100.64.0.9').send({ username: 'alice', password: 'wrong' });
    }
    const guesser = await request(app).post('/api/auth/login').set('X-Forwarded-For', '100.64.0.9').send({ username: 'alice', password: PASSWORD });
    const someoneElse = await request(app).post('/api/auth/login').set('X-Forwarded-For', '100.64.0.4').send({ username: 'alice', password: PASSWORD });

    expect(guesser.status).toBe(429);
    expect(someoneElse.status).toBe(200);
  });

  it('a client-invented X-Forwarded-For first hop does not buy fresh attempts', async () => {
    const app = createApp();
    // What tailscale serve forwards: the client's own header, plus the real
    // address appended at the end.
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', `10.9.9.${i}, 100.64.0.5`).set('X-Real-IP', `10.8.8.${i}`)
        .send({ username: 'alice', password: 'wrong' });
    }
    const next = await request(app).post('/api/auth/login').set('X-Forwarded-For', '10.9.9.200, 100.64.0.5').send({ username: 'alice', password: PASSWORD });
    expect(next.status).toBe(429);
  });

  it('a burst of parallel guesses gets no more than the allowed attempts verified', async () => {
    const app = createApp();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.50').send({ username: 'alice', password: 'wrong' })),
    );
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(7);
  });
});

describe('the local tool token (the hestia command)', () => {
  afterEach(async () => {
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests(null);
  });

  it('is written for this user only, and lets a local tool in without a login', async () => {
    const auth = await import('../../src/auth.js');
    const { stat, readFile } = await import('node:fs/promises');
    const file = path.join(stateDir, 'cli-token');
    await auth.issueLocalToolToken(file);
    const token = (await readFile(file, 'utf8')).trim();
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const app = createApp();
    expect((await request(app).get('/api/projects').set('X-Hestia-Token', token)).status).toBe(200);
    expect((await request(app).get('/api/projects').set('X-Hestia-Token', 'wrong')).status).toBe(401);
  });

  it('is refused from outside', async () => {
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests('tool-token');
    // Any forwarding header marks a request relayed, even one from a relay
    // Hestia doesn't support (auth.ts FORWARDING_HEADERS).
    const res = await request(createApp()).get('/api/projects').set('X-Hestia-Token', 'tool-token').set('CF-Connecting-IP', '203.0.113.9');
    expect(res.status).toBe(401);
  });
});

describe('bearer tokens', () => {
  async function loginToken(app: ReturnType<typeof createApp>): Promise<string> {
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    return login.body.token as string;
  }

  it('the token login returns works as `Authorization: Bearer`', async () => {
    const app = createApp();
    const token = await loginToken(app);
    expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const status = await request(app).get('/api/auth/status').set('Authorization', `Bearer ${token}`);
    expect(status.body).toEqual({ authenticated: true, username: 'alice', host: os.hostname() });
  });

  it('logout with the bearer token revokes it', async () => {
    const app = createApp();
    const token = await loginToken(app);
    expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/status').set('Authorization', `Bearer ${token}`)).body).toEqual({ authenticated: false });
  });

  it('a local-only account\'s bearer token is worthless from outside', async () => {
    const auth = await import('../../src/auth.js');
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    try {
      const app = createApp();
      const login = await request(app).post('/api/auth/login').send({ username: 'ai-dev', password: 'tool-secret' });
      const token = login.body.token as string;
      expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      const relayed = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '203.0.113.9');
      expect(relayed.status).toBe(401);
    } finally {
      delete process.env.AUTH_LOCAL_USERS;
    }
  });
});

describe('logins across an API restart', () => {
  // main.ts's startup, in fresh modules: only the state dir carries over.
  async function start(): Promise<ReturnType<typeof createApp>> {
    vi.resetModules();
    const auth = await import('../../src/auth.js');
    const { SESSION_TOKENS_PATH } = await import('../../src/config.js');
    await auth.loadSessionTokens(SESSION_TOKENS_PATH);
    return (await import('../../src/server.js')).createApp();
  }

  async function settled(): Promise<void> {
    await (await import('../../src/auth.js')).__sessionTokensWrittenForTests();
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a login or a paired device stays logged in; a logged-out one stays out', async () => {
    let app = await start();
    const loggedIn = (await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD })).body.token as string;
    const loggedOut = (await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD })).body.token as string;
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests('tool-token');
    const code = (await request(app).post('/api/auth/pairing-code').set('X-Hestia-Token', 'tool-token')).body.code as string;
    const paired = (await request(app).post('/api/auth/pair').send({ code })).body.token as string;
    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${loggedOut}`);
    await settled();

    app = await start();
    expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${loggedIn}`)).status).toBe(200);
    expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${paired}`)).status).toBe(200);
    expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${loggedOut}`)).status).toBe(401);
  });
});

describe('stream tickets', () => {
  async function bearer(app: ReturnType<typeof createApp>): Promise<string> {
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    return `Bearer ${login.body.token as string}`;
  }

  it('are only handed to a caller who is already logged in', async () => {
    const app = createApp();
    expect((await request(app).post('/api/auth/stream-ticket')).status).toBe(401);
    const res = await request(app).post('/api/auth/stream-ticket').set('Authorization', await bearer(app));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ticket: expect.stringMatching(/^[0-9a-f]{64}$/), expiresInMs: 60_000 });
  });

  it('open a stream once, and only once', async () => {
    const app = createApp();
    const { body } = await request(app).post('/api/auth/stream-ticket').set('Authorization', await bearer(app));
    // No such session: past the auth gate, the route itself answers 404.
    expect((await request(app).get(`/api/sessions/missing/events?ticket=${body.ticket as string}`)).status).toBe(404);
    expect((await request(app).get(`/api/sessions/missing/events?ticket=${body.ticket as string}`)).status).toBe(401);
  });

  it('open nothing but a stream', async () => {
    const app = createApp();
    const auth = await bearer(app);
    const { body: first } = await request(app).post('/api/auth/stream-ticket').set('Authorization', auth);
    expect((await request(app).get(`/api/projects?ticket=${first.ticket as string}`)).status).toBe(401);
    expect((await request(app).get(`/api/sessions/missing?ticket=${first.ticket as string}`)).status).toBe(401);
    const { body: second } = await request(app).post('/api/auth/stream-ticket').set('Authorization', auth);
    expect((await request(app).get(`/api/sessions/missing/pane/stream?ticket=${second.ticket as string}`)).status).toBe(404);
  });

  it('expire after a minute', async () => {
    const app = createApp();
    const { body } = await request(app).post('/api/auth/stream-ticket').set('Authorization', await bearer(app));
    const realNow = Date.now;
    Date.now = () => realNow() + 60_001;
    try {
      expect((await request(app).get(`/api/sessions/missing/events?ticket=${body.ticket as string}`)).status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  it('open the session list stream too, and only as a whole path', async () => {
    const { STREAM_PATH } = await import('../../src/server.js');
    expect(STREAM_PATH.test('/sessions/events')).toBe(true);
    expect(STREAM_PATH.test('/sessions/s1/events')).toBe(true);
    expect(STREAM_PATH.test('/sessions/s1/pane/stream')).toBe(true);
    expect(STREAM_PATH.test('/sessions/events/')).toBe(false);
    expect(STREAM_PATH.test('/sessions')).toBe(false);
    expect(STREAM_PATH.test('/sessions/s1')).toBe(false);
  });

  it('a garbage ticket is refused', async () => {
    expect((await request(createApp()).get('/api/sessions/missing/events?ticket=nope')).status).toBe(401);
  });

  it('the bearer token also opens a stream directly', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    const bearer = `Bearer ${login.body.token as string}`;
    expect((await request(app).get('/api/sessions/missing/events').set('Authorization', bearer)).status).toBe(404);
  });
});

describe('media tokens (images for <img>)', () => {
  async function bearer(app: ReturnType<typeof createApp>): Promise<string> {
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    return `Bearer ${login.body.token as string}`;
  }

  async function mediaToken(app: ReturnType<typeof createApp>, auth: string): Promise<string> {
    const res = await request(app).post('/api/auth/media-token').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: expect.stringMatching(/^[0-9a-f]{64}$/), expiresInMs: 30 * 60_000 });
    return res.body.token as string;
  }

  // No such file: past the auth gate, the route itself answers 404.
  const IMAGE = '/api/notes/uploads/missing.png';

  it('are only handed to a logged-in caller, and not for the local tool token', async () => {
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests('tool-token');
    try {
      const app = createApp();
      expect((await request(app).post('/api/auth/media-token')).status).toBe(401);
      expect((await request(app).post('/api/auth/media-token').set('X-Hestia-Token', 'tool-token')).status).toBe(401);
      await mediaToken(app, await bearer(app));
    } finally {
      auth.__setLocalToolTokenForTests(null);
    }
  });

  it('read uploaded images, more than once', async () => {
    const app = createApp();
    const token = await mediaToken(app, await bearer(app));
    expect((await request(app).get(`${IMAGE}?media=${token}`)).status).toBe(404);
    expect((await request(app).get(`${IMAGE}?media=${token}`)).status).toBe(404);
    // A session's uploads too (the session doesn't exist: 404 past the gate).
    expect((await request(app).get(`/api/sessions/missing/uploads/a.png?media=${token}`)).status).toBe(404);
  });

  it('open nothing but image reads', async () => {
    const app = createApp();
    const token = await mediaToken(app, await bearer(app));
    expect((await request(app).get(`/api/projects?media=${token}`)).status).toBe(401);
    expect((await request(app).get(`/api/sessions/missing?media=${token}`)).status).toBe(401);
    expect((await request(app).get(`/api/sessions/missing/events?media=${token}`)).status).toBe(401);
    expect((await request(app).get(`/api/notes/uploads/missing.png/?media=${token}`)).status).toBe(401);
    expect((await request(app).post(`/api/notes/uploads?media=${token}`)).status).toBe(401);
    // And a stream ticket is no image token.
    const { body } = await request(app).post('/api/auth/stream-ticket').set('Authorization', await bearer(app));
    expect((await request(app).get(`${IMAGE}?ticket=${body.ticket as string}`)).status).toBe(401);
    expect((await request(app).get(`${IMAGE}?media=${body.ticket as string}`)).status).toBe(401);
  });

  it('expire after half an hour', async () => {
    const app = createApp();
    const token = await mediaToken(app, await bearer(app));
    const realNow = Date.now;
    Date.now = () => realNow() + 30 * 60_000 + 1;
    try {
      expect((await request(app).get(`${IMAGE}?media=${token}`)).status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  it('end when the login they came from logs out', async () => {
    const app = createApp();
    const auth = await bearer(app);
    const token = await mediaToken(app, auth);
    await request(app).post('/api/auth/logout').set('Authorization', auth);
    expect((await request(app).get(`${IMAGE}?media=${token}`)).status).toBe(401);
  });

  it('a local-only account\'s media token is worthless from outside', async () => {
    const auth = await import('../../src/auth.js');
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    try {
      const app = createApp();
      const login = await request(app).post('/api/auth/login').send({ username: 'ai-dev', password: 'tool-secret' });
      const token = await mediaToken(app, `Bearer ${login.body.token as string}`);
      expect((await request(app).get(`${IMAGE}?media=${token}`)).status).toBe(404);
      expect((await request(app).get(`${IMAGE}?media=${token}`).set('X-Forwarded-For', '203.0.113.9')).status).toBe(401);
    } finally {
      delete process.env.AUTH_LOCAL_USERS;
    }
  });

  it('a garbage one is refused', async () => {
    expect((await request(createApp()).get(`${IMAGE}?media=nope`)).status).toBe(401);
  });
});

describe('pairing a device by QR code (hestia pair)', () => {
  afterEach(async () => {
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests(null);
    vi.useRealTimers();
  });

  async function pairingCode(app: ReturnType<typeof createApp>): Promise<string> {
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests('tool-token');
    const res = await request(app).post('/api/auth/pairing-code').set('X-Hestia-Token', 'tool-token');
    expect(res.status).toBe(200);
    expect(res.body.expiresInMs).toBe(3 * 60_000);
    return res.body.code as string;
  }

  it('the local tool gets a code; the phone trades it once for a login token of the main account', async () => {
    const app = createApp();
    const code = await pairingCode(app);
    const paired = await request(app).post('/api/auth/pair').set('X-Forwarded-For', '203.0.113.9').send({ code });
    expect(paired.status).toBe(200);
    expect(paired.body).toEqual({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const status = await request(app).get('/api/auth/status').set('Authorization', `Bearer ${paired.body.token as string}`);
    expect(status.body).toMatchObject({ authenticated: true, username: 'alice' });

    const again = await request(app).post('/api/auth/pair').send({ code });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('invalid_pairing_code');
  });

  it('only the local tool, from this machine, can ask for a code — not a login, not from outside', async () => {
    const auth = await import('../../src/auth.js');
    auth.__setLocalToolTokenForTests('tool-token');
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    const bearer = `Bearer ${login.body.token as string}`;
    expect((await request(app).post('/api/auth/pairing-code').set('Authorization', bearer)).status).toBe(401);
    expect((await request(app).post('/api/auth/pairing-code')).status).toBe(401);
    const outside = await request(app).post('/api/auth/pairing-code').set('X-Hestia-Token', 'tool-token').set('X-Forwarded-For', '203.0.113.9');
    expect(outside.status).toBe(401);
  });

  it('an expired code is refused', async () => {
    const app = createApp();
    const code = await pairingCode(app);
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000 + 1, toFake: ['Date'] });
    expect((await request(app).post('/api/auth/pair').send({ code })).status).toBe(401);
  });

  function status(app: ReturnType<typeof createApp>, code: string) {
    return request(app).post('/api/auth/pairing-code/status').set('X-Hestia-Token', 'tool-token').send({ code });
  }

  it('hestia pair sees the code pending, then used — by which device — and can take that login back', async () => {
    const app = createApp();
    const code = await pairingCode(app);
    const pending = await status(app, code);
    expect(pending.body).toEqual({ status: 'pending', expiresInMs: expect.any(Number) });
    expect(pending.body.expiresInMs).toBeLessThanOrEqual(3 * 60_000);

    const paired = await request(app).post('/api/auth/pair').send({ code, device: 'Pixel 10 Pro Fold\u0000 · Hestia App\n' });
    const bearer = `Bearer ${paired.body.token as string}`;
    expect((await status(app, code)).body).toEqual({ status: 'used', usedAt: expect.any(Number), device: 'Pixel 10 Pro Fold · Hestia App' });

    const revoked = await request(app).post('/api/auth/pairing-code/revoke').set('X-Hestia-Token', 'tool-token').send({ code });
    expect(revoked.body).toEqual({ ok: true, revoked: true });
    expect((await request(app).get('/api/auth/status').set('Authorization', bearer)).body).toEqual({ authenticated: false });
    // Taken back once; the code is gone with it.
    expect((await request(app).post('/api/auth/pairing-code/revoke').set('X-Hestia-Token', 'tool-token').send({ code })).body.revoked).toBe(false);
  });

  it('a code nobody used reads as expired once its time is up, and unknown codes the same', async () => {
    const app = createApp();
    const code = await pairingCode(app);
    expect((await status(app, 'never-issued')).body).toEqual({ status: 'expired' });
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000 + 1, toFake: ['Date'] });
    expect((await status(app, code)).body).toEqual({ status: 'expired' });
  });

  it('a pairing without a device name still works, and reads as an unknown device', async () => {
    const app = createApp();
    const code = await pairingCode(app);
    expect((await request(app).post('/api/auth/pair').send({ code })).status).toBe(200);
    expect((await status(app, code)).body).toMatchObject({ status: 'used', device: null });
  });

  it('only the local tool can read or revoke a code', async () => {
    const app = createApp();
    const code = await pairingCode(app);
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    const bearer = `Bearer ${login.body.token as string}`;
    for (const route of ['/api/auth/pairing-code/status', '/api/auth/pairing-code/revoke']) {
      expect((await request(app).post(route).set('Authorization', bearer).send({ code })).status).toBe(401);
      expect((await request(app).post(route).set('X-Hestia-Token', 'tool-token').set('X-Forwarded-For', '203.0.113.9').send({ code })).status).toBe(401);
    }
  });

  it('wrong codes count against the login lockout', async () => {
    const app = createApp();
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/pair').send({ code: `guess-${i}` })).status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/pair').send({ code: 'guess-6' });
    expect(locked.status).toBe(429);
  });
});


describe('login session security', () => {
  it('invalidates unspent stream tickets on logout', async () => {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    const header = `Bearer ${login.body.token as string}`;
    const ticket = await request(app).post('/api/auth/stream-ticket').set('Authorization', header);
    await request(app).post('/api/auth/logout').set('Authorization', header);
    expect((await request(app).get(`/api/sessions/missing/events?ticket=${ticket.body.ticket as string}`)).status).toBe(401);
  });

  it('lists only public session information and revokes another device', async () => {
    const app = createApp();
    const auth = await import('../../src/auth.js');
    const first = auth.issueSessionToken();
    const second = auth.issueSessionToken();
    auth.issueSessionToken({ username: 'other', localOnly: true });
    const header = `Bearer ${first}`;
    const list = await request(app).get('/api/auth/sessions').set('Authorization', header);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain(second);
    const other = list.body.sessions.find((entry: { current: boolean }) => !entry.current) as { id: string };
    expect((await request(app).delete(`/api/auth/sessions/${other.id}`).set('Authorization', header)).body).toEqual({ ok: true, revoked: true });
    expect(auth.isValidToken(second)).toBe(false);
    expect(auth.isValidToken(first)).toBe(true);
    auth.__setLocalToolTokenForTests('local');
    expect((await request(app).get('/api/auth/sessions').set('X-Hestia-Token', 'local')).status).toBe(403);
  });
});


describe('active stream revocation', () => {
  it.each(['ticket', 'bearer'])('ends an open %s stream when its login is revoked', async (credential) => {
    const app = createApp();
    const auth = await import('../../src/auth.js');
    const token = auth.issueSessionToken();
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const address = server.address() as { port: number };
    const root = `http://127.0.0.1:${address.port}/api`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      let url = `${root}/sessions/events`;
      const headers: Record<string, string> = {};
      if (credential === 'ticket') {
        const ticket = await fetch(`${root}/auth/stream-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        const body = await ticket.json() as { ticket: string };
        url += `?ticket=${body.ticket}`;
      } else headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, { headers, signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      auth.revokeToken(token);
      expect((await reader.read()).done).toBe(true);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});


describe('durable logout', () => {
  it('reports failed persistence and allows retrying the revocation', async () => {
    const auth = await import('../../src/auth.js');
    const file = path.join(stateDir, 'durable-session-tokens.json');
    await auth.loadSessionTokens(file);
    const token = auth.issueSessionToken();
    await auth.__sessionTokensWrittenForTests();
    // A directory at the file destination makes the actual atomic store
    // rename fail on all platforms, without permission assumptions.
    await rm(file);
    await mkdir(file);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp();
      const header = `Bearer ${token}`;
      const failed = await request(app).post('/api/auth/logout').set('Authorization', header);
      expect(failed.status).toBe(500);
      expect(failed.body.code).toBe('internal_error');
      expect(auth.isValidToken(token)).toBe(false);
      await rm(file, { recursive: true });
      expect((await request(app).post('/api/auth/logout').set('Authorization', header)).status).toBe(200);
      vi.resetModules();
      const restarted = await import('../../src/auth.js');
      await restarted.loadSessionTokens(file);
      expect(restarted.isValidToken(token)).toBe(false);
    } finally { error.mockRestore(); }
  });
});


describe('logout write authorization', () => {
  it('does not save session state for anonymous or random-token logout', async () => {
    vi.resetModules();
    const save = vi.fn();
    vi.doMock('@maderaojen/json-file-store', async (importOriginal) => {
      const original = await importOriginal<typeof import('@maderaojen/json-file-store')>();
      return { ...original, jsonFileStore: (options: Parameters<typeof original.jsonFileStore>[0]) => {
        const store = original.jsonFileStore(options);
        return { ...store, save: (data: unknown) => { save(); return store.save(data); } };
      } };
    });
    try {
      const auth = await import('../../src/auth.js');
      await auth.loadSessionTokens(path.join(stateDir, 'anonymous-logout.json'));
      const token = auth.issueSessionToken();
      await auth.__sessionTokensWrittenForTests();
      const { createApp: freshApp } = await import('../../src/server.js');
      const app = freshApp();
      save.mockClear();
      for (let i = 0; i < 3; i++) {
        expect((await request(app).post('/api/auth/logout')).status).toBe(200);
        expect((await request(app).post('/api/auth/logout').set('Authorization', 'Bearer random')).status).toBe(200);
      }
      expect(save).not.toHaveBeenCalled();
      await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
      expect(save).toHaveBeenCalled();
    } finally { vi.doUnmock('@maderaojen/json-file-store'); }
  });
});
