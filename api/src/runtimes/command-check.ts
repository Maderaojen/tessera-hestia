import { execFile } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as tmuxCli from '../tmux.js';

const execFileAsync = promisify(execFile);

/**
 * Whether a launch executable is available in the session's provisioned
 * login-shell context (not live shell exports or functions):
 * - found: it runs (or there is nothing to say otherwise);
 * - missing: absent from that context — the launch should be refused;
 * - unknown: couldn't tell; the caller lets the launch go ahead as before.
 */
export type CommandAvailability = 'found' | 'missing' | 'unknown';

// A login shell's start-up files (nvm and the like) normally take well under
// a second; past this the answer is "unknown", never "missing".
const CHECK_TIMEOUT_MS = 5_000;
const FOUND = 'HESTIA_COMMAND_FOUND';
const MISSING = 'HESTIA_COMMAND_MISSING';
// `$1` is the executable, passed as an argument: it is never part of the script.
const CHECK_SCRIPT = `if command -v -- "$1" >/dev/null 2>&1; then echo ${FOUND}; else echo ${MISSING}; fi`;

export type CommandCheckDeps = {
  shellContext(tmuxName: string, signal: AbortSignal): Promise<tmuxCli.CommandShellContext | null>;
  runShell(shell: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
  isExecutable(file: string): Promise<boolean>;
};

const defaultDeps: CommandCheckDeps = {
  shellContext: (tmuxName, signal) => tmuxCli.getCommandShellContext(tmuxName, signal),
  async runShell(shell, args, cwd, env, signal) {
    const { stdout } = await execFileAsync(shell, args, { cwd, env, signal, maxBuffer: 256 * 1024 });
    return stdout;
  },
  async isExecutable(file) {
    try { await access(file, fsConstants.X_OK); return true; } catch { return false; }
  },
};

/**
 * A path is checked on disk. A bare name is resolved the way the pane will
 * resolve it in its provisioned context: the session's `default-shell`,
 * started as a login,
 * interactive shell (what tmux starts panes as) with the environment the
 * session inherits and overrides, in the session's directory. Changes made
 * inside an existing shell (exports/functions) cannot be observed. Custom
 * pane commands or unreadable metadata return unknown. The API's PATH is not
 * used: as a systemd service it is narrower than the pane's.
 */
export async function checkCommandAvailable(
  executable: string,
  where: { tmuxName: string; cwd: string },
  deps: CommandCheckDeps = defaultDeps,
): Promise<CommandAvailability> {
  if (!executable) return 'missing';
  if (executable.includes('/')) {
    const file = path.isAbsolute(executable) ? executable : path.resolve(where.cwd, executable);
    return (await deps.isExecutable(file)) ? 'found' : 'missing';
  }
  try {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const aborted = new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
    const context = await Promise.race([deps.shellContext(where.tmuxName, signal), aborted]);
    if (!context || signal.aborted) return 'unknown';
    const stdout = await Promise.race([deps.runShell(context.shell, ['-l', '-i', '-c', CHECK_SCRIPT, 'hestia-command-check', executable], where.cwd, context.env, signal), aborted]);
    if (stdout === null || signal.aborted) return 'unknown';
    // The last marker wins: start-up files may print their own output first.
    const lines = stdout.split('\n').map((line) => line.trim());
    const marker = [...lines].reverse().find((line) => line === FOUND || line === MISSING);
    return marker === FOUND ? 'found' : marker === MISSING ? 'missing' : 'unknown';
  } catch {
    return 'unknown';
  }
}
