import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDarwinPlatform, createHostPlatform, createLinuxPlatform, createUnsupportedPlatform, useHostPlatform } from '../src/host-platform/index.js';
import { parseDarwinProcessTable, parseLsofFields } from '../src/host-platform/darwin.js';
import type { ProcFs } from '../src/host-platform/linux.js';
import type { CommandRunner } from '../src/host-platform/types.js';
import { observeCodexSession } from '../src/runtimes/codex-cli.js';
import { inspectProcess, openFilesIn } from '../src/runtimes/process-evidence.js';
import * as tmuxCli from '../src/tmux.js';

// Each platform's implementation, fed fixtures (so these run on any OS),
// then the one for this machine against real processes.

/** A CommandRunner answering from a script: `file args…` → stdout, or an Error to reject with. */
function scripted(answers: Record<string, string | Error | (() => string | Error)>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    const answer = answers[key];
    const value = typeof answer === 'function' ? answer() : answer;
    if (value === undefined) throw new Error(`unexpected command: ${key}`);
    if (value instanceof Error) throw value;
    return value;
  }) as CommandRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe('picking the platform', () => {
  it('has Linux and macOS implementations, and one that observes nothing for the rest', () => {
    expect(createHostPlatform('linux').id).toBe('linux');
    expect(createHostPlatform('darwin').id).toBe('darwin');
    // Native Windows has no tmux (WSL reports linux); nor is anything else supported.
    expect(createHostPlatform('win32').id).toBe('unsupported');
    expect(createHostPlatform('freebsd').id).toBe('unsupported');
  });

  it('an unsupported platform never claims to have seen a process', async () => {
    const inspect = vi.fn();
    expect(await createUnsupportedPlatform().inspector.inspect(1234, inspect)).toEqual({ status: 'unavailable' });
    expect(inspect).not.toHaveBeenCalled();
    expect(await createUnsupportedPlatform().tmuxServer.detached(['tmux'], 'x')).toBeNull();
  });

  it("names each platform's own way to restart the installed service", () => {
    expect(createLinuxPlatform().service.restartCommand()).toBe('systemctl --user restart hestia-api.service');
    expect(createDarwinPlatform().service.restartCommand()).toMatch(/^launchctl kickstart -k gui\/\S+\/me\.maderaojen\.hestia-api$/);
    expect(createUnsupportedPlatform().service.restartCommand()).toBeNull();
  });
});

describe('Linux: /proc and procps', () => {
  // /proc/<pid>/stat: field 22 is the start time; comm may hold spaces and ')'.
  const stat = (start: number) => `4242 (co dex)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 100`;
  function procFs(files: Record<string, string | (() => string)>, links: Record<string, string>, dirs: Record<string, string[]>): ProcFs {
    const missing = (file: string) => Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
    return {
      readFile: async (file) => {
        const content = files[file];
        if (content === undefined) throw missing(file);
        return typeof content === 'function' ? content() : content;
      },
      readlink: async (file) => { if (!(file in links)) throw missing(file); return links[file]!; },
      readdir: async (dir) => { if (!(dir in dirs)) throw missing(dir); return dirs[dir]!; },
    };
  }
  const links = {
    '/proc/4242/exe': '/opt/codex/codex',
    '/proc/4242/fd/0': '/dev/pts/3',
    '/proc/4242/fd/7': '/home/u/.codex/thread-writer-locks/x.lock',
    '/proc/4242/fd/9': 'socket:[123]',
  };
  const dirs = { '/proc/4242/fd': ['0', '7', '8', '9'] }; // 8 closed while looking

  it('reads comm, the executable and every open descriptor, fenced by the start time', async () => {
    const fs = procFs({ '/proc/4242/stat': stat(777), '/proc/4242/comm': 'codex\n' }, links, dirs);
    const inspection = await createLinuxPlatform({ fs }).inspector.inspect(4242, (view) => view);
    expect(inspection).toEqual({ status: 'observed', value: {
      pid: 4242, comm: 'codex', exe: '/opt/codex/codex',
      openFiles: ['/dev/pts/3', '/home/u/.codex/thread-writer-locks/x.lock', 'socket:[123]'],
    } });
  });

  it('reports a process that restarted under the same PID while looking as changed', async () => {
    let reads = 0;
    const fs = procFs({ '/proc/4242/stat': () => stat(reads++ === 0 ? 777 : 778), '/proc/4242/comm': 'codex\n' }, links, dirs);
    expect(await createLinuxPlatform({ fs }).inspector.inspect(4242, () => 'seen')).toEqual({ status: 'changed' });
  });

  it('fails closed: a missing process, an unreadable fd list, a bad PID, a throwing look', async () => {
    const linux = (fs: ProcFs) => createLinuxPlatform({ fs }).inspector;
    const thrower = () => { throw new Error('boom'); };
    expect(await linux(procFs({ '/proc/4242/stat': stat(777), '/proc/4242/comm': 'codex\n' }, links, dirs)).inspect(4242, thrower)).toEqual({ status: 'unavailable' });
    expect(await linux(procFs({}, {}, {})).inspect(4242, () => 'seen')).toEqual({ status: 'unavailable' });
    expect(await linux(procFs({ '/proc/4242/stat': stat(1), '/proc/4242/comm': 'codex' }, {}, {})).inspect(4242, () => 'seen')).toEqual({ status: 'unavailable' });
    expect(await linux(procFs({}, {}, {})).inspect(1, () => 'seen')).toEqual({ status: 'unavailable' });
    expect(await linux(procFs({}, {}, {})).inspect(Number.NaN, () => 'seen')).toEqual({ status: 'unavailable' });
  });

  it('lists every process with procps, and trusts tmux’s own command name', async () => {
    const run = scripted({ 'ps -e -o pid=,ppid=,comm=,args=': '    1     0 systemd /sbin/init\n  100     1 bash -bash\n  101   100 codex /opt/codex/codex --yolo\n' });
    const linux = createLinuxPlatform({ run });
    expect(await linux.processes.list()).toEqual([
      { pid: 1, ppid: 0, comm: 'systemd', args: '/sbin/init' },
      { pid: 100, ppid: 1, comm: 'bash', args: '-bash' },
      { pid: 101, ppid: 100, comm: 'codex', args: '/opt/codex/codex --yolo' },
    ]);
    expect(await linux.processes.paneCommand('claude', 100)).toBe('claude');
    expect(run.calls).toEqual(['ps -e -o pid=,ppid=,comm=,args=']);
  });

  it('starts the tmux server in a systemd user scope, when there is one (checked once)', async () => {
    const run = scripted({ 'systemd-run --user --scope --quiet --collect true': '' });
    const launcher = createLinuxPlatform({ run }).tmuxServer;
    expect(await launcher.detached(['tmux', '-L', 's', 'new-session'], 'Hestia tmux server (-L s)'))
      .toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--description=Hestia tmux server (-L s)', 'tmux', '-L', 's', 'new-session']);
    await launcher.detached(['tmux'], 'again');
    expect(run.calls).toHaveLength(1);

    const warn = vi.fn();
    const without = createLinuxPlatform({ run: scripted({ 'systemd-run --user --scope --quiet --collect true': new Error('Failed to connect to bus') }), warn });
    expect(await without.tmuxServer.detached(['tmux'], 'x')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('macOS: BSD ps and lsof', () => {
  // As macOS 26.7's ps prints them (2026-10-20): comm last, so whole; it is
  // argv[0], a full path when the program was started by its path.
  const PID_PPID_COMM = [
    '    1     0 /sbin/launchd',
    ' 4059  2620 claude',
    '19076     1 /Users/me/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex',
    '33888 33885 -zsh',
    '40000 33888 /Applications/Some App.app/Contents/MacOS/Some App',
    '',
  ].join('\n');
  const PID_ARGS = [
    '    1 /sbin/launchd',
    ' 4059 claude',
    '19076 /Users/me/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex app-server --listen unix://',
    '33888 -zsh',
    '',
  ].join('\n');

  it('joins the two ps listings into Linux-style rows: comm is a bare name', () => {
    expect(parseDarwinProcessTable(PID_PPID_COMM, PID_ARGS)).toEqual([
      { pid: 1, ppid: 0, comm: 'launchd', args: '/sbin/launchd' },
      { pid: 4059, ppid: 2620, comm: 'claude', args: 'claude' },
      { pid: 19076, ppid: 1, comm: 'codex', args: '/Users/me/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex app-server --listen unix://' },
      { pid: 33888, ppid: 33885, comm: 'zsh', args: '-zsh' },
      // Gone before the second listing: no args, still a row.
      { pid: 40000, ppid: 33888, comm: 'Some App', args: '' },
    ]);
  });

  it('lists with -A (BSD ps -e means "show the environment")', async () => {
    const run = scripted({ 'ps -A -o pid=,ppid=,comm=': PID_PPID_COMM, 'ps -A -ww -o pid=,args=': PID_ARGS });
    expect((await createDarwinPlatform({ run }).processes.list()).map((row) => row.comm)).toEqual(['launchd', 'claude', 'codex', 'zsh', 'Some App']);
  });

  // tmux on macOS names the executable file: Claude Code's is its version.
  it('names a pane’s command after its foreground process’s argv[0], as tmux on Linux does', async () => {
    const run = scripted({ 'ps -o tpgid= -p 33888': ' 4059\n', 'ps -o comm= -p 4059': 'claude\n' });
    const darwin = createDarwinPlatform({ run });
    expect(await darwin.processes.paneCommand('2.1.304', 33888)).toBe('claude');

    const shell = scripted({ 'ps -o tpgid= -p 33888': '33888\n', 'ps -o comm= -p 33888': '-zsh\n' });
    expect(await createDarwinPlatform({ run: shell }).processes.paneCommand('zsh', 33888)).toBe('zsh');
  });

  it('keeps tmux’s name when the foreground process can’t be found', async () => {
    expect(await createDarwinPlatform({ run: scripted({}) }).processes.paneCommand('2.1.304', null)).toBe('2.1.304');
    expect(await createDarwinPlatform({ run: scripted({ 'ps -o tpgid= -p 5': new Error('exit 1') }) }).processes.paneCommand('bash', 5)).toBe('bash');
    expect(await createDarwinPlatform({ run: scripted({ 'ps -o tpgid= -p 5': '0\n' }) }).processes.paneCommand('bash', 5)).toBe('bash');
  });

  // `lsof -n -P -w -p PID -F fn` as macOS 26.7's lsof 4.91 prints it.
  const LSOF = [
    'p4242',
    'fcwd', 'n/Users/me/project',
    'ftxt', 'n/Users/me/.local/bin/codex',
    'ftxt', 'n/usr/lib/dyld',
    'f0', 'n/dev/ttys003',
    'f7', 'n/Users/me/.codex/thread-writer-locks/01a0d313-7e06-7152-8a0a-02677506d4dd.lock',
    'f9', 'n->0x1234abcd',
    '',
  ].join('\n');

  it('reads lsof’s fields: the first txt is the executable, numbered descriptors are the open files', () => {
    expect(parseLsofFields(LSOF)).toEqual({
      exe: '/Users/me/.local/bin/codex',
      openFiles: ['/dev/ttys003', '/Users/me/.codex/thread-writer-locks/01a0d313-7e06-7152-8a0a-02677506d4dd.lock', '->0x1234abcd'],
    });
  });

  const IDENTITY = 'ps -o lstart=,comm= -p 4242';
  const LSOF_CALL = 'lsof -n -P -w -p 4242 -F fn';

  it('observes one process between two identical start-time readings', async () => {
    const run = scripted({ [IDENTITY]: 'Tue Oct 20 15:45:43 2026     codex\n', [LSOF_CALL]: LSOF });
    const inspection = await createDarwinPlatform({ run }).inspector.inspect(4242, (view) => view);
    expect(inspection).toEqual({ status: 'observed', value: {
      pid: 4242, comm: 'codex', exe: '/Users/me/.local/bin/codex',
      openFiles: parseLsofFields(LSOF).openFiles,
    } });
    expect(run.calls).toEqual([IDENTITY, LSOF_CALL, IDENTITY]);
  });

  it('reports a PID that now belongs to another start or another program as changed', async () => {
    for (const later of ['Tue Oct 20 15:45:44 2026     codex\n', 'Tue Oct 20 15:45:43 2026     node\n', new Error('exit 1')]) {
      let reads = 0;
      const run = scripted({ [IDENTITY]: () => (reads++ === 0 ? 'Tue Oct 20 15:45:43 2026     codex\n' : later), [LSOF_CALL]: LSOF });
      expect(await createDarwinPlatform({ run }).inspector.inspect(4242, () => 'seen')).toEqual({ status: 'changed' });
    }
  });

  it('fails closed: no such process, lsof failing, unparsable ps, a bad PID, a throwing look', async () => {
    const darwin = (answers: Parameters<typeof scripted>[0]) => createDarwinPlatform({ run: scripted(answers) }).inspector;
    const thrower = () => { throw new Error('boom'); };
    expect(await darwin({ [IDENTITY]: 'Tue Oct 20 15:45:43 2026 codex\n', [LSOF_CALL]: LSOF }).inspect(4242, thrower)).toEqual({ status: 'unavailable' });
    expect(await darwin({ [IDENTITY]: new Error('exit 1') }).inspect(4242, () => 'seen')).toEqual({ status: 'unavailable' });
    expect(await darwin({ [IDENTITY]: 'Tue Oct 20 15:45:43 2026 codex\n', [LSOF_CALL]: new Error('exit 1') }).inspect(4242, () => 'seen')).toEqual({ status: 'unavailable' });
    expect(await darwin({ [IDENTITY]: '\n' }).inspect(4242, () => 'seen')).toEqual({ status: 'unavailable' });
    expect(await darwin({}).inspect(0, () => 'seen')).toEqual({ status: 'unavailable' });
  });

  it('needs nothing to keep the tmux server out of the service: launchd abandons its process group', async () => {
    expect(await createDarwinPlatform({ run: scripted({}) }).tmuxServer.detached(['tmux'], 'x')).toBeNull();
  });
});

// This Mac's real ps, lsof and tmux. A copy of /bin/sleep is killed on
// sight by macOS (it is a platform binary), so the stand-in CLI is
// /bin/sleep run with argv[0] set to the CLI's name — which is what ps and
// tmux's pane command go by here.
describe.skipIf(process.platform !== 'darwin')('macOS, live', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); useHostPlatform(null); });

  function scratch(): string {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'host-platform-')));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function holding(name: string, file: string): Promise<ChildProcess> {
    const child = spawn('/bin/bash', ['-c', 'exec 7<"$1"; exec -a "$2" /bin/sleep 30', 'hold', file, name], { stdio: 'ignore' });
    cleanups.push(() => child.kill('SIGKILL'));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const seen = await inspectProcess(child.pid!, (view) => view.comm);
      if (seen.status === 'observed' && seen.value === name) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return child;
  }

  it('sees what a process holds open, and finds it in the process table by name', async () => {
    const dir = scratch();
    const file = path.join(dir, 'held.txt');
    writeFileSync(file, 'x');
    const child = await holding('holder', file);
    const inspection = await inspectProcess(child.pid!, (view) => ({ comm: view.comm, exe: view.exe, held: openFilesIn(view.openFiles, dir) }));
    expect(inspection).toEqual({ status: 'observed', value: { comm: 'holder', exe: '/bin/sleep', held: [file] } });
    const rows = await createHostPlatform().processes.list();
    expect(rows.find((row) => row.pid === child.pid)).toMatchObject({ comm: 'holder', ppid: process.pid });
    expect(await inspectProcess(2 ** 22 + 12345, () => null)).toEqual({ status: 'unavailable' });
  });

  it('resolves a Codex conversation from the one thread lock its process holds', async () => {
    const home = scratch();
    mkdirSync(path.join(home, 'thread-writer-locks'));
    const id = '01a0d313-7e06-7152-8a0a-02677506d4dd';
    const lock = path.join(home, 'thread-writer-locks', `${id}.lock`);
    writeFileSync(lock, '');
    const child = await holding('codex', lock);
    expect(await observeCodexSession({ pid: child.pid!, home }))
      .toEqual({ status: 'resolved', providerSessionId: id, evidence: 'process_thread_lock' });
  });

  const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasTmux)('names a tmux pane’s command the way Linux tmux does, not by the executable file', async () => {
    const socket = `hestia-platform-test-${process.pid}`;
    cleanups.push(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } });
    execFileSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'p', 'exec -a claude /bin/sleep 30']);
    let reported = '';
    let panePid = 0;
    for (let attempt = 0; attempt < 50 && reported !== 'sleep'; attempt += 1) {
      [reported = '', panePid = 0] = execFileSync('tmux', ['-L', socket, 'display-message', '-p', '-t', 'p', '#{pane_current_command}\t#{pane_pid}'], { encoding: 'utf8' }).trim().split('\t').map((v, i) => (i ? Number(v) : v)) as [string, number];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reported).toBe('sleep'); // the executable file's name
    expect(await createHostPlatform().processes.paneCommand(reported, panePid)).toBe('claude');
  });

  // launchd starts the API with no locale: tmux then prints a tab in a
  // display-message format as `_`. The pane's command must not depend on it.
  it.skipIf(!hasTmux)('reads a pane’s command without a UTF-8 locale, as under launchd', async () => {
    const socket = `hestia-platform-test-nolocale-${process.pid}`;
    cleanups.push(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } });
    execFileSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'p', 'exec -a claude /bin/sleep 30']);
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
    cleanups.push(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    tmuxCli.useSessionSockets(async () => socket);
    cleanups.push(() => tmuxCli.useSessionSockets(async () => null));
    let command: string | null = null;
    for (let attempt = 0; attempt < 50 && command !== 'claude'; attempt += 1) {
      command = await tmuxCli.getPaneCurrentCommand('p');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(command).toBe('claude');
  });
});
