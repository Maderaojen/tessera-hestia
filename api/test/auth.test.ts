import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let auth: typeof import('../src/auth.js');
let passwordHash: string;

beforeEach(async () => {
  vi.resetModules();
  const fresh = await import('../src/auth.js');
  passwordHash = fresh.hashPassword('correct-horse-battery-staple');
  process.env.AUTH_USERNAME = 'alice';
  process.env.AUTH_PASSWORD_HASH = passwordHash;
  auth = fresh;
});

afterEach(() => {
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD_HASH;
});

describe('hashPassword', () => {
  it('never stores the plaintext password', () => {
    expect(passwordHash).not.toContain('correct-horse-battery-staple');
  });

  it('produces a different hash each time (random salt)', () => {
    expect(auth.hashPassword('same-password')).not.toBe(auth.hashPassword('same-password'));
  });
});

describe('verifyCredentials', () => {
  it('accepts the exact configured username/password', async () => {
    expect(await auth.verifyCredentials('alice', 'correct-horse-battery-staple')).toEqual({ username: 'alice', localOnly: false });
  });

  it('rejects a wrong password', async () => {
    expect(await auth.verifyCredentials('alice', 'wrong')).toBeNull();
  });

  it('rejects a wrong username', async () => {
    expect(await auth.verifyCredentials('someone-else', 'correct-horse-battery-staple')).toBeNull();
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    process.env.AUTH_PASSWORD_HASH = 'not-a-valid-hash';
    expect(await auth.verifyCredentials('alice', 'correct-horse-battery-staple')).toBeNull();
  });

  it('rejects everything when AUTH_USERNAME/AUTH_PASSWORD_HASH are unset — never fails open', async () => {
    vi.resetModules();
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD_HASH;
    const unconfigured = await import('../src/auth.js');
    expect(await unconfigured.verifyCredentials('', '')).toBeNull();
    expect(await unconfigured.verifyCredentials('alice', 'anything')).toBeNull();
  });

  it('accepts a local-only account from AUTH_LOCAL_USERS, marked as such', async () => {
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    try {
      expect(await auth.verifyCredentials('ai-dev', 'tool-secret')).toEqual({ username: 'ai-dev', localOnly: true });
      expect(await auth.verifyCredentials('ai-dev', 'wrong')).toBeNull();
      // The main account is unaffected.
      expect(await auth.verifyCredentials('alice', 'correct-horse-battery-staple')).toEqual({ username: 'alice', localOnly: false });
    } finally {
      delete process.env.AUTH_LOCAL_USERS;
    }
  });

  // The timing must not tell whether a username exists: exactly one scrypt
  // per attempt, whatever the outcome. Counted rather than timed.
  it('runs exactly one scrypt per attempt, even for an unknown username or a malformed hash', async () => {
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    try {
      const attempts: [string, string][] = [
        ['alice', 'correct-horse-battery-staple'],
        ['alice', 'wrong'],
        ['ai-dev', 'tool-secret'],
        ['ai-dev', 'wrong'],
        ['nobody', 'whatever'],
        ['', ''],
      ];
      for (const [username, password] of attempts) {
        const before = auth.__scryptRunsForTests();
        await auth.verifyCredentials(username, password);
        expect(auth.__scryptRunsForTests() - before).toBe(1);
      }
      process.env.AUTH_PASSWORD_HASH = 'not-a-valid-hash';
      const before = auth.__scryptRunsForTests();
      expect(await auth.verifyCredentials('alice', 'correct-horse-battery-staple')).toBeNull();
      expect(auth.__scryptRunsForTests() - before).toBe(1);
    } finally {
      delete process.env.AUTH_LOCAL_USERS;
    }
  });

  it('still runs one scrypt, and lets nobody in, when nothing is configured', async () => {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD_HASH;
    const before = auth.__scryptRunsForTests();
    expect(await auth.verifyCredentials('', '')).toBeNull();
    expect(auth.__scryptRunsForTests() - before).toBe(1);
  });
});

describe('isLocalRequest', () => {
  const request = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers });

  it('is a direct loopback connection with no forwarding headers', () => {
    expect(auth.isLocalRequest(request('127.0.0.1'))).toBe(true);
    expect(auth.isLocalRequest(request('::ffff:127.0.0.1'))).toBe(true);
    expect(auth.isLocalRequest(request('::1'))).toBe(true);
  });

  it('is not anything relayed from outside, even over loopback: any forwarding header counts', () => {
    expect(auth.isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    expect(auth.isLocalRequest(request('127.0.0.1', { 'x-real-ip': '203.0.113.9' }))).toBe(false);
    expect(auth.isLocalRequest(request('127.0.0.1', { forwarded: 'for=203.0.113.9' }))).toBe(false);
    // Not a supported way in, but a relay someone puts in front anyway
    // must never pass as this machine.
    expect(auth.isLocalRequest(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }))).toBe(false);
    expect(auth.isLocalRequest(request('192.168.1.5'))).toBe(false);
  });
});

describe('accountForToken', () => {
  it('refuses a local-only account\'s token from outside, and serves the main account\'s anywhere', () => {
    const local = auth.issueSessionToken({ username: 'ai-dev', localOnly: true });
    const main = auth.issueSessionToken({ username: 'alice', localOnly: false });

    expect(auth.accountForToken(local, true)).toEqual({ username: 'ai-dev', localOnly: true });
    expect(auth.accountForToken(local, false)).toBeNull();
    expect(auth.accountForToken(main, false)).toEqual({ username: 'alice', localOnly: false });
    expect(auth.accountForToken(undefined, true)).toBeNull();
  });
});

describe('session tokens', () => {
  it('a freshly issued token is valid', () => {
    const token = auth.issueSessionToken();
    expect(auth.isValidToken(token)).toBe(true);
  });

  it('an unknown token is invalid', () => {
    expect(auth.isValidToken('not-a-real-token')).toBe(false);
  });

  it('undefined (no token sent) is invalid', () => {
    expect(auth.isValidToken(undefined)).toBe(false);
  });

  it('a revoked token stops being valid', () => {
    const token = auth.issueSessionToken();
    auth.revokeToken(token);
    expect(auth.isValidToken(token)).toBe(false);
  });

  it('each issued token is unique', () => {
    const a = auth.issueSessionToken();
    const b = auth.issueSessionToken();
    expect(a).not.toBe(b);
  });
});

describe('login tokens across a restart', () => {
  const DAY = 24 * 60 * 60_000;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-session-tokens-test-'));
    file = path.join(dir, 'session-tokens.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await auth.loadSessionTokens(file);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.AUTH_LOCAL_USERS;
    // A load that changed what's on disk (a password change logs everyone
    // out) writes it back in the background: not into a folder being removed.
    await auth.__sessionTokensWrittenForTests();
    await rm(dir, { recursive: true, force: true });
  });

  // What main.ts does at startup, in a fresh copy of the module: nothing
  // in memory survives, only what's on disk.
  async function restart(): Promise<typeof import('../src/auth.js')> {
    await auth.__sessionTokensWrittenForTests();
    vi.resetModules();
    auth = await import('../src/auth.js');
    await auth.loadSessionTokens(file);
    return auth;
  }

  async function storedTokens(): Promise<{ digest: string; username: string; lastUsedAt: number }[]> {
    await auth.__sessionTokensWrittenForTests();
    return (JSON.parse(await readFile(file, 'utf8')) as { tokens: { digest: string; username: string; lastUsedAt: number }[] }).tokens;
  }

  it('keeps a login token valid after a restart', async () => {
    const token = auth.issueSessionToken();
    await restart();
    expect(auth.accountForToken(token, false)).toEqual({ username: 'alice', localOnly: false });
    expect(auth.isValidToken(token)).toBe(true);
  });

  it('writes only the token\'s digest, to a file only this user can read', async () => {
    const token = auth.issueSessionToken();
    await auth.__sessionTokensWrittenForTests();
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(passwordHash);
    expect(raw).toContain(createHash('sha256').update(token).digest('hex'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('forgets a logged-out token for good', async () => {
    const kept = auth.issueSessionToken();
    const revoked = auth.issueSessionToken();
    auth.revokeToken(revoked);
    expect(await storedTokens()).toHaveLength(1);
    await restart();
    expect(auth.isValidToken(revoked)).toBe(false);
    expect(auth.isValidToken(kept)).toBe(true);
  });

  it('expires a token left unused for 30 days, in memory and across a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const unused = auth.issueSessionToken();
    const used = auth.issueSessionToken();

    vi.setSystemTime(start + 20 * DAY);
    expect(auth.accountForToken(used, false)).not.toBeNull();
    vi.setSystemTime(start + 29 * DAY);
    await restart();
    expect(auth.isValidToken(unused)).toBe(true);

    vi.setSystemTime(start + 31 * DAY);
    expect(auth.accountForToken(unused, false)).toBeNull();
    expect((await storedTokens()).map((t) => t.lastUsedAt)).toEqual([start + 20 * DAY]);
    // Last used on day 20, so still good on day 49 — the expiry slides.
    vi.setSystemTime(start + 49 * DAY);
    await restart();
    expect(auth.accountForToken(used, false)).not.toBeNull();
    vi.setSystemTime(start + 80 * DAY);
    await restart();
    expect(auth.isValidToken(used)).toBe(false);
    expect(await storedTokens()).toEqual([]);
  });

  it('drops an actively used login at its absolute limit across restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const token = auth.issueSessionToken();
    for (const days of [20, 40, 60, 80]) {
      vi.setSystemTime(start + days * DAY);
      expect(auth.accountForToken(token, false)).not.toBeNull();
    }
    vi.setSystemTime(start + 90 * DAY);
    await restart();
    expect(auth.isValidToken(token)).toBe(false);
    expect(await storedTokens()).toEqual([]);
  });

  it('records a token\'s use at most once an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const token = auth.issueSessionToken();
    vi.setSystemTime(start + 10 * 60_000);
    auth.accountForToken(token, false);
    expect((await storedTokens())[0].lastUsedAt).toBe(start);
    vi.setSystemTime(start + 2 * 60 * 60_000);
    auth.accountForToken(token, false);
    expect((await storedTokens())[0].lastUsedAt).toBe(start + 2 * 60 * 60_000);
  });

  it('still refuses a local-only account\'s token from outside after a restart', async () => {
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    const token = auth.issueSessionToken({ username: 'ai-dev', localOnly: true });
    await restart();
    expect(auth.accountForToken(token, false)).toBeNull();
    expect(auth.accountForToken(token, true)).toEqual({ username: 'ai-dev', localOnly: true });
  });

  it('drops the tokens of an account that no longer exists', async () => {
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    const local = auth.issueSessionToken({ username: 'ai-dev', localOnly: true });
    const main = auth.issueSessionToken();

    delete process.env.AUTH_LOCAL_USERS;
    await restart();
    expect(auth.accountForToken(local, true)).toBeNull();
    expect(auth.accountForToken(main, false)).not.toBeNull();

    process.env.AUTH_USERNAME = 'someone-else';
    await restart();
    expect(auth.isValidToken(main)).toBe(false);
    expect(await storedTokens()).toEqual([]);
  });

  it('logs everyone out when the password changes', async () => {
    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('tool-secret')}`;
    const main = auth.issueSessionToken();
    const local = auth.issueSessionToken({ username: 'ai-dev', localOnly: true });

    // The same password, set again: a new salt, so a new hash.
    process.env.AUTH_PASSWORD_HASH = auth.hashPassword('correct-horse-battery-staple');
    await restart();
    expect(auth.isValidToken(main)).toBe(false);
    expect(auth.accountForToken(local, true)).not.toBeNull();

    process.env.AUTH_LOCAL_USERS = `ai-dev=${auth.hashPassword('new-tool-secret')}`;
    await restart();
    expect(auth.accountForToken(local, true)).toBeNull();
  });

  it('starts with no tokens when the file is missing', async () => {
    await rm(file, { force: true });
    await restart();
    expect(auth.isValidToken('anything')).toBe(false);
    // And writes one once there's something to keep.
    auth.issueSessionToken();
    expect(await storedTokens()).toHaveLength(1);
  });

  it.each([
    ['corrupt', '{"version": 1, "tokens": ['],
    ['an older format', JSON.stringify([{ token: 'abc', username: 'alice' }])],
    ['an unknown version', JSON.stringify({ version: 99, tokens: [] })],
  ])('starts with no tokens, logging it, when the file is %s', async (_label, content) => {
    const token = auth.issueSessionToken();
    await auth.__sessionTokensWrittenForTests();
    await writeFile(file, content);
    await restart();
    expect(auth.isValidToken(token)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ignoring unreadable login token file'));
    // Replaced with a good (empty) one, still private.
    expect(await storedTokens()).toEqual([]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('skips malformed entries but keeps the good ones', async () => {
    const token = auth.issueSessionToken();
    await auth.__sessionTokensWrittenForTests();
    const stored = JSON.parse(await readFile(file, 'utf8')) as { tokens: unknown[] };
    stored.tokens.push({ digest: 'short', username: 'alice' }, null, 'junk');
    await writeFile(file, JSON.stringify(stored));
    await restart();
    expect(auth.isValidToken(token)).toBe(true);
  });

  // So a test that only issues tokens never writes to a real state dir,
  // and nothing can overwrite the saved tokens before they were read.
  it('writes nothing until loadSessionTokens has run', async () => {
    vi.resetModules();
    auth = await import('../src/auth.js');
    auth.issueSessionToken();
    await auth.__sessionTokensWrittenForTests();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('login lockout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not locked before any failures', () => {
    expect(auth.isLoginLocked('1.2.3.4')).toBe(false);
  });

  it('locks a source after the failure threshold, but leaves other sources alone', () => {
    for (let i = 0; i < 5; i++) auth.recordLoginFailure('1.2.3.4');
    expect(auth.isLoginLocked('1.2.3.4')).toBe(true);
    expect(auth.isLoginLocked('5.6.7.8')).toBe(false);
  });

  it('a success clears the failure count, so lockout no longer applies', () => {
    for (let i = 0; i < 4; i++) auth.recordLoginFailure('1.2.3.4');
    auth.recordLoginSuccess('1.2.3.4');
    auth.recordLoginFailure('1.2.3.4');
    expect(auth.isLoginLocked('1.2.3.4')).toBe(false);
  });

  it('the lockout expires after its window passes', () => {
    for (let i = 0; i < 5; i++) auth.recordLoginFailure('1.2.3.4');
    expect(auth.isLoginLocked('1.2.3.4')).toBe(true);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(auth.isLoginLocked('1.2.3.4')).toBe(false);
  });

  it('forgets sources that failed a little and then went quiet, so the map cannot grow forever', () => {
    for (let i = 0; i < 200; i++) auth.recordLoginFailure(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    auth.recordLoginSuccess('10.0.0.0'); // keep the global cap out of this test
    expect(auth.__loginAttemptSourcesForTests()).toBe(199);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    auth.isLoginLocked('anyone');
    expect(auth.__loginAttemptSourcesForTests()).toBe(0);
  });

  it('an old failure below the threshold no longer counts toward a lockout', () => {
    for (let i = 0; i < 4; i++) auth.recordLoginFailure('1.2.3.4');
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    auth.recordLoginFailure('1.2.3.4');
    expect(auth.isLoginLocked('1.2.3.4')).toBe(false);
  });

  it('refuses everyone once too many failures pile up across sources, until they age out', () => {
    // 10 sources, one failure each: none is locked on its own.
    for (let i = 0; i < 10; i++) auth.recordLoginFailure(`198.51.100.${i}`);
    expect(auth.isLoginLocked('203.0.113.1')).toBe(true);
    expect(auth.isLoginLocked('198.51.100.0')).toBe(true);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(auth.isLoginLocked('203.0.113.1')).toBe(false);
  });

  it('stays open just under the global cap', () => {
    for (let i = 0; i < 9; i++) auth.recordLoginFailure(`198.51.100.${i}`);
    expect(auth.isLoginLocked('203.0.113.1')).toBe(false);
  });

  it('a success takes that source\'s failures back out of the global count', () => {
    for (let i = 0; i < 5; i++) auth.recordLoginFailure(`198.51.100.${i}`);
    for (let i = 0; i < 4; i++) auth.recordLoginFailure('203.0.113.7');
    auth.recordLoginSuccess('203.0.113.7');
    for (let i = 0; i < 4; i++) auth.recordLoginFailure(`192.0.2.${i}`);
    expect(auth.isLoginLocked('203.0.113.1')).toBe(false);
  });
});

describe('loginSource', () => {
  const request = (headers: Record<string, string>, ip = '127.0.0.1') => ({ ip, headers });

  it('names the real client behind a relay, so one caller\'s failures don\'t lock out everyone', () => {
    expect(auth.loginSource(request({ 'x-forwarded-for': '198.51.100.7' }))).toBe('198.51.100.7');
    expect(auth.loginSource(request({}))).toBe('127.0.0.1');
  });

  // tailscale serve (Go's ReverseProxy) puts the address it saw last in
  // X-Forwarded-For: only the last hop is real.
  it('takes the last X-Forwarded-For hop, the one the relay appended', () => {
    expect(auth.loginSource(request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 100.64.0.5' }))).toBe('100.64.0.5');
  });

  it('cannot be steered by a client-supplied X-Forwarded-For prefix or X-Real-IP', () => {
    // Each guess claims a different "first hop" and X-Real-IP; the relay's
    // appended address is the same every time, so they share one bucket.
    const sources = new Set(
      [1, 2, 3].map((n) => auth.loginSource(request({ 'x-forwarded-for': `10.9.9.${n}, 100.64.0.5`, 'x-real-ip': `10.8.8.${n}` }))),
    );
    expect([...sources]).toEqual(['100.64.0.5']);
    // X-Real-IP on its own isn't trusted at all.
    expect(auth.loginSource(request({ 'x-real-ip': '198.51.100.4' }))).toBe('127.0.0.1');
  });

  it('ignores CF-Connecting-IP: tailscale serve passes a client\'s own value through', () => {
    const sources = new Set([1, 2, 3].map((n) => auth.loginSource(request({ 'cf-connecting-ip': `203.0.113.${n}`, 'x-forwarded-for': '100.64.0.5' }))));
    expect([...sources]).toEqual(['100.64.0.5']);
    expect(auth.loginSource(request({ 'cf-connecting-ip': '198.51.100.4' }))).toBe('127.0.0.1');
  });

  it('spoofed headers cannot dodge the lockout', () => {
    vi.useFakeTimers();
    try {
      for (let n = 0; n < 5; n++) {
        auth.recordLoginFailure(auth.loginSource(request({ 'x-forwarded-for': `10.9.9.${n}, 100.64.0.5`, 'x-real-ip': `10.8.8.${n}` })));
      }
      expect(auth.isLoginLocked(auth.loginSource(request({ 'x-forwarded-for': '10.9.9.99, 100.64.0.5' })))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('absolute session lifetime', () => {
  it('expires after 90 days even with regular activity', () => {
    const now = Date.now();
    const token = auth.issueSessionToken();
    const clock = vi.spyOn(Date, 'now');
    try {
      for (const days of [20, 40, 60, 80]) {
        clock.mockReturnValue(now + days * 86400000);
        expect(auth.accountForToken(token, true)).not.toBeNull();
      }
      clock.mockReturnValue(now + 90 * 86400000);
      expect(auth.accountForToken(token, true)).toBeNull();
    } finally { clock.mockRestore(); }
  });
});


describe('stream parent identity', () => {
  function req(token: string) { return { socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: `Bearer ${token}` } }; }
  it('rechecks parent expiry for an already authorized stream', () => {
    const token = auth.issueSessionToken();
    const request = req(token);
    expect(auth.authenticateStreamRequest(request)).not.toBeNull();
    const close = vi.fn();
    const binding = auth.streamAuthentication(request, close);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 86400000);
    try {
      expect(binding.valid()).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); binding.dispose(); }
  });
  it('does not revoke another login stream or tickets', () => {
    const first = auth.issueSessionToken();
    const second = auth.issueSessionToken();
    const firstReq = req(first);
    const secondReq = req(second);
    const ticket = auth.issueStreamTicket(secondReq)!;
    auth.authenticateStreamRequest(firstReq);
    auth.authenticateStreamRequest(secondReq);
    const closeFirst = vi.fn(); const closeSecond = vi.fn();
    const a = auth.streamAuthentication(firstReq, closeFirst);
    const b = auth.streamAuthentication(secondReq, closeSecond);
    auth.revokeToken(first);
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
    expect(auth.authenticateStreamRequest({ socket: secondReq.socket, headers: {} }, ticket)).not.toBeNull();
    a.dispose(); b.dispose();
  });
  it('closes local tool streams and tickets when the tool credential rotates', () => {
    auth.__setLocalToolTokenForTests('first');
    const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-hestia-token': 'first' } };
    const ticket = auth.issueStreamTicket(request)!;
    auth.authenticateStreamRequest(request);
    const close = vi.fn();
    const binding = auth.streamAuthentication(request, close);
    auth.__setLocalToolTokenForTests('second');
    expect(close).toHaveBeenCalledOnce();
    expect(auth.authenticateStreamRequest({ socket: request.socket, headers: {} }, ticket)).toBeNull();
    binding.dispose();
    auth.__setLocalToolTokenForTests(null);
  });
});


describe('session revocation ownership', () => {
  it('cannot list or revoke another account sessions', () => {
    const owner = { username: 'alice', localOnly: false };
    const other = { username: 'alice', localOnly: true };
    const own = auth.issueSessionToken(owner);
    const foreign = auth.issueSessionToken(other);
    const foreignId = auth.listLoginSessions(foreign, other)[0].id;
    expect(auth.listLoginSessions(own, owner)).toHaveLength(1);
    expect(auth.revokeLoginSession(foreignId, owner)).toBe(false);
    expect(auth.isValidToken(foreign)).toBe(true);
  });
});
