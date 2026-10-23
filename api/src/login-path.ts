import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from './child-env.js';

// The PATH the user's own login shell builds: what the panes see, since
// every pane starts as one. The service's own PATH is a copy taken when it
// was installed, and a version manager's folders in it go stale (nvm
// removing the node a CLI was installed under: codex no longer found by the
// probes while the panes still start it). Read from the shell itself, now
// and then, so the probes find what a pane would.

const MARK = '__HESTIA_LOGIN_PATH__';
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash']);
// A zsh with plugins can take seconds; this runs in the background.
const TIMEOUT_MS = 15_000;
const REFRESH_MS = 10 * 60_000;

let dirs: string[] = [];
let timer: NodeJS.Timeout | null = null;

/** The login shell's PATH folders as last read; empty before the first read or when it can't be read. */
export function loginPathDirs(): string[] {
  return dirs;
}

/** The shell this user logs in with, when it's one whose syntax is known here. */
export function loginShell(): string | null {
  let shell: string | undefined;
  try {
    shell = os.userInfo().shell ?? undefined;
  } catch {
    shell = undefined;
  }
  shell ||= process.env.SHELL;
  return shell && path.isAbsolute(shell) && SHELLS.has(path.basename(shell)) ? shell : null;
}

/** The PATH between the markers in the shell's output; null when they aren't there. */
export function parseLoginPath(stdout: string): string[] | null {
  const match = new RegExp(`${MARK}(.*)${MARK}`).exec(stdout);
  if (!match) return null;
  return match[1]!.split(path.delimiter).filter((dir) => path.isAbsolute(dir));
}

/** Reads it once more (an interactive login shell: nvm and the like load from the rc files). */
export function readLoginPath(shell = loginShell()): Promise<string[] | null> {
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(shell, ['-lic', `printf '\\n%s%s%s\\n' '${MARK}' "$PATH" '${MARK}'`], {
      env: childEnv(), timeout: TIMEOUT_MS, maxBuffer: 256 * 1024, cwd: os.homedir(),
    }, (_error, stdout) => resolve(parseLoginPath(String(stdout ?? ''))));
    child.stdin?.end();
  });
}

/** Reads it now and every few minutes after (main.ts); a failed read keeps the last one. */
export function startLoginPathRefresh(): void {
  const refresh = async () => {
    const read = await readLoginPath();
    if (read) dirs = read;
  };
  void refresh();
  timer ??= setInterval(() => { void refresh(); }, REFRESH_MS);
  timer.unref();
}
