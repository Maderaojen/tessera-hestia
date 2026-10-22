import { afterEach, describe, expect, it, vi } from 'vitest';
import { childEnv, scrubTmuxServerEnv, SECRET_ENV_NAMES } from '../src/child-env.js';

describe('childEnv', () => {
  it('drops the login secrets and keeps everything else', () => {
    const base = {
      AUTH_USERNAME: 'alice', AUTH_PASSWORD_HASH: 'scrypt:aa:bb', AUTH_LOCAL_USERS: 'ai-dev:scrypt:cc:dd',
      AUTH_MAX_LOGIN_ATTEMPTS: '5', PATH: '/usr/bin', HOME: '/home/dev', PORT: '4791', HESTIA_STATE_DIR: '/tmp/state',
    };
    expect(childEnv(base)).toEqual({
      AUTH_MAX_LOGIN_ATTEMPTS: '5', PATH: '/usr/bin', HOME: '/home/dev', PORT: '4791', HESTIA_STATE_DIR: '/tmp/state',
    });
    expect(base.AUTH_PASSWORD_HASH).toBe('scrypt:aa:bb');
  });

  it('names at least the credentials the API reads from .env', () => {
    expect(SECRET_ENV_NAMES).toEqual(expect.arrayContaining(['AUTH_USERNAME', 'AUTH_PASSWORD_HASH', 'AUTH_LOCAL_USERS']));
  });
});

describe('scrubTmuxServerEnv', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('unsets each secret from the global environment', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '' });
    await scrubTmuxServerEnv(run);
    expect(run.mock.calls).toEqual(SECRET_ENV_NAMES.map((name) => [['set-environment', '-g', '-u', name]]));
  });

  it.each([
    'no server running on /tmp/tmux-1000/default',
    'error connecting to /tmp/tmux-1000/hestia-usage-probe (No such file or directory)',
  ])('stops quietly when there is no server (%s)', async (stderr) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('Command failed'), { stderr }));
    await expect(scrubTmuxServerEnv(run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps going past a variable the server never had', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Command failed'), { stderr: 'unknown variable: AUTH_USERNAME' }))
      .mockResolvedValue({ stdout: '' });
    await scrubTmuxServerEnv(run);
    expect(run).toHaveBeenCalledTimes(SECRET_ENV_NAMES.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an unexpected failure once and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(new Error('spawn tmux EACCES'));
    await expect(scrubTmuxServerEnv(run, 'usage probe')).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('usage probe');
  });
});
