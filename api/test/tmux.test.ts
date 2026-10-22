import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { SESSION_PREFIX } from '../src/config.js';
import {
  classifyPaneProcessTree,
  capturePane,
  getPaneCurrentCommand,
  getPaneLiveness,
  getPaneRuntimePid,
  getPaneSize,
  isOwnTmuxName,
  killSession,
  listManagedSessionNames,
  newSession,
  pasteText,
  scrubServerSecretEnv,
  sendCommandLine,
  sendKey,
  sendText,
  sessionExists,
  sessionPresence,
  shellQuoteForDisplay,
  useSessionSockets,
} from '../src/tmux.js';
import { createLinuxPlatform, useHostPlatform } from '../src/host-platform/index.js';
import { parsePidPpidCommArgs } from '../src/host-platform/shared.js';

function resolveExecFile(stdout = ''): void {
  execFileMock.mockImplementation((...call: unknown[]) => {
    const callback = call.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout, stderr: '' });
  });
}

function rejectExecFile(error = new Error('tmux failed')): void {
  execFileMock.mockImplementation((...call: unknown[]) => {
    const callback = call.at(-1) as (error: Error) => void;
    callback(error);
  });
}

describe('tmux command wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveExecFile();
    // These pin tmux's and ps's Linux behaviour; macOS has its own (test/host-platform).
    useHostPlatform(createLinuxPlatform());
  });

  it('treats a Node pane as alive when its process tree contains the Codex binary', () => {
    const table = '100 1 bash bash\n101 100 node node /usr/lib/node_modules/codex/bin/codex.js\n102 101 codex /opt/codex/codex';
    expect(classifyPaneProcessTree({ commands: ['codex'], wrappers: ['node'] }, 'node', 100, parsePidPpidCommArgs(table))).toBe('alive');
  });

  it('walks a wrapper pane’s process tree from the pid read with its command', async () => {
    const table = '100 1 node node /usr/lib/node_modules/codex/bin/codex.js\n102 100 codex /opt/codex/codex\n';
    execFileMock.mockImplementation((...call: unknown[]) => {
      const callback = call.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
      callback(null, { stdout: call[0] === 'ps' ? table : '100 node\n', stderr: '' });
    });
    const expected = { commands: ['codex'], wrappers: ['node'] };
    await expect(getPaneLiveness('hestia-s1', expected)).resolves.toBe('alive');
    expect(execFileMock.mock.calls.map((call) => call[0])).toEqual(['tmux', 'ps']);
    await expect(getPaneRuntimePid('hestia-s1', expected)).resolves.toBe(102);
  });

  it('keeps an unidentified Node wrapper unknown instead of marking the provider dead', () => {
    expect(classifyPaneProcessTree({ commands: ['codex'], wrappers: ['node'] }, 'node', 100, parsePidPpidCommArgs('100 1 bash bash\n101 100 node node app.js'))).toBe('unknown');
  });

  afterEach(() => {
    useHostPlatform(null);
    vi.useRealTimers();
  });

  it('sends a control key with the expected argv', async () => {
    await sendKey('hestia-s1', 'Enter');

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', 'hestia-s1', 'Enter'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('sets variables on a new session with -e', async () => {
    await newSession('hestia-s1', '/tmp/project', { HESTIA_DELEGATION_ID: 'ab12cd34' });

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-d', '-s', 'hestia-s1', '-c', '/tmp/project', '-e', 'HESTIA_DELEGATION_ID=ab12cd34', '-x', '133', '-y', '40'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('creates a detached session with the configured pane size', async () => {
    await newSession('hestia-s1', '/tmp/project');

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-d', '-s', 'hestia-s1', '-c', '/tmp/project', '-x', '133', '-y', '40'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("counts a name as this install's only when its prefix is followed by a whole id", () => {
    const id = 'f036bd2e-572c-49f4-9b88-1e2e0c231c65';
    expect(isOwnTmuxName(`hestia-${id}`, 'hestia-')).toBe(true);
    // Another install on this machine with a longer prefix, or another prefix.
    expect(isOwnTmuxName(`hestia-dev-${id}`, 'hestia-')).toBe(false);
    expect(isOwnTmuxName(`other-${id}`, 'hestia-')).toBe(false);
    expect(isOwnTmuxName(`hestia-${id}`, 'hestia-dev-')).toBe(false);
    expect(isOwnTmuxName(`other-${id}`, 'other-')).toBe(true);
    expect(isOwnTmuxName('hestia-', 'hestia-')).toBe(false);
  });

  it('also lists sessions the registry records under another prefix, and nothing else of theirs', async () => {
    const recorded = 'earlier-prefix-f036bd2e-572c-49f4-9b88-1e2e0c231c65';
    const stranger = 'other-install-7ef5e54a-6598-4263-a3bd-51d7f42a9196';
    resolveExecFile(`${recorded}\n${stranger}\n`);
    const listed = await listManagedSessionNames(new Set([recorded]));
    expect(listed).toContain(recorded);
    expect(listed).not.toContain(stranger);
  });

  it('still owns a session recorded under the legacy fabrica- prefix', async () => {
    const legacy = 'fabrica-f036bd2e-572c-49f4-9b88-1e2e0c231c65';
    resolveExecFile(`${legacy}\n`);
    expect(await listManagedSessionNames(new Set([legacy]))).toEqual([legacy]);
  });

  it('checks whether a session exists and parses managed session names', async () => {
    expect(await sessionExists('hestia-s1')).toBe(true);
    const own1 = `${SESSION_PREFIX}f036bd2e-572c-49f4-9b88-1e2e0c231c65`;
    const own2 = `${SESSION_PREFIX}7ef5e54a-6598-4263-a3bd-51d7f42a9196`;
    resolveExecFile(`${own1}\nother\n ${own2} \n${SESSION_PREFIX}not-an-id\n`);
    expect(await listManagedSessionNames()).toEqual([own1, own2]);
    // The default server (older sessions) and this install's own.
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['list-sessions', '-F', '#{session_name}'],
      expect.anything(),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenLastCalledWith(
      'tmux',
      ['-L', 'hestia', 'list-sessions', '-F', '#{session_name}'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('silently ignores errors when killing an already-gone session', async () => {
    rejectExecFile();

    await expect(killSession('hestia-s1')).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'hestia-s1'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('captures panes and parses current pane size and command', async () => {
    await capturePane('hestia-s1', { ansi: true, history: 20 });
    expect(execFileMock).toHaveBeenLastCalledWith(
      'tmux',
      ['capture-pane', '-p', '-t', 'hestia-s1', '-e', '-S', '-20'],
      expect.anything(),
      expect.any(Function),
    );

    resolveExecFile('133x40\n');
    await expect(getPaneSize('hestia-s1')).resolves.toEqual({ cols: 133, rows: 40 });
    resolveExecFile('4242 claude\n');
    await expect(getPaneCurrentCommand('hestia-s1')).resolves.toBe('claude');
    expect(execFileMock.mock.calls.at(-1)?.[1]).toEqual(['display-message', '-p', '-t', 'hestia-s1', '#{pane_pid} #{pane_current_command}']);
  });

  it('sends text literally, then submits it with a separate Enter call', async () => {
    await sendText('hestia-s1', 'hello Enter');

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ['send-keys', '-t', 'hestia-s1', '-l', '--', 'hello Enter'],
      ['send-keys', '-t', 'hestia-s1', 'Enter'],
    ]);
  });

  // A message of about 5,400 Chinese characters was refused by tmux as
  // "command too long" (2026-10-20).
  it('pastes text too long for one tmux command instead of typing it', async () => {
    const stdinEnd = vi.fn();
    execFileMock.mockImplementation((...call: unknown[]) => {
      const callback = call.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
      callback(null, { stdout: '', stderr: '' });
      return { stdin: { end: stdinEnd } };
    });
    const long = '字'.repeat(6000);

    await sendText('hestia-s1', long, 0);

    const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const buffer = calls[0]![2]!;
    expect(calls).toEqual([
      ['load-buffer', '-b', buffer, '-'],
      ['paste-buffer', '-p', '-d', '-b', buffer, '-t', 'hestia-s1'],
      ['send-keys', '-t', 'hestia-s1', 'Enter'],
    ]);
    expect(stdinEnd).toHaveBeenCalledWith(long);
  });

  it('still types text that fits in one tmux command', async () => {
    const fits = '字'.repeat(2000);
    await sendText('hestia-s1', fits);
    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ['send-keys', '-t', 'hestia-s1', '-l', '--', fits],
      ['send-keys', '-t', 'hestia-s1', 'Enter'],
    ]);
  });

  it('lets the TUI consume injected text before sending the submit key', async () => {
    vi.useFakeTimers();
    const sending = sendText('hestia-s1', 'hi');
    // Finding the session's server takes a turn of the event loop.
    await vi.advanceTimersByTimeAsync(0);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'send-keys', '-t', 'hestia-s1', '-l', '--', 'hi',
    ]);

    await vi.advanceTimersByTimeAsync(99);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      'send-keys', '-t', 'hestia-s1', 'Enter',
    ]);
  });

  it("waits the caller's submit delay instead of the default when given one", async () => {
    vi.useFakeTimers();
    const sending = sendText('hestia-s1', 'hi', 250);
    await vi.advanceTimersByTimeAsync(249);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('pastes text as one bracketed paste through a private buffer fed on stdin, then submits it', async () => {
    const stdinEnd = vi.fn();
    execFileMock.mockImplementation((...call: unknown[]) => {
      const callback = call.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
      callback(null, { stdout: '', stderr: '' });
      return { stdin: { end: stdinEnd } };
    });
    const long = 'x'.repeat(200_000) + '\nsecond line';

    await pasteText('hestia-s1', long, 0);

    const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const buffer = calls[0]![2]!;
    expect(buffer).toMatch(/^hestia-paste-/);
    expect(calls).toEqual([
      ['load-buffer', '-b', buffer, '-'],
      ['paste-buffer', '-p', '-d', '-b', buffer, '-t', 'hestia-s1'],
      ['send-keys', '-t', 'hestia-s1', 'Enter'],
    ]);
    // The text never rides on argv, whatever its length.
    expect(stdinEnd).toHaveBeenCalledWith(long);
    expect(JSON.stringify(calls)).not.toContain('second line');
  });

  it('drops its buffer and sends no Enter when the paste fails', async () => {
    execFileMock.mockImplementation((...call: unknown[]) => {
      const callback = call.at(-1) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
      const args = call[1] as string[];
      if (args[0] === 'paste-buffer') callback(new Error('no pane'));
      else callback(null, { stdout: '', stderr: '' });
      return { stdin: { end: vi.fn() } };
    });

    await expect(pasteText('hestia-s1', 'hi', 0)).rejects.toThrow('no pane');

    const commands = execFileMock.mock.calls.map((call) => (call[1] as string[])[0]);
    expect(commands).toEqual(['load-buffer', 'paste-buffer', 'delete-buffer']);
  });

  it('quotes command-line arguments for the interactive shell', async () => {
    expect(shellQuoteForDisplay('plain-value')).toBe('plain-value');
    expect(shellQuoteForDisplay('with space')).toBe("'with space'");
    expect(shellQuoteForDisplay("it's")).toBe("'it'\\''s'");

    await sendCommandLine('hestia-s1', ['claude', '--name', 'a b']);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'send-keys', '-t', 'hestia-s1', '-l', '--', "claude --name 'a b'",
    ]);
  });

  it.each([
    ['sessionExists', sessionExists, false],
    ['getPaneSize', getPaneSize, null],
    ['getPaneCurrentCommand', getPaneCurrentCommand, null],
  ])('%s returns its documented fallback on tmux errors', async (_name, operation, expected) => {
    rejectExecFile();

    await expect(operation('hestia-s1')).resolves.toEqual(expected);
  });

  const tmuxFailure = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });
  // As tmux 3.4 words them.
  const NO_SERVER = [
    'error connecting to /tmp/tmux-1000/default (No such file or directory)\n',
    'no server running on /tmp/tmux-1000/default\n',
  ];

  it.each(NO_SERVER)('returns an empty list when tmux has no server (%s)', async (stderr) => {
    rejectExecFile(tmuxFailure(stderr));

    await expect(listManagedSessionNames()).resolves.toEqual([]);
  });

  it('throws, rather than reporting no sessions, when tmux fails for another reason', async () => {
    rejectExecFile(tmuxFailure('lost server\n'));

    await expect(listManagedSessionNames()).rejects.toThrow();
  });

  describe("each session's tmux server", () => {
    afterEach(() => useSessionSockets(async () => null));

    it('sends every command for a session to the server it is on', async () => {
      useSessionSockets(async (name) => (name === 'hestia-new' ? 'hestia' : null));
      await sendKey('hestia-new', 'Enter');
      expect(execFileMock).toHaveBeenLastCalledWith('tmux', ['-L', 'hestia', 'send-keys', '-t', 'hestia-new', 'Enter'], expect.anything(), expect.any(Function));
      await sendKey('hestia-old', 'Enter');
      expect(execFileMock).toHaveBeenLastCalledWith('tmux', ['send-keys', '-t', 'hestia-old', 'Enter'], expect.anything(), expect.any(Function));
    });

    it('loads and pastes the buffer on the same server as the pane', async () => {
      useSessionSockets(async () => 'hestia');
      execFileMock.mockImplementation((...call: unknown[]) => {
        const callback = call.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
        const child = { stdin: { end: () => callback(null, { stdout: '', stderr: '' }) } };
        if ((call[1] as string[]).includes('load-buffer')) return child;
        callback(null, { stdout: '', stderr: '' });
        return child;
      });
      await pasteText('hestia-new', 'hi', 0);
      const argvs = execFileMock.mock.calls.map((call) => (call[1] as string[]).slice(0, 3));
      expect(argvs.every((argv) => argv[0] === '-L' && argv[1] === 'hestia')).toBe(true);
    });

    describe('starting its own server outside the API service', () => {
      const scripted = (serverUp: boolean, scopes: boolean) => execFileMock.mockImplementation((...call: unknown[]) => {
        const [command, argv] = call as [string, string[]];
        const callback = call.at(-1) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        if (command === 'systemd-run' && !scopes) return callback(Object.assign(new Error('Failed to connect to bus'), { stderr: 'Failed to connect to bus\n' }));
        if (command === 'tmux' && argv.includes('list-sessions') && !serverUp) return callback(tmuxFailure('error connecting to /tmp/tmux-1000/hestia (No such file or directory)\n'));
        callback(null, { stdout: '', stderr: '' });
      });
      const calls = () => execFileMock.mock.calls.map((call) => [call[0], ...(call[1] as string[])].join(' '));

      beforeEach(() => {
        // A fresh one: the scope check is made once per platform instance.
        useHostPlatform(createLinuxPlatform());
        useSessionSockets(async () => 'hestia');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
      });

      it('starts the server in its own systemd scope with the first session', async () => {
        scripted(false, true);
        await newSession('hestia-new', '/p');
        const started = calls().at(-1)!;
        expect(started).toMatch(/^systemd-run --user --scope --quiet --collect --description=Hestia tmux server \(-L hestia\) tmux -L hestia new-session -d -s hestia-new -c \/p /);
      });

      it('just opens the session once the server is running', async () => {
        scripted(true, true);
        await newSession('hestia-new', '/p');
        expect(calls().filter((call) => call.startsWith('systemd-run'))).toEqual([]);
        expect(calls().at(-1)).toMatch(/^tmux -L hestia new-session -d -s hestia-new/);
      });

      it('falls back to starting it here where systemd-run cannot', async () => {
        scripted(false, false);
        await newSession('hestia-new', '/p');
        expect(calls().at(-1)).toMatch(/^tmux -L hestia new-session -d -s hestia-new/);
      });
    });

    it('lists sessions on both the default server and its own', async () => {
      const own1 = `${SESSION_PREFIX}f036bd2e-572c-49f4-9b88-1e2e0c231c65`;
      const own2 = `${SESSION_PREFIX}7ef5e54a-6598-4263-a3bd-51d7f42a9196`;
      execFileMock.mockImplementation((...call: unknown[]) => {
        const callback = call.at(-1) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: (call[1] as string[])[0] === '-L' ? `${own2}\n` : `${own1}\n`, stderr: '' });
      });
      expect((await listManagedSessionNames()).sort()).toEqual([own1, own2].sort());
    });

    it('skips a server that is not running, but not a failing one', async () => {
      const own = `${SESSION_PREFIX}f036bd2e-572c-49f4-9b88-1e2e0c231c65`;
      execFileMock.mockImplementation((...call: unknown[]) => {
        const callback = call.at(-1) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        if ((call[1] as string[])[0] === '-L') callback(null, { stdout: `${own}\n`, stderr: '' });
        else callback(tmuxFailure('no server running on /tmp/tmux-1000/default\n'));
      });
      expect(await listManagedSessionNames()).toEqual([own]);
    });
  });

  describe('sessionPresence', () => {
    it('is present when tmux has that exact session', async () => {
      await expect(sessionPresence('hestia-s1')).resolves.toBe('present');
      expect(execFileMock).toHaveBeenLastCalledWith('tmux', ['has-session', '-t', '=hestia-s1'], expect.anything(), expect.any(Function));
    });

    it.each(["can't find session: hestia-s1\n", ...NO_SERVER])('is gone when tmux says so (%s)', async (stderr) => {
      rejectExecFile(tmuxFailure(stderr));
      await expect(sessionPresence('hestia-s1')).resolves.toBe('gone');
    });

    it('is unknown when tmux fails for any other reason', async () => {
      rejectExecFile(tmuxFailure('lost server\n'));
      await expect(sessionPresence('hestia-s1')).resolves.toBe('unknown');
      rejectExecFile(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }));
      await expect(sessionPresence('hestia-s1')).resolves.toBe('unknown');
    });
  });

  describe('secret environment', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      Object.assign(process.env, {
        AUTH_USERNAME: 'alice', AUTH_PASSWORD_HASH: 'scrypt:aa:bb', AUTH_LOCAL_USERS: 'ai-dev:scrypt:cc:dd', HESTIA_STATE_DIR: '/tmp/state',
      });
    });
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });

    it('runs tmux without the API secrets but with the ordinary variables', async () => {
      await newSession('hestia-s1', '/tmp/project');

      const env = (execFileMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env).not.toHaveProperty('AUTH_USERNAME');
      expect(env).not.toHaveProperty('AUTH_PASSWORD_HASH');
      expect(env).not.toHaveProperty('AUTH_LOCAL_USERS');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.HESTIA_STATE_DIR).toBe('/tmp/state');
      expect(process.env.AUTH_PASSWORD_HASH).toBe('scrypt:aa:bb'); // the API's own env is untouched
    });

    it('unsets every secret from the default server and its own', async () => {
      await scrubServerSecretEnv();

      expect(execFileMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        ['tmux', ['set-environment', '-g', '-u', 'AUTH_USERNAME']],
        ['tmux', ['set-environment', '-g', '-u', 'AUTH_PASSWORD_HASH']],
        ['tmux', ['set-environment', '-g', '-u', 'AUTH_LOCAL_USERS']],
        ['tmux', ['-L', 'hestia', 'set-environment', '-g', '-u', 'AUTH_USERNAME']],
        ['tmux', ['-L', 'hestia', 'set-environment', '-g', '-u', 'AUTH_PASSWORD_HASH']],
        ['tmux', ['-L', 'hestia', 'set-environment', '-g', '-u', 'AUTH_LOCAL_USERS']],
      ]);
      const env = (execFileMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
      expect(env).not.toHaveProperty('AUTH_PASSWORD_HASH');
    });

    it('does nothing more when no tmux server is running', async () => {
      rejectExecFile(Object.assign(new Error('Command failed'), { stderr: 'no server running on /tmp/tmux-1000/default\n' }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(scrubServerSecretEnv()).resolves.toBeUndefined();
      // One try per server.
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
