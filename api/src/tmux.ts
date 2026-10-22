import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv, scrubTmuxServerEnv } from './child-env.js';
import {
  PANE_COLS,
  PANE_ROWS,
  SESSION_PREFIX,
  TMUX_SOCKET,
} from './config.js';
import { hostPlatform, type ProcessEntry } from './host-platform/index.js';
import { UUID_SHAPE } from './ids.js';

const execFileAsync = promisify(execFile);
// Pause between typed text and its Enter when the caller names none: shell
// command lines, and runtimes that haven't measured their own
// (RuntimeDriver.submitDelayMs). Harmless where it isn't needed.
const DEFAULT_SUBMIT_DELAY_MS = 100;
// What a pane falls back to once the CLI in it exits.
const SHELL_COMMANDS = ['bash', 'zsh', 'sh', 'fish', 'dash'];

// Every call below shells out via execFile (argv array, no shell
// interpolation) so pane text, cwd paths, etc. never pass through a shell
// and can't be used for command injection. The env drops the API's secrets:
// a tmux server started by one of these calls keeps its environment for
// every pane it ever creates.
// `socket`: the `-L` server to run on; null is the user's default server.
async function tmux(args: string[], socket: string | null = null): Promise<string> {
  const { stdout } = await execFileAsync('tmux', socket ? ['-L', socket, ...args] : args, { env: childEnv() });
  return stdout;
}

// Which tmux server a session is on: the one its record names (null for the
// default server, where sessions opened before TMUX_SOCKET live), or
// TMUX_SOCKET for a session not recorded yet (one being opened now). Set
// once at start-up from the registry (main.ts); unset, everything runs on
// the default server.
export type SocketLookup = (name: string) => Promise<string | null>;
let socketLookup: SocketLookup = async () => null;

export function useSessionSockets(lookup: SocketLookup): void {
  socketLookup = lookup;
}

/** The servers this install's sessions can be on: the default one (older sessions) and its own. */
function servers(): (string | null)[] {
  return [null, TMUX_SOCKET];
}

async function tmuxFor(name: string, args: string[]): Promise<string> {
  return tmux(args, await socketLookup(name));
}

/** Clear the API's secrets from the already-running tmux servers this install uses. */
export async function scrubServerSecretEnv(): Promise<void> {
  for (const socket of servers()) {
    await scrubTmuxServerEnv((args) => tmux(args, socket), socket ?? 'default');
  }
}

export class TmuxError extends Error {}

// Non-printable keys a human might need to send by hand to drive a CLI's
// local UI (permission menus, /status-style panels, ...). Verified by hand
// against Claude Code 2.1.276: Right/Right/Enter navigates a panel's tab
// bar, Escape dismisses one, and typing a bare digit (ordinary literal
// text, not a control key) jumps straight to that numbered menu option.
export const CONTROL_KEYS = ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'C-c'] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];

export async function sendKey(target: string, key: ControlKey): Promise<void> {
  await tmuxFor(target, ['send-keys', '-t', target, key]);
}

// How tmux 3.4 says there is no server at all: no socket file, or a socket
// nobody answers on.
const NO_SERVER_RE = /^(?:no server running on |error connecting to .*\(No such file or directory\))/m;
const NO_SUCH_SESSION_RE = /^can't find session: /m;

function tmuxStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

export type TmuxPresence = 'present' | 'gone' | 'unknown';

/**
 * Whether this exact tmux session exists ('=' turns off tmux's prefix
 * matching). 'gone' only when tmux itself says so — no such session, or no
 * server at all; any other failure (tmux missing, a timeout) is 'unknown',
 * which callers must not treat as gone.
 */
export async function sessionPresence(name: string): Promise<TmuxPresence> {
  try {
    await tmuxFor(name, ['has-session', '-t', `=${name}`]);
    return 'present';
  } catch (error) {
    const stderr = tmuxStderr(error);
    return NO_SUCH_SESSION_RE.test(stderr) || NO_SERVER_RE.test(stderr) ? 'gone' : 'unknown';
  }
}

/** Whether this install's own tmux server is up at all; null when tmux can't tell. */
export async function serverRunning(): Promise<boolean | null> {
  try {
    await tmux(['list-sessions', '-F', '#{session_name}'], TMUX_SOCKET);
    return true;
  } catch (error) {
    return NO_SERVER_RE.test(tmuxStderr(error)) ? false : null;
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  try {
    await tmuxFor(name, ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

// `env`: variables set on the tmux session itself (`-e`, tmux 3.0+), so
// every CLI started in it sees them — also one relaunched later in the
// same tmux.
export async function newSession(name: string, cwd: string, env: Record<string, string> = {}): Promise<void> {
  const vars = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const args = ['new-session', '-d', '-s', name, '-c', cwd, ...vars, '-x', String(PANE_COLS), '-y', String(PANE_ROWS)];
  const socket = await socketLookup(name);
  // The session that starts this install's own server starts it the
  // platform's way (host-platform/: a systemd scope on Linux), so
  // restarting or stopping the service never takes the tmux, and every CLI
  // in it, along.
  if (socket && await serverAbsent(socket)) {
    const detached = await hostPlatform().tmuxServer.detached(['tmux', '-L', socket, ...args], `Hestia tmux server (-L ${socket})`);
    if (detached) {
      await execFileAsync(detached[0]!, detached.slice(1), { env: childEnv() });
      return;
    }
  }
  await tmux(args, socket);
}

async function serverAbsent(socket: string): Promise<boolean> {
  try {
    await tmux(['list-sessions', '-F', '#{session_name}'], socket);
    return false;
  } catch (error) {
    return NO_SERVER_RE.test(tmuxStderr(error));
  }
}

// Kills whatever is running in the session's pane and starts a fresh shell
// in `cwd`, keeping the tmux session itself. Only ever run after the user
// explicitly agreed to force-close a CLI that wouldn't /exit.
export async function respawnPane(target: string, cwd: string): Promise<void> {
  await tmuxFor(target, ['respawn-pane', '-k', '-t', target, '-c', cwd]);
}

export type CommandShellContext = { shell: string; env: NodeJS.ProcessEnv };

/** Decode tmux's Bourne-shell output as data, never by executing it. */
export function parseTmuxEnvironment(text: string): Map<string, string | null> | null {
  const values = new Map<string, string | null>();
  const entry = /(?:unset ([A-Za-z_][A-Za-z0-9_]*);|([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\[\s\S])*)"; export \2;)\n/gy;
  let offset = 0;
  while (offset < text.length) {
    entry.lastIndex = offset;
    const match = entry.exec(text);
    if (!match) return null;
    if (match[1]) values.set(match[1], null);
    else values.set(match[2]!, match[3]!.replace(/\\([\s\S])/g, '$1'));
    offset = entry.lastIndex;
  }
  return values;
}

/**
 * The session's provisioned login-shell context, not a snapshot of exports
 * or functions changed by a human in an already-running shell. Custom
 * commands/shells cannot be reproduced reliably and deliberately fail open.
 */
export async function getCommandShellContext(target: string, signal: AbortSignal): Promise<CommandShellContext | null> {
  try {
    const socket = await socketLookup(target);
    if (signal.aborted) return null;
    const run = async (args: string[]) => (await execFileAsync('tmux', socket ? ['-L', socket, ...args] : args, {
      env: childEnv(), signal, maxBuffer: 256 * 1024,
    })).stdout;
    const session = `=${target}:`;
    const [shellText, command, paneText, terminal, globalText, sessionText] = await Promise.all([
      run(['show-options', '-Av', '-t', session, 'default-shell']),
      run(['show-options', '-Av', '-t', session, 'default-command']),
      run(['display-message', '-p', '-t', session, '#{pane_start_command}\n#{pane_id}\n#{socket_path}\n#{pid}\n#{session_id}']),
      run(['show-options', '-sv', 'default-terminal']),
      run(['show-environment', '-gs']),
      run(['show-environment', '-s', '-t', session]),
    ]);
    const shell = shellText.trim();
    const fields = paneText.split('\n');
    if (fields.length !== 6) return null;
    const [paneCommand, paneId, socketPath, serverPid, sessionId, trailing] = fields;
    if (trailing !== '' || !paneId || !socketPath || !/^\d+$/.test(serverPid ?? '') || !/^\$\d+$/.test(sessionId ?? '')) return null;
    if (!path.isAbsolute(shell) || !['bash', 'zsh', 'sh', 'dash'].includes(path.basename(shell)) || command.trim() || paneCommand?.trim()) return null;
    const global = parseTmuxEnvironment(globalText);
    const local = parseTmuxEnvironment(sessionText);
    if (!global || !local) return null;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of [...global, ...local]) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    env.SHELL = shell;
    env.TERM = terminal.trim();
    env.TMUX_PANE = paneId;
    env.TMUX = `${socketPath},${serverPid},${sessionId!.slice(1)}`;
    return { shell, env: childEnv(env) };
  } catch {
    return null;
  }
}

export async function killSession(name: string): Promise<void> {
  try {
    await tmuxFor(name, ['kill-session', '-t', name]);
  } catch {
    // already gone — fine, this is best-effort cleanup.
  }
}

/**
 * Whether a tmux session name is one this install gives its sessions:
 * `${prefix}${uuid}` exactly. A longer prefix of another install on the
 * same machine (`hestia-` vs `hestia-dev-`) doesn't match,
 * since what follows ours must be the whole id.
 */
export function isOwnTmuxName(name: string, prefix: string = SESSION_PREFIX): boolean {
  return name.startsWith(prefix) && UUID_SHAPE.test(name.slice(prefix.length));
}

// Lists every tmux session this tool manages: named with this install's
// prefix, or one of `alsoOwned` (the names the registry already records,
// so a session created under an earlier prefix still counts as running).
// Used to self-heal the registry against reality (a session killed
// outside this tool, a machine reboot that dropped the tmux server, ...).
export async function listManagedSessionNames(alsoOwned: ReadonlySet<string> = new Set()): Promise<string[]> {
  const names = new Set<string>();
  // Both servers: older sessions stay on the default one until they end.
  for (const socket of servers()) {
    let out: string;
    try {
      out = await tmux(['list-sessions', '-F', '#{session_name}'], socket);
    } catch (error) {
      if (NO_SERVER_RE.test(tmuxStderr(error))) continue; // that server isn't running
      // Anything else says nothing about which sessions exist; reporting none
      // would end every one of them.
      throw error;
    }
    for (const line of out.split('\n')) {
      const name = line.trim();
      if (name && (isOwnTmuxName(name) || alsoOwned.has(name))) names.add(name);
    }
  }
  return [...names];
}

export type CapturePaneOpts = {
  // ANSI escape codes for color/attributes, for the frontend's read-only
  // terminal view to render. Plain text without this (the default) is what
  // the human-in-the-loop detection uses internally — it only ever reads
  // text, never renders it.
  ansi?: boolean;
  // How many lines of scrollback to reach back into, beyond the currently
  // visible screen. Omitted = just the current screen (tmux's default
  // capture-pane behavior) — matches the pane's actual rendered size,
  // never resizes it.
  history?: number;
};

// Exported separately from the tmux() call itself so the exact argv this
// builds can be unit-tested without spawning a real tmux process.
export function buildCapturePaneArgs(target: string, opts?: CapturePaneOpts): string[] {
  const args = ['capture-pane', '-p', '-t', target];
  if (opts?.ansi) args.push('-e');
  if (opts?.history !== undefined) args.push('-S', `-${opts.history}`);
  return args;
}

export async function capturePane(target: string, opts?: CapturePaneOpts): Promise<string> {
  return tmuxFor(target, buildCapturePaneArgs(target, opts));
}

// tmux's `window-size latest` (its own default) resizes a pane to match
// whatever terminal last attached to it — so the size we asked for at
// `new-session` time is only ever a starting point, not something that
// stays true. Anything rendering pane content (the xterm.js viewer) needs
// to ask for the *current* real size every time, not assume a fixed one.
export async function getPaneSize(target: string): Promise<{ cols: number; rows: number } | null> {
  let out: string;
  try {
    out = await tmuxFor(target, ['display-message', '-p', '-t', target, '#{pane_width}x#{pane_height}']);
  } catch {
    return null; // pane gone
  }
  const match = /^(\d+)x(\d+)/.exec(out.trim());
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

// The foreground process's own command name in this pane, as tmux itself
// tracks it — "claude", "codex", "gemini", or a shell name like "bash"/
// "zsh" if the CLI has exited (crashed, or the user typed `exit`/Ctrl+D
// themselves) and control fell back to the shell underneath it. This is
// how polling.ts's periodic reconcile-style check tells a still-alive CLI
// apart from a pane that's silently reverted to a plain shell — nothing
// in our own bookkeeping (session.provider/status) would otherwise catch
// that on its own, since it's set once at launch and never re-verified
// against reality. A CLI started through a wrapper (npm's `node` for
// Codex) reports the wrapper's name here instead; getPaneLiveness resolves
// that through the process tree.
export async function getPaneCurrentCommand(target: string): Promise<string | null> {
  const pane = await readPane(target).catch(() => null); // null: pane gone
  return pane && await foregroundCommand(pane);
}

// The pane's root pid (null when tmux reports no usable one) and tmux's
// own name for its foreground command, in one display-message. Throws when
// the pane is gone.
async function readPane(target: string): Promise<{ panePid: number | null; reported: string }> {
  // pid first, then a space: tmux prints a tab as `_` when the API runs
  // without a UTF-8 locale (a launchd service has no LANG), and the
  // command's name may itself hold spaces.
  const out = await tmuxFor(target, ['display-message', '-p', '-t', target, '#{pane_pid} #{pane_current_command}']);
  const match = /^(\d*) (.*)$/.exec(out.replace(/\n$/, ''));
  const panePid = Number(match?.[1] || NaN);
  return { panePid: Number.isSafeInteger(panePid) && panePid > 0 ? panePid : null, reported: (match?.[2] ?? '').trim() };
}

async function foregroundCommand(pane: { panePid: number | null; reported: string }): Promise<string | null> {
  if (!pane.reported) return null;
  // tmux's own name for it differs by platform (macOS: the executable
  // file's name); the platform puts it the way Linux's tmux does.
  return await hostPlatform().processes.paneCommand(pane.reported, pane.panePid);
}

export async function getPaneCurrentPath(target: string): Promise<string | null> {
  try {
    const out = await tmuxFor(target, ['display-message', '-p', '-t', target, '#{pane_current_path}']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export type PaneLiveness = 'alive' | 'dead' | 'unknown';
function descendantPids(rows: readonly ProcessEntry[], panePid: number): Set<number> {
  const descendants = new Set([panePid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
    }
  }
  return descendants;
}

/** Return a unique CLI process owned by this pane; an ambiguous tree has no identity evidence. */
export async function getPaneRuntimePid(target: string, expected: { commands: string[]; wrappers: string[] }): Promise<number | null> {
  try {
    const { panePid } = await readPane(target);
    if (panePid === null) return null;
    const processes = await hostPlatform().processes.list();
    const descendants = descendantPids(processes, panePid);
    const matches = processes.filter((row) => descendants.has(row.pid) && expected.commands.includes(row.comm));
    return matches.length === 1 ? matches[0]!.pid : null;
  } catch {
    return null;
  }
}

export function classifyPaneProcessTree(
  expected: { commands: string[]; wrappers: string[] },
  command: string | null,
  panePid: number | null,
  processes: readonly ProcessEntry[] | null,
): PaneLiveness {
  if (!command) return 'unknown';
  if (expected.commands.includes(command)) return 'alive';
  if (SHELL_COMMANDS.includes(command)) return 'dead';
  if (!expected.wrappers.includes(command) || panePid === null || processes === null) return 'unknown';
  const descendants = descendantPids(processes, panePid);
  const providerAlive = processes.some((row) => descendants.has(row.pid) && (
    expected.commands.includes(row.comm) || expected.commands.includes(path.basename(row.args.split(/\s+/, 1)[0] ?? ''))
  ));
  return providerAlive ? 'alive' : 'unknown';
}

export async function getPaneLiveness(target: string, expected: { commands: string[]; wrappers: string[] }): Promise<PaneLiveness> {
  const pane = await readPane(target).catch(() => null);
  const command = pane && await foregroundCommand(pane);
  // Only a wrapper needs the process tree; everything else is decided by
  // the command name alone, without listing every process.
  if (!pane || !command || !expected.wrappers.includes(command)) return classifyPaneProcessTree(expected, command, null, null);
  if (pane.panePid === null) return 'unknown';
  try {
    return classifyPaneProcessTree(expected, command, pane.panePid, await hostPlatform().processes.list());
  } catch { return 'unknown'; }
}

// Types `text` into the pane as literal characters (no tmux key-name
// interpretation, e.g. a literal "Enter" substring in the text is never
// read as the Enter key), then sends a real Enter keypress as a separate,
// non-literal call to submit it. Splitting these two steps matters for TUIs
// whose input box treats an embedded newline as "insert newline" rather
// than "submit".
// The pause in between gives a TUI one input cycle to consume the text
// before it is submitted (see RuntimeDriver.submitDelayMs).
// tmux refuses a command over about 16 KB ("command too long"; tmux 3.4:
// about 5,400 Chinese characters), so longer text goes in as one bracketed
// paste through stdin instead (pasteText). Not typed in pieces: Claude Code
// takes each piece for a paste of its own and joins them with blank lines.
export async function sendText(target: string, text: string, submitDelayMs = DEFAULT_SUBMIT_DELAY_MS): Promise<void> {
  if (Buffer.byteLength(text) > SEND_KEYS_MAX_BYTES) {
    await pasteText(target, text, submitDelayMs);
    return;
  }
  if (text.length > 0) {
    await tmuxFor(target, ['send-keys', '-t', target, '-l', '--', text]);
    await sleep(submitDelayMs);
  }
  await tmuxFor(target, ['send-keys', '-t', target, 'Enter']);
}

const SEND_KEYS_MAX_BYTES = 8 * 1024;

/**
 * Puts `text` into the pane as one bracketed paste, then submits it (Enter
 * after `submitDelayMs`). The text goes to a uniquely named tmux buffer
 * through stdin — never through argv, which caps one argument's length —
 * and `paste-buffer -d` deletes the buffer once pasted.
 */
export async function pasteText(target: string, text: string, submitDelayMs = DEFAULT_SUBMIT_DELAY_MS): Promise<void> {
  const buffer = `hestia-paste-${process.pid}-${pasteCounter++}`;
  // Buffers belong to a server: load it where the pane is.
  const socket = await socketLookup(target);
  await tmuxWithInput(socket ? ['-L', socket, 'load-buffer', '-b', buffer, '-'] : ['load-buffer', '-b', buffer, '-'], text);
  try {
    await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target], socket);
  } catch (err) {
    await tmux(['delete-buffer', '-b', buffer], socket).catch(() => undefined);
    throw err;
  }
  await sleep(submitDelayMs);
  await tmux(['send-keys', '-t', target, 'Enter'], socket);
}

let pasteCounter = 0;

function tmuxWithInput(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', args, { env: childEnv() }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(input);
  });
}

// Types `text` as literal characters without submitting it, e.g. the
// number of a menu option (a bare digit picks it, see CONTROL_KEYS).
export async function typeText(target: string, text: string): Promise<void> {
  await tmuxFor(target, ['send-keys', '-t', target, '-l', '--', text]);
}

// Sends a command line (e.g. launching a provider CLI) the same literal way.
export async function sendCommandLine(target: string, argv: string[]): Promise<void> {
  const line = argv.map(shellQuoteForDisplay).join(' ');
  await sendText(target, line);
}

// tmux send-keys -l takes the exact bytes we give it — the pane's own shell
// is what interprets them, so this only needs to be safe enough for a
// human-readable command line typed into an interactive shell, not a shell
// script. Single-quote each argv element and escape embedded single quotes.
export function shellQuoteForDisplay(arg: string): string {
  if (/^[A-Za-z0-9_\-./=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
