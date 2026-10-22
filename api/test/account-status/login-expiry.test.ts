import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOGIN_EXPIRING_WITHIN_MS, loginExpiryAt, readClaudeLoginExpiry, refreshExpiryFromCredentials, refreshLoginState,
} from '../../src/account-status/login-expiry.js';
import { getAccountStatus, probeAccount, type SweepDeps } from '../../src/account-status/index.js';
import { mergeAccount, type Snapshot } from '../../src/account-status/snapshot.js';
import { baseStatus, type AccountRef, type AccountStatus } from '../../src/account-status/types.js';

// Dummy values standing in for real tokens: none of them may ever come out.
// Short enough that the release scan does not take them for real ones.
const ACCESS = 'sk-ant-oat01-DUMMY';
const REFRESH = 'sk-ant-ort01-DUMMY';
const EXPIRES = Date.parse('2026-10-14T05:00:00Z');

function credentials(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: EXPIRES - 1, scopes: ['user:inference'], subscriptionType: 'max', ...oauth } });
}

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'creds-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('readClaudeLoginExpiry', () => {
  it('reads refreshTokenExpiresAt and nothing else from <home>/.credentials.json', async () => {
    await writeFile(path.join(home, '.credentials.json'), credentials({ refreshTokenExpiresAt: EXPIRES }));
    const value = await readClaudeLoginExpiry({ home });
    expect(value).toBe(EXPIRES);
    const shown = JSON.stringify(loginExpiryAt(value, new Date('2026-10-11T00:00:00Z')));
    expect(shown).not.toContain(ACCESS);
    expect(shown).not.toContain(REFRESH);
    expect(shown).not.toContain('max');
  });

  it('is unknown, quietly, without the file or the field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await readClaudeLoginExpiry({ home })).toBeNull();
    await writeFile(path.join(home, '.credentials.json'), credentials({}));
    expect(await readClaudeLoginExpiry({ home })).toBeNull();
    await writeFile(path.join(home, '.credentials.json'), credentials({ refreshTokenExpiresAt: 'soon' }));
    expect(await readClaudeLoginExpiry({ home })).toBeNull();
    // A broken file: JSON.parse's message would quote it; nothing surfaces.
    await writeFile(path.join(home, '.credentials.json'), `{"claudeAiOauth":{"accessToken":"${ACCESS}",`);
    expect(await readClaudeLoginExpiry({ home })).toBeNull();
    expect(refreshExpiryFromCredentials('null')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('probeAccount', () => {
  it('reads a Claude account\'s login expiry even when its CLI isn\'t there; none for Codex', async () => {
    await writeFile(path.join(home, '.credentials.json'), credentials({ refreshTokenExpiresAt: EXPIRES }));
    const claude: AccountRef = { id: 'janus:claude:x', provider: 'claude', name: 'x', source: 'janus', home, launch: [path.join(home, 'missing-cli')], env: {}, unsetEnv: [] };
    const status = await probeAccount(claude);
    expect(status.state).toBe('not_installed');
    expect(status.login?.expiresAt).toBe(new Date(EXPIRES).toISOString());
    expect(JSON.stringify(status)).not.toContain('DUMMY');
    const codex = await probeAccount({ ...claude, id: 'janus:codex:x', provider: 'codex' });
    expect(codex.login).toBeNull();
  });
});

describe('loginExpiryAt', () => {
  const now = new Date('2026-10-11T00:00:00Z');
  it('is expiring within the CLI\'s three days, expired once passed', () => {
    expect(loginExpiryAt(null, now)).toEqual({ expiresAt: null, state: 'unknown' });
    expect(loginExpiryAt(now.getTime() + LOGIN_EXPIRING_WITHIN_MS + 1, now).state).toBe('ok');
    expect(loginExpiryAt(now.getTime() + LOGIN_EXPIRING_WITHIN_MS, now).state).toBe('expiring');
    expect(loginExpiryAt(now.getTime() + 60_000, now)).toEqual({ expiresAt: '2026-10-11T00:01:00.000Z', state: 'expiring' });
    expect(loginExpiryAt(now.getTime(), now).state).toBe('expired');
  });

  it('works the state out again from the stored time', () => {
    const stored = loginExpiryAt(Date.parse('2026-10-20T00:00:00Z'), now);
    expect(stored.state).toBe('ok');
    expect(refreshLoginState(stored, new Date('2026-10-18T00:00:00Z'))?.state).toBe('expiring');
    expect(refreshLoginState(stored, new Date('2026-10-21T00:00:00Z'))?.state).toBe('expired');
    expect(refreshLoginState(undefined, now)).toBeNull();
    expect(refreshLoginState({ expiresAt: null, state: 'unknown' }, now)?.state).toBe('unknown');
  });
});

describe('the snapshot carries it', () => {
  const ref: AccountRef = { id: 'janus:claude:a', provider: 'claude', name: 'a', source: 'janus', home: '/h/a', launch: ['janus', 'run', 'a'], env: {}, unsetEnv: [] };
  const at = (iso: string): AccountStatus => ({ ...baseStatus(ref, new Date(iso)) });

  it('takes the new login reading even when the probe failed and old numbers are kept', () => {
    const previous = mergeAccount({ ...at('2026-10-11T00:00:00Z'), state: 'ok', windows: [{ id: 'five_hour', label: '5', usedPercent: 1, remainingPercent: 99, windowMinutes: 300, resetsAt: null, resetsText: null }], login: { expiresAt: '2026-10-12T00:00:00.000Z', state: 'expiring' } }, undefined);
    const next = { ...at('2026-10-11T00:15:00Z'), state: 'error' as const, error: 'timed out', login: { expiresAt: '2026-11-11T00:00:00.000Z', state: 'ok' as const } };
    const merged = mergeAccount(next, previous);
    expect(merged.stale).toBe(true);
    expect(merged.login).toEqual({ expiresAt: '2026-11-11T00:00:00.000Z', state: 'ok' });
  });

  it('answers each read with the state as of now, and null for an old snapshot without it', async () => {
    const legacy = { ...at('2026-10-11T00:00:00Z'), id: 'janus:claude:legacy' } as Partial<AccountStatus>;
    delete legacy.login;
    const snapshot: Snapshot = {
      version: 1, sweptAt: '2026-10-11T00:00:00Z', trigger: 'schedule', janusAvailable: true,
      accounts: [{ ...at('2026-10-11T00:00:00Z'), login: { expiresAt: '2026-10-13T00:00:00.000Z', state: 'ok' } }, legacy as AccountStatus],
    };
    const deps: SweepDeps = { list: async () => ({ accounts: [], janusAvailable: true }), probe: async () => at('2026-10-11T00:00:00Z'), read: async () => snapshot, write: async () => undefined, now: () => new Date('2026-10-12T00:00:00Z') };
    const report = await getAccountStatus(deps);
    expect(report.accounts[0].login).toEqual({ expiresAt: '2026-10-13T00:00:00.000Z', state: 'expiring' });
    expect(report.accounts[1].login).toBeNull();
  });
});
