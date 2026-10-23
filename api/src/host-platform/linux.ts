import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { parsePidPpidCommArgs, runCommand } from './shared.js';
import type { CommandRunner, HostPlatform, ProcessInspector, ProcessTable, TmuxServerLauncher } from './types.js';

/** The parts of node:fs/promises the /proc reader uses; replaced by fixtures in tests. */
export type ProcFs = {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  readlink(file: string): Promise<string>;
};

const realProcFs: ProcFs = { readFile, readdir, readlink };

/**
 * Linux: /proc for one process's open files, procps `ps` for the table,
 * and a transient systemd user scope for the tmux server.
 */
export function createLinuxPlatform(deps: { fs?: ProcFs; run?: CommandRunner; warn?: (message: string, error: unknown) => void } = {}): HostPlatform {
  const fs = deps.fs ?? realProcFs;
  const run = deps.run ?? runCommand;
  const warn = deps.warn ?? ((message, error) => console.warn(message, error));
  return {
    id: 'linux',
    processes: linuxProcessTable(run),
    inspector: procInspector(fs),
    tmuxServer: systemdScopeLauncher(run, warn),
    service: { restartCommand: () => 'systemctl --user restart hestia-api.service' },
    sshd: { remoteLoginSetting: false },
  };
}

function linuxProcessTable(run: CommandRunner): ProcessTable {
  return {
    async list() {
      return parsePidPpidCommArgs(await run('ps', ['-e', '-o', 'pid=,ppid=,comm=,args=']));
    },
    // tmux on Linux already reports argv[0]'s base name (/proc/<pid>/cmdline).
    async paneCommand(reported) {
      return reported;
    },
  };
}

function procInspector(fs: ProcFs): ProcessInspector {
  // /proc/<pid>/stat field 22 (starttime), counted after the parenthesised
  // comm, which may itself contain spaces or parentheses.
  async function readStartTime(proc: string): Promise<string | null> {
    const stat = await fs.readFile(path.join(proc, 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null;
  }
  return {
    async inspect(pid, inspect) {
      if (!Number.isSafeInteger(pid) || pid < 2) return { status: 'unavailable' };
      const proc = `/proc/${pid}`;
      try {
        const startedAt = await readStartTime(proc);
        if (!startedAt) return { status: 'unavailable' };
        const [comm, exe, fds] = await Promise.all([
          fs.readFile(path.join(proc, 'comm'), 'utf8'),
          fs.readlink(path.join(proc, 'exe')).catch(() => null),
          fs.readdir(path.join(proc, 'fd')),
        ]);
        const targets = await Promise.all(fds.map((fd) => fs.readlink(path.join(proc, 'fd', fd)).catch(() => null)));
        const value = await inspect({
          pid,
          comm: comm.trim(),
          exe,
          openFiles: targets.filter((target): target is string => target !== null),
        });
        if (await readStartTime(proc).catch(() => null) !== startedAt) return { status: 'changed' };
        return { status: 'observed', value };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}

// `systemd-run --user --scope` runs the command in a new transient scope
// of the user's systemd: same environment as here, but its own cgroup,
// which a tmux server it starts (and every pane) keeps. Removed once the
// server exits (--collect). The unit's KillMode=process (install.sh) is
// the other half: stopping the service only stops node.
const SCOPE_ARGS = ['--user', '--scope', '--quiet', '--collect'];

function systemdScopeLauncher(run: CommandRunner, warn: (message: string, error: unknown) => void): TmuxServerLauncher {
  let scopes: Promise<boolean> | null = null;
  // Whether this machine can start a user scope (systemd user instance reachable); checked once.
  const canRunScopes = () => scopes ??= run('systemd-run', [...SCOPE_ARGS, 'true'], { timeoutMs: 5_000 }).then(
    () => true,
    (err: unknown) => {
      warn('[tmux] systemd-run --user --scope is unavailable; the tmux server starts inside the API service', err);
      return false;
    },
  );
  return {
    async detached(argv, description) {
      return await canRunScopes() ? ['systemd-run', ...SCOPE_ARGS, `--description=${description}`, ...argv] : null;
    },
  };
}
