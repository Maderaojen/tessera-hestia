import { commandName, runCommand } from './shared.js';
import type { CommandRunner, HostPlatform, ProcessEntry, ProcessInspector, ProcessTable, TmuxServerLauncher } from './types.js';

// macOS has no /proc and a BSD ps whose options differ from procps':
//   - `-e` means "show the environment", not "every process": `-A` is.
//   - `comm` is argv[0] (a full path when the program was started by its
//     path), and, unless it is the last column, cut to 16 characters.
//   - tmux reports #{pane_current_command} from the kernel's p_comm, the
//     executable file's name, not argv[0]: Claude Code's executable is
//     its version (…/claude/versions/2.1.304), so tmux says `2.1.304`.
// Verified on macOS 26.7 (Apple Silicon), tmux 3.8, 2026-10-20.
const LSOF_TIMEOUT_MS = 5_000;
// lstart in the C locale: "Tue Oct 20 15:45:43 2026" (other locales
// translate it, e.g. "二 10月/20 …").
const C_LOCALE = { LC_ALL: 'C' };
const LSTART_AND_COMM = /^\s*(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

/**
 * macOS: BSD `ps` for the process table and start times, `lsof` for one
 * process's open files. The tmux server needs nothing special: tmux puts
 * itself in a session of its own, and the launchd job that runs the API
 * (install.sh's LaunchAgent) sets AbandonProcessGroup, so stopping the
 * job never signals it.
 */
export function createDarwinPlatform(deps: { run?: CommandRunner } = {}): HostPlatform {
  const run = deps.run ?? runCommand;
  return {
    id: 'darwin',
    processes: darwinProcessTable(run),
    inspector: lsofInspector(run),
    tmuxServer: noDetachNeeded,
    // install.sh's LaunchAgent: me.maderaojen.<service name>, in the GUI domain.
    service: { restartCommand: () => `launchctl kickstart -k gui/${process.getuid?.() ?? '$(id -u)'}/me.maderaojen.hestia-api` },
  };
}

const noDetachNeeded: TmuxServerLauncher = { detached: async () => null };

/** `ps -A -o pid=,ppid=,comm=` (comm last, so whole), joined with `ps -A -ww -o pid=,args=`. */
export function parseDarwinProcessTable(pidPpidComm: string, pidArgs: string): ProcessEntry[] {
  const args = new Map<number, string>();
  for (const line of pidArgs.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) args.set(Number(match[1]), match[2]!.trim());
  }
  return pidPpidComm.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    return [{ pid, ppid: Number(match[2]), comm: commandName(match[3]!), args: args.get(pid) ?? '' }];
  });
}

function darwinProcessTable(run: CommandRunner): ProcessTable {
  return {
    async list() {
      const [pidPpidComm, pidArgs] = await Promise.all([
        run('ps', ['-A', '-o', 'pid=,ppid=,comm=']),
        run('ps', ['-A', '-ww', '-o', 'pid=,args=']),
      ]);
      return parseDarwinProcessTable(pidPpidComm, pidArgs);
    },
    // What tmux on Linux reports: argv[0] of the pane's foreground process
    // group leader (the group tcgetpgrp names, as tmux asks for it).
    async paneCommand(reported, panePid) {
      if (panePid === null || !Number.isSafeInteger(panePid) || panePid < 1) return reported;
      try {
        const leader = Number((await run('ps', ['-o', 'tpgid=', '-p', String(panePid)])).trim());
        if (!Number.isSafeInteger(leader) || leader < 1) return reported;
        const name = commandName(await run('ps', ['-o', 'comm=', '-p', String(leader)]));
        return name || reported;
      } catch {
        return reported;
      }
    },
  };
}

/** `lsof -F fn` output: the executable (the first `txt` entry) and every numbered descriptor's name. */
export function parseLsofFields(output: string): { exe: string | null; openFiles: string[] } {
  let fd = '';
  let exe: string | null = null;
  const openFiles: string[] = [];
  for (const line of output.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'f') fd = value;
    else if (field === 'n') {
      if (fd === 'txt') exe ??= value;
      else if (/^\d+$/.test(fd)) openFiles.push(value);
    } else if (field === 'p') fd = '';
  }
  return { exe, openFiles };
}

function lsofInspector(run: CommandRunner): ProcessInspector {
  // Start time (to the second) and argv[0]; the start time is the fence,
  // argv[0] tightens it (a reused PID would also have to start in the same
  // second under the same name).
  async function identity(pid: number): Promise<{ startedAt: string; comm: string } | null> {
    const line = (await run('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { env: C_LOCALE })).split('\n')[0] ?? '';
    const match = LSTART_AND_COMM.exec(line);
    return match ? { startedAt: match[1]!.replace(/\s+/g, ' '), comm: commandName(match[2]!) } : null;
  }
  return {
    async inspect(pid, inspect) {
      if (!Number.isSafeInteger(pid) || pid < 2) return { status: 'unavailable' };
      try {
        const before = await identity(pid);
        if (!before) return { status: 'unavailable' };
        // -n -P: no name lookups; -w: no warnings. Exits non-zero when the
        // process is gone (or nothing could be listed): unavailable.
        const files = parseLsofFields(await run('lsof', ['-n', '-P', '-w', '-p', String(pid), '-F', 'fn'], { timeoutMs: LSOF_TIMEOUT_MS }));
        const value = await inspect({ pid, comm: before.comm, exe: files.exe, openFiles: files.openFiles });
        const after = await identity(pid).catch(() => null);
        if (!after || after.startedAt !== before.startedAt || after.comm !== before.comm) return { status: 'changed' };
        return { status: 'observed', value };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
