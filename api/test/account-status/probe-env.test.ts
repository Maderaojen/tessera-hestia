import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { scrubProbeServerSecretEnv, tmuxDriver } from '../../src/account-status/claude.js';

describe('usage probe tmux server environment', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...call: unknown[]) => {
      (call.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void)(null, { stdout: '', stderr: '' });
    });
    process.env.AUTH_PASSWORD_HASH = 'scrypt:aa:bb';
  });

  it('starts probe panes without the API secrets', async () => {
    await tmuxDriver().start(['claude'], { PATH: '/usr/bin' }, '/tmp');
    const [command, args, options] = execFileMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command).toBe('tmux');
    expect(args.slice(0, 3)).toEqual(['-L', 'hestia-usage-probe', 'new-session']);
    expect(options.env).not.toHaveProperty('AUTH_PASSWORD_HASH');
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it('unsets the secrets on the probe socket', async () => {
    await scrubProbeServerSecretEnv();
    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'hestia-usage-probe', 'set-environment', '-g', '-u', 'AUTH_USERNAME'],
      ['-L', 'hestia-usage-probe', 'set-environment', '-g', '-u', 'AUTH_PASSWORD_HASH'],
      ['-L', 'hestia-usage-probe', 'set-environment', '-g', '-u', 'AUTH_LOCAL_USERS'],
    ]);
  });
});
