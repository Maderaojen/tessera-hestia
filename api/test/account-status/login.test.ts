import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeLoginProtocol, isLoginUrl, visibleText } from '../../src/account-status/claude-login.js';
import { LoginError, LoginFlows, loginEnv, type LoginDeps } from '../../src/account-status/login.js';
import type { AccountRef } from '../../src/account-status/types.js';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-claude-login.mjs');
const CODE = 'goodcode-0123456789#state-abc';

let dir: string;
let infoFile: string;
let logs: string[];
let succeeded: AccountRef[];
let flows: LoginFlows;

function account(env: Record<string, string> = {}): AccountRef {
  return {
    id: 'native:claude:default', provider: 'claude', name: 'default', source: 'native', home: dir,
    launch: [process.execPath, FAKE], env: { FAKE_LOGIN_INFO: infoFile, ...env }, unsetEnv: ['CLAUDE_CONFIG_DIR'],
  };
}

function makeFlows(deps: Partial<LoginDeps> = {}): LoginFlows {
  return new LoginFlows({
    log: (line) => logs.push(line),
    onSucceeded: (a) => succeeded.push(a),
    ...deps,
  });
}

async function info(): Promise<{ pid: number; args: string[]; browser: string | null; configDir: string | null }> {
  return JSON.parse(await readFile(infoFile, 'utf8'));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'login-flow-'));
  infoFile = path.join(dir, 'info.json');
  logs = [];
  succeeded = [];
  process.env.CLAUDE_CONFIG_DIR = '/somewhere/else';
  flows = makeFlows();
});

afterEach(async () => {
  flows.cancelAll();
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('claudeLoginProtocol', () => {
  it('reads the URL out of its OSC 8 hyperlink once the CLI waits for the code', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&state=s';
    const out = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`;
    expect(claudeLoginProtocol.readPrompt(out)).toBeNull();
    expect(claudeLoginProtocol.readPrompt(`${out}Paste code here if prompted > `)).toEqual({ url });
    expect(visibleText('\x1b[1mbold\x1b[0m')).toBe('bold');
  });

  it('only follows Anthropic\'s own https sign-in pages', () => {
    expect(isLoginUrl('https://claude.com/cai/oauth/authorize')).toBe(true);
    expect(isLoginUrl('https://platform.claude.com/x')).toBe(true);
    expect(isLoginUrl('http://claude.com/x')).toBe(false);
    expect(isLoginUrl('https://claude.com.evil.example/x')).toBe(false);
    expect(isLoginUrl('https://localhost:5432/callback')).toBe(false);
  });

  it('takes a code only in the CLI\'s code#state shape', () => {
    expect(claudeLoginProtocol.codeLooksValid('abc#def')).toBe(true);
    expect(claudeLoginProtocol.codeLooksValid('abc')).toBe(false);
    expect(claudeLoginProtocol.codeLooksValid('abc#')).toBe(false);
    expect(claudeLoginProtocol.codeLooksValid('a b#c')).toBe(false);
  });

  it('reads the outcome and the email', () => {
    expect(claudeLoginProtocol.readOutcome('Login successful.\n', '')).toBe('succeeded');
    expect(claudeLoginProtocol.readOutcome('', 'Login failed: nope\n')).toBe('failed');
    expect(claudeLoginProtocol.readOutcome('', 'Invalid code. Please make sure the full code was copied.\n')).toBe('invalid_code');
    expect(claudeLoginProtocol.readOutcome('', '')).toBeNull();
    expect(claudeLoginProtocol.readEmail('{"loggedIn":true,"email":"a@b.c"}')).toBe('a@b.c');
    expect(claudeLoginProtocol.readEmail('not json')).toBeNull();
  });
});

describe('LoginFlows with a fake CLI', () => {
  it('starts the account\'s CLI with no browser and the parent config dir cleared, and hands back the URL', async () => {
    const started = await flows.start(account(), claudeLoginProtocol, 'me@example.com');
    expect(started).toMatchObject({ state: 'awaiting_code', expectedEmail: 'me@example.com' });
    expect(started.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    const seen = await info();
    expect(seen.args).toEqual(['auth', 'login', '--claudeai', '--email', 'me@example.com']);
    expect(seen.browser).toBe('true');
    expect(seen.configDir).toBeNull();
    expect(loginEnv(account()).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('keeps waiting after a refused code, then succeeds and compares the email', async () => {
    const started = await flows.start(account(), claudeLoginProtocol, 'Me@Example.com');
    expect(await flows.submit(started.loginId, 'nohash')).toEqual({ state: 'invalid_code', email: null, emailMatches: null });
    expect(await flows.submit(started.loginId, 'short#x')).toEqual({ state: 'invalid_code', email: null, emailMatches: null });
    const result = await flows.submit(started.loginId, `  ${CODE}  `);
    expect(result).toEqual({ state: 'succeeded', email: 'me@example.com', emailMatches: true });
    expect(succeeded.map((a) => a.id)).toEqual(['native:claude:default']);
    expect(flows.activeFor('native:claude:default')).toBe(false);
    // Nothing the CLI or the user typed is logged or returned.
    const everything = JSON.stringify([logs, result, started]);
    expect(everything).not.toContain('goodcode');
    expect(everything).not.toContain('org-secret-id');
    expect(logs).toEqual(['native:claude:default started', 'native:claude:default succeeded']);
  });

  it('says when another account signed in', async () => {
    const started = await flows.start(account({ FAKE_LOGIN_EMAIL: 'other@example.com' }), claudeLoginProtocol, 'me@example.com');
    expect(await flows.submit(started.loginId, CODE)).toEqual({ state: 'succeeded', email: 'other@example.com', emailMatches: false });
  });

  it('reports a failed exchange without the CLI\'s words', async () => {
    const started = await flows.start(account({ FAKE_LOGIN_MODE: 'fail' }), claudeLoginProtocol, null);
    const result = await flows.submit(started.loginId, CODE);
    expect(result).toEqual({ state: 'failed', email: null, emailMatches: null });
    expect(JSON.stringify([result, logs])).not.toContain('secret-');
    expect(succeeded).toEqual([]);
    await expect(flows.submit(started.loginId, CODE)).rejects.toMatchObject({ code: 'login_not_found' });
  });

  it('allows one login per account', async () => {
    const first = await flows.start(account(), claudeLoginProtocol, null);
    await expect(flows.start(account(), claudeLoginProtocol, null)).rejects.toBeInstanceOf(LoginError);
    await expect(flows.start(account(), claudeLoginProtocol, null)).rejects.toMatchObject({ code: 'login_in_progress' });
    expect(flows.cancel(first.loginId)).toBe(true);
    const again = await flows.start(account(), claudeLoginProtocol, null);
    expect(again.loginId).not.toBe(first.loginId);
  });

  it('cancelling kills the CLI', async () => {
    const started = await flows.start(account(), claudeLoginProtocol, null);
    const { pid } = await info();
    expect(alive(pid)).toBe(true);
    expect(flows.cancel(started.loginId)).toBe(true);
    await waitUntil(() => !alive(pid));
    expect(flows.cancel(started.loginId)).toBe(false);
    expect(logs).toContain('native:claude:default cancelled');
  });

  it('gives up and kills the CLI when it never offers a link', async () => {
    flows = makeFlows({ promptTimeoutMs: 300 });
    await expect(flows.start(account({ FAKE_LOGIN_MODE: 'hang' }), claudeLoginProtocol, null)).rejects.toMatchObject({ code: 'login_start_failed' });
    const { pid } = await info();
    await waitUntil(() => !alive(pid));
    await expect(flows.start(account({ FAKE_LOGIN_MODE: 'nourl' }), claudeLoginProtocol, null)).rejects.toMatchObject({ code: 'login_start_failed' });
    expect(flows.activeFor('native:claude:default')).toBe(false);
  });

  it('ends a login left waiting past its timeout', async () => {
    flows = makeFlows({ loginTimeoutMs: 400 });
    const started = await flows.start(account(), claudeLoginProtocol, null);
    const { pid } = await info();
    await waitUntil(() => !alive(pid));
    expect(flows.activeFor('native:claude:default')).toBe(false);
    await expect(flows.submit(started.loginId, CODE)).rejects.toMatchObject({ code: 'login_not_found' });
    expect(logs).toContain('native:claude:default timed out');
  });

  it('a missing CLI fails to start', async () => {
    const missing = { ...account(), launch: [path.join(dir, 'no-such-cli')] };
    await expect(flows.start(missing, claudeLoginProtocol, null)).rejects.toMatchObject({ code: 'login_start_failed' });
  });

  it('logs nothing else', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const quiet = makeFlows();
    const started = await quiet.start(account(), claudeLoginProtocol, null);
    await quiet.submit(started.loginId, CODE);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
