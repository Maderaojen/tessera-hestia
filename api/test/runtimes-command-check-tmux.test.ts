import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { childEnv } from '../src/child-env.js';
import { checkCommandAvailable } from '../src/runtimes/command-check.js';
import { getCommandShellContext, parseTmuxEnvironment, useSessionSockets } from '../src/tmux.js';
const exec = promisify(execFile);

it('does not reject a CLI available to the pane but absent from API environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-command-env-'));
  const socket = `hestia-command-test-${randomUUID()}`;
  const tmux = (...args: string[]) => exec('tmux', ['-L', socket, ...args], { timeout: 2_000 });
  try {
    const bin = path.join(dir, 'bin');
    const command = `hestia-cli-${randomUUID()}`;
    await mkdir(bin);
    await writeFile(path.join(bin, command), '#!/bin/sh\necho HESTIA_PANE_COMMAND_FOUND\n', { mode: 0o755 });
    const shell = path.join(dir, 'custom-shell');
    await writeFile(shell, '#!/bin/sh\nexport PATH="$HESTIA_TEST_CLI_BIN:$PATH"\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o755 });
    await tmux('new-session', '-d', '-s', 'bootstrap', '-c', dir);
    await tmux('set-option', '-g', 'default-shell', shell);
    await tmux('new-session', '-d', '-s', 'review', '-c', dir, '-e', `HESTIA_TEST_CLI_BIN=${bin}`);
    useSessionSockets(async () => socket);
    await tmux('send-keys', '-t', 'review', command, 'Enter');
    let screen = '';
    for (let i = 0; i < 40; i++) {
      screen = (await tmux('capture-pane', '-p', '-t', 'review')).stdout;
      if (screen.includes('HESTIA_PANE_COMMAND_FOUND')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(screen).toContain('HESTIA_PANE_COMMAND_FOUND');
    expect(await checkCommandAvailable(command, { tmuxName: 'review', cwd: dir })).toBe('unknown');
    // Session metadata changes do not update an existing pane's environment.
    await tmux('set-environment', '-u', '-t', 'review', 'HESTIA_TEST_CLI_BIN');
    expect(await checkCommandAvailable(command, { tmuxName: 'review', cwd: dir })).toBe('unknown');
  } finally {
    useSessionSockets(async () => null);
    await tmux('kill-server').catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses the session shell and merged environment, including removals and multiline values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-shell-context-'));
  const socket = `hestia-shell-context-${randomUUID()}`;
  const tmux = (...args: string[]) => exec('tmux', ['-L', socket, ...args], { timeout: 2_000 });
  const command = `hestia-cli-${randomUUID()}`;
  const unwantedFile = path.join(dir, 'must-not-exist');
  const quoted = `double" backslash\\ $(touch ${unwantedFile}) \`touch ${unwantedFile}\``;
  try {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(dir, '.bash_profile'), 'export PATH="$HESTIA_TEST_BIN:$PATH"\n');
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'review', '-c', dir], {
      env: { ...childEnv(), HESTIA_TEST_QUOTED: quoted }, timeout: 2_000,
    });
    await tmux('set-option', '-g', 'default-shell', '/bin/sh');
    await tmux('set-option', '-t', 'review', 'default-shell', '/bin/bash');
    await tmux('set-environment', '-g', 'HESTIA_TEST_GLOBAL', 'inherited');
    await tmux('set-environment', '-g', 'HESTIA_TEST_REMOVED', 'must-not-survive');
    await tmux('set-environment', '-r', '-t', 'review', 'HESTIA_TEST_REMOVED');
    await tmux('set-environment', '-g', 'HESTIA_TEST_OVERRIDE', 'old');
    await tmux('set-environment', '-t', 'review', 'HESTIA_TEST_OVERRIDE', 'a=b\nsecond=line');
    await tmux('set-environment', '-t', 'review', 'HESTIA_TEST_BIN', bin);
    await tmux('set-environment', '-t', 'review', 'HOME', dir);
    await tmux('set-environment', '-g', 'AUTH_USERNAME', 'must-not-leak');
    useSessionSockets(async () => socket);
    const context = await getCommandShellContext('review', AbortSignal.timeout(2_000));
    expect(context?.shell).toBe('/bin/bash');
    expect(context?.env.HESTIA_TEST_GLOBAL).toBe('inherited');
    expect(context?.env.HESTIA_TEST_REMOVED).toBeUndefined();
    expect(context?.env.HESTIA_TEST_OVERRIDE).toBe('a=b\nsecond=line');
    expect(context?.env.AUTH_USERNAME).toBeUndefined();
    expect(context?.env.HESTIA_TEST_QUOTED).toBe(quoted);
    expect(context?.env.TMUX_PANE).toMatch(/^%\d+$/);
    expect(context?.env.TMUX).toContain(socket);
    expect(await checkCommandAvailable(command, { tmuxName: 'review', cwd: dir })).toBe('found');
    expect(await checkCommandAvailable(`missing-${randomUUID()}`, { tmuxName: 'review', cwd: dir })).toBe('missing');
    expect(await access(unwantedFile).then(() => true, () => false)).toBe(false);
    await tmux('set-option', '-t', 'review', 'default-command', 'exec /bin/bash');
    expect(await checkCommandAvailable(command, { tmuxName: 'review', cwd: dir })).toBe('unknown');
    await tmux('set-option', '-t', 'review', 'default-command', '');
    await tmux('respawn-pane', '-k', '-t', 'review', 'sleep 60');
    expect(await checkCommandAvailable(command, { tmuxName: 'review', cwd: dir })).toBe('unknown');
  } finally {
    useSessionSockets(async () => null);
    await tmux('kill-server').catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects unsupported environment output instead of guessing or executing it', () => {
  expect(parseTmuxEnvironment('VALUE="a=b\nline"; export VALUE;\nunset REMOVED;\n')).toEqual(new Map([['VALUE', 'a=b\nline'], ['REMOVED', null]]));
  expect(parseTmuxEnvironment('VALUE="bad"; run-something;\n')).toBeNull();
  expect(parseTmuxEnvironment('VALUE=unquoted\n')).toBeNull();
});
