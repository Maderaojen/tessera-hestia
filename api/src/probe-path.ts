import path from 'node:path';
import { USER_BIN_DIR } from './config.js';
import { loginPathDirs } from './login-path.js';

// The API runs as a systemd user service whose PATH is the bare system
// default — no ~/.local/bin (USER_BIN_DIR: janus, claude) and no nvm bin (codex, and the
// `node` its shebang needs). CLIs it runs on its own (account probes, model
// lists) get those appended; the directory of the node binary running this
// server is where npm-installed CLIs live. Last, the login shell's own
// PATH (login-path.ts): what a pane sees, where a version manager's
// current folders are even after the ones in the service's PATH went stale.
export function probePath(base = process.env.PATH ?? '', nodeBinary = process.execPath, login: string[] = loginPathDirs()): string {
  const dirs = [...base.split(path.delimiter), USER_BIN_DIR, path.dirname(nodeBinary), ...login];
  return [...new Set(dirs.filter(Boolean))].join(path.delimiter);
}
