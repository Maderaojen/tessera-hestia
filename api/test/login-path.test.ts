import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginPathDirs, parseLoginPath, readLoginPath, startLoginPathRefresh } from '../src/login-path.js';
import { probePath } from '../src/probe-path.js';

// The probes also look where the login shell's PATH looks (login-path.ts):
// nvm's current folder, when the service's PATH still names a removed one.

describe('login shell PATH', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('reads the PATH between the markers, past whatever the rc files print', () => {
    const out = 'welcome!\nbash: no job control in this shell\n__HESTIA_LOGIN_PATH__/opt/nvm/v22.23.4/bin:relative:/usr/bin__HESTIA_LOGIN_PATH__\n';
    expect(parseLoginPath(out)).toEqual(['/opt/nvm/v22.23.4/bin', '/usr/bin']);
    expect(parseLoginPath('nothing here')).toBeNull();
  });

  it('runs the shell as a login, interactive one: what its rc files add is there', async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'hestia-login-path-'));
    const shell = path.join(home, 'sh');
    // A stand-in shell: prints what the real one would, given -lic and the printf.
    writeFileSync(shell, `#!/bin/sh\n[ "$1" = -lic ] || exit 3\nPATH="/opt/nvm/current/bin:$PATH"\neval "$2"\n`, { mode: 0o755 });
    const dirs = await readLoginPath(shell);
    expect(dirs?.[0]).toBe('/opt/nvm/current/bin');
  });

  it('a shell that fails or hangs up gives nothing, not an error', async () => {
    expect(await readLoginPath(null)).toBeNull();
    expect(await readLoginPath('/bin/false')).toBeNull();
  });

  it('comes after the service PATH, its own folder and the node folder, once each', () => {
    const dirs = probePath('/usr/bin:/opt/nvm/v22.17.1/bin', '/srv/node/bin/node', ['/opt/nvm/v22.23.4/bin', '/usr/bin']).split(':');
    expect(dirs.indexOf('/opt/nvm/v22.23.4/bin')).toBeGreaterThan(dirs.indexOf('/srv/node/bin'));
    expect(dirs.filter((dir) => dir === '/usr/bin')).toHaveLength(1);
  });

  it('refreshes now and then; a read that fails or finds nothing keeps the last one', async () => {
    vi.useFakeTimers();
    const reads: (string[] | null | Error)[] = [['/opt/nvm/a/bin'], null, new Error('hung up'), ['/opt/nvm/b/bin']];
    const read = vi.fn(async () => {
      const next = reads.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    });
    const stop = startLoginPathRefresh({ read, intervalMs: 1000 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(loginPathDirs()).toEqual(['/opt/nvm/a/bin']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(loginPathDirs()).toEqual(['/opt/nvm/a/bin']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(loginPathDirs()).toEqual(['/opt/nvm/a/bin']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(loginPathDirs()).toEqual(['/opt/nvm/b/bin']);
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
