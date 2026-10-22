import { describe, expect, it, vi } from 'vitest';
import { checkCommandAvailable, type CommandCheckDeps } from '../src/runtimes/command-check.js';

const WHERE = { tmuxName: 'hestia-sess-1', cwd: '/work/project' };

function deps(patch: Partial<CommandCheckDeps> = {}): CommandCheckDeps {
  return {
    shellContext: vi.fn(async () => ({ shell: '/bin/bash', env: { PATH: '/session/bin' } })),
    runShell: vi.fn(async () => 'HESTIA_COMMAND_FOUND\n'),
    isExecutable: vi.fn(async () => true),
    ...patch,
  };
}

describe('checkCommandAvailable', () => {
  it("asks the tmux server's own shell, as a login and interactive one, in the session's folder", async () => {
    const d = deps();
    expect(await checkCommandAvailable('claude', WHERE, d)).toBe('found');
    expect(d.shellContext).toHaveBeenCalledWith('hestia-sess-1', expect.any(AbortSignal));
    const [shell, args, cwd, env] = vi.mocked(d.runShell).mock.calls[0]!;
    expect(shell).toBe('/bin/bash');
    expect(args.slice(0, 2)).toEqual(['-l', '-i']);
    expect(cwd).toBe('/work/project');
    expect(env).toEqual({ PATH: '/session/bin' });
    // The name is an argument of the script, never part of it.
    expect(args.at(-1)).toBe('claude');
    expect(args.slice(0, -1).join(' ')).not.toContain('claude');
  });

  it('says missing only when the shell says so', async () => {
    expect(await checkCommandAvailable('gemini', WHERE, deps({ runShell: async () => 'HESTIA_COMMAND_MISSING\n' }))).toBe('missing');
  });

  it("reads the last marker, after whatever the shell's start-up files print", async () => {
    const noisy = 'Welcome! HESTIA_COMMAND_MISSING\nHESTIA_COMMAND_MISSING\nnvm ready\nHESTIA_COMMAND_FOUND\n';
    expect(await checkCommandAvailable('claude', WHERE, deps({ runShell: async () => noisy }))).toBe('found');
    expect(await checkCommandAvailable('claude', WHERE, deps({ runShell: async () => 'just a banner\n' }))).toBe('unknown');
  });

  it('cannot tell when the shell is unreadable, fails or times out', async () => {
    expect(await checkCommandAvailable('claude', WHERE, deps({ shellContext: async () => null }))).toBe('unknown');
    expect(await checkCommandAvailable('claude', WHERE, deps({ shellContext: async () => { throw new Error('no tmux'); } }))).toBe('unknown');
    const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    expect(await checkCommandAvailable('claude', WHERE, deps({ runShell: async () => { throw timedOut; } }))).toBe('unknown');
  });

  it('bounds metadata lookup as well as the shell probe with one cancellation signal', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const d = deps({ shellContext: async () => new Promise(() => undefined) });
      const checking = checkCommandAvailable('claude', WHERE, d);
      controller.abort();
      expect(await checking).toBe('unknown');
      expect(d.runShell).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('checks a path on disk instead of asking the shell', async () => {
    const d = deps({ isExecutable: vi.fn(async () => false) });
    expect(await checkCommandAvailable('/opt/janus/bin/janus', WHERE, d)).toBe('missing');
    expect(d.isExecutable).toHaveBeenCalledWith('/opt/janus/bin/janus');
    expect(d.runShell).not.toHaveBeenCalled();
    expect(await checkCommandAvailable('/opt/janus/bin/janus', WHERE, deps())).toBe('found');
  });

  it("resolves a relative path from the session's folder", async () => {
    const d = deps();
    await checkCommandAvailable('./bin/tool', WHERE, d);
    expect(d.isExecutable).toHaveBeenCalledWith('/work/project/bin/tool');
  });

  it('finds a command that exists through a real shell, and misses one that does not', async () => {
    // The script really runs; only the tmux lookup is replaced (/bin/sh is always there).
    const live: CommandCheckDeps = {
      shellContext: async () => ({ shell: '/bin/sh', env: { PATH: '/bin' } }),
      runShell: async (shell, args, cwd) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        // `-l -i` is bash's; plain sh is enough to check the script itself.
        const { stdout } = await promisify(execFile)(shell, args.slice(2), { cwd });
        return stdout;
      },
      isExecutable: async () => true,
    };
    expect(await checkCommandAvailable('sh', { ...WHERE, cwd: '/' }, live)).toBe('found');
    expect(await checkCommandAvailable('hestia-no-such-cli-xyz', { ...WHERE, cwd: '/' }, live)).toBe('missing');
  });
});
