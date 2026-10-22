import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from '../child-env.js';
import type { CommandRunner, ProcessEntry } from './types.js';

const execFileAsync = promisify(execFile);

export const PS_TIMEOUT_MS = 2_000;

/** The real CommandRunner: no shell, the API's secrets left out of the child's environment. */
export const runCommand: CommandRunner = async (file, args, options = {}) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: options.timeoutMs ?? PS_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...childEnv(), ...options.env },
  });
  return String(stdout);
};

/**
 * `ps -o pid=,ppid=,comm=,args=` as procps (Linux) prints it: comm is the
 * kernel's short name and never holds a space.
 */
export function parsePidPpidCommArgs(table: string): ProcessEntry[] {
  return table.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3]!, args: match[4]! }] : [];
  });
}

/**
 * A command name as tmux's #{pane_current_command} gives it: argv[0]'s
 * base name, without the `-` a login shell's argv[0] starts with.
 */
export function commandName(argv0: string): string {
  return path.basename(argv0.trim().replace(/^-/, ''));
}
