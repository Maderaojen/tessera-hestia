import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

// ---------- host paths and names ----------
//
// Everything this API reads or writes outside its own source tree, and the
// name its tmux sessions share, is decided here once, from the environment.
// resolveHostPaths is pure (env and home in, answers out) so the choice
// can be tested against temp dirs; the constants below are its answer for
// this process.

export const DEFAULT_SESSION_PREFIX = 'hestia-';

// tmux turns '.' and ':' in a session name into target syntax, so a prefix
// is kept to characters that always name a session literally.
const SESSION_PREFIX_RE = /^[A-Za-z0-9_-]+$/;

type Env = Readonly<Record<string, string | undefined>>;
export type PathSource = 'env' | 'default';

export type HostPaths = {
  stateDir: string;
  stateDirSource: PathSource;
  sessionPrefix: string;
  sessionPrefixSource: PathSource;
  dialogueRoot: string;
  dialogueRootSource: PathSource;
  // The per-user bin dir (janus, claude) a systemd user service's bare
  // PATH doesn't include.
  userBinDir: string;
  // Each provider CLI's own default home, honoring the variable the CLI
  // itself reads (see nativeProviderHomes).
  providerHomes: NativeProviderHomes;
  // Where a delegation's or a branch line's new worktree goes: every one
  // into HESTIA_WORKTREES_DIR when that is set (null otherwise); else a
  // folder beside its repo, or, when the repo's parent can't be written,
  // the fallback under the XDG data dir — never under the state dir, which
  // the git panel doesn't read (spawn/workspace.ts).
  worktreesDir: string | null;
  worktreesFallbackDir: string;
};

export type NativeProviderHomes = { claude: string; codex: string; gemini: string };

// A blank line in .env (`KEY=`) means "not set", not "the empty path".
function envValue(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Each provider CLI's own default (native) home.
 * - Codex reads CODEX_HOME, so an inherited one is where native Codex lives;
 *   its driver passes the same value back on launch (nativeLaunchEnv).
 * - Gemini CLI puts `.gemini` under GEMINI_CLI_HOME when that is set.
 * - Claude Code's CLAUDE_CONFIG_DIR is deliberately not followed: native
 *   Claude is `~/.claude`, and launches and probes of it unset an inherited
 *   CLAUDE_CONFIG_DIR (claude-code.ts nativeUnsetEnv, docs/reference/account-status.md)
 *   so a parent process's choice can't silently point it at another account.
 */
export function nativeProviderHomes(env: Env, home: string): NativeProviderHomes {
  return {
    claude: path.join(home, '.claude'),
    codex: envValue(env, 'CODEX_HOME') ?? path.join(home, '.codex'),
    gemini: path.join(envValue(env, 'GEMINI_CLI_HOME') ?? home, '.gemini'),
  };
}

export function resolveHostPaths(env: Env, home: string): HostPaths {
  let stateDir: string;
  let stateDirSource: PathSource;
  const stateOverride = envValue(env, 'HESTIA_STATE_DIR');
  if (stateOverride) {
    stateDir = stateOverride;
    stateDirSource = 'env';
  } else {
    stateDir = path.join(maderaHome(env, home), 'hestia');
    stateDirSource = 'default';
  }

  let sessionPrefix: string;
  let sessionPrefixSource: PathSource;
  const prefixOverride = envValue(env, 'HESTIA_SESSION_PREFIX');
  if (prefixOverride) {
    if (!SESSION_PREFIX_RE.test(prefixOverride)) {
      throw new Error(`HESTIA_SESSION_PREFIX may only contain letters, digits, '-' and '_' (got ${JSON.stringify(prefixOverride)})`);
    }
    sessionPrefix = prefixOverride;
    sessionPrefixSource = 'env';
  } else {
    sessionPrefix = DEFAULT_SESSION_PREFIX;
    sessionPrefixSource = 'default';
  }

  // The archive only goes into another tool's folder (mnemosyne's, say)
  // when asked to.
  let dialogueRoot: string;
  let dialogueRootSource: PathSource;
  const dialogueOverride = envValue(env, 'HESTIA_DIALOGUE_ROOT');
  if (dialogueOverride) {
    dialogueRoot = dialogueOverride;
    dialogueRootSource = 'env';
  } else {
    dialogueRoot = path.join(stateDir, 'dialogue');
    dialogueRootSource = 'default';
  }

  return {
    stateDir, stateDirSource,
    sessionPrefix, sessionPrefixSource,
    dialogueRoot, dialogueRootSource,
    userBinDir: envValue(env, 'HESTIA_USER_BIN_DIR') ?? path.join(home, '.local', 'bin'),
    providerHomes: nativeProviderHomes(env, home),
    worktreesDir: absolute(envValue(env, 'HESTIA_WORKTREES_DIR')),
    worktreesFallbackDir: path.join(xdgDataHome(env, home), 'madera', 'hestia', 'worktrees'),
  };
}

function absolute(dir: string | undefined): string | null {
  return dir && path.isAbsolute(dir) ? dir : null;
}

// XDG says a relative XDG_DATA_HOME is invalid and must be ignored.
/**
 * The Tessera family's shared data root, resolved as Janus and Mnemosyne
 * do: MADERA_HOME, else $XDG_CONFIG_HOME/madera, else ~/.config/madera.
 * Relative values are ignored (XDG says so for XDG_CONFIG_HOME; a relative
 * MADERA_HOME would move with the service's working directory).
 */
export function maderaHome(env: Env, home: string): string {
  const madera = envValue(env, 'MADERA_HOME');
  if (madera && path.isAbsolute(madera)) return madera;
  const xdg = envValue(env, 'XDG_CONFIG_HOME');
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'madera');
}

function xdgDataHome(env: Env, home: string): string {
  const xdg = envValue(env, 'XDG_DATA_HOME');
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
}

/** One line per choice, for the API to log once at startup. */
export function describeHostPaths(paths: HostPaths): string[] {
  const why = (source: PathSource) => (source === 'env' ? 'from env' : 'default');
  return [
    `state dir: ${paths.stateDir} (${why(paths.stateDirSource)})`,
    `tmux session prefix: ${paths.sessionPrefix} (${why(paths.sessionPrefixSource)})`,
    `dialogue archive: ${paths.dialogueRoot} (${why(paths.dialogueRootSource)})`,
  ];
}

export const HOST_PATHS = resolveHostPaths(process.env, HOME);

// Every tmux session this tool creates is named `${SESSION_PREFIX}${uuid}`.
// The prefix lets us self-heal the registry from `tmux list-sessions` alone
// if our own state file is ever lost or goes stale, and keeps two installs
// on one machine (each with its own prefix) out of each other's sessions.
export const SESSION_PREFIX = HOST_PATHS.sessionPrefix;
// The tmux server (`tmux -L <name>`) this install opens its sessions on:
// its own, not the user's default one, so a `tmux kill-server` typed in
// any ordinary terminal (or by a CLI working in one) can't end them, and
// two installs on one machine (dev and stable) never share a server. By
// default the session prefix without its trailing dash (`hestia`,
// `hestia-stable`). Sessions opened before this keep the server they were
// opened on (ManagedSession.tmuxSocket).
export const TMUX_SOCKET = process.env.HESTIA_TMUX_SOCKET?.trim() || SESSION_PREFIX.replace(/-+$/, '') || 'hestia';
export const USER_BIN_DIR = HOST_PATHS.userBinDir;
// The hestia command's name for this install (install.sh --command-name,
// written to .env): what the prompts tell an LLM in one of its panes to run
// (`{command} delegate done`, i18n/prompts), so a second install on the
// machine (dev beside a release) is reached through its own command, not
// whichever one owns `hestia`. Anything that isn't a plain name is ignored.
export const DEFAULT_COMMAND_NAME = 'hestia';
export function commandName(env: NodeJS.ProcessEnv): string {
  const name = env.HESTIA_COMMAND_NAME?.trim();
  return name && /^[a-z0-9-]+$/.test(name) ? name : DEFAULT_COMMAND_NAME;
}
export const COMMAND_NAME = commandName(process.env);
export const WORKTREES_DIR = HOST_PATHS.worktreesDir;
export const WORKTREES_FALLBACK_DIR = HOST_PATHS.worktreesFallbackDir;

// Login lockout tuning (see auth.ts's isLoginLocked/recordLoginFailure) —
// overridable via .env so this can be tightened/loosened without a code
// change/redeploy, same reasoning as STATE_DIR/PORT below.
export const MAX_LOGIN_ATTEMPTS = Number(process.env.AUTH_MAX_LOGIN_ATTEMPTS ?? 5);
export const LOGIN_LOCKOUT_MS = Number(process.env.AUTH_LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000);
// Failures from all sources together within LOGIN_LOCKOUT_MS before every
// login is refused (auth.ts's recentFailures): the per-source lockout alone
// does nothing against someone guessing from many addresses.
export const GLOBAL_MAX_LOGIN_FAILURES = Number(process.env.AUTH_GLOBAL_MAX_LOGIN_FAILURES ?? 10);
// How long a stream ticket (auth.ts's issueStreamTicket) stays usable: long
// enough for the client to open the EventSource right after asking for it
// on a slow phone connection, short enough that a leaked one is worthless.
export const STREAM_TICKET_TTL_MS = 60_000;
// How long an image token (auth.ts's issueMediaToken) stays usable. The
// frontend asks for a new one well before this runs out; any longer and a
// leaked image URL stays good for longer than it needs to.
export const MEDIA_TOKEN_TTL_MS = 30 * 60_000;
// A pairing code (auth.ts's issuePairingCode): what `hestia pair`
// puts in the QR code a phone scans to log in without the password. Long
// enough to pick up the phone and scan (the app's own scanner is a tap
// away), short enough that a photo of the screen found later is worthless.
export const PAIRING_CODE_TTL_MS = 3 * 60_000;

// A login token (auth.ts's issueSessionToken) is kept on disk so a restart
// doesn't log every phone out. Idle expiry removes forgotten devices; an
// absolute limit also bounds how long a stolen, actively used token works.
export const SESSION_TOKEN_MAX_TTL_MS = 90 * 24 * 60 * 60_000;
export const SESSION_TOKEN_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
// How stale a token's recorded last use may get before a request records
// it again. Tokens are checked on every request; writing the file each time
// would be pointless churn. This only makes the idle expiry up to this much
// early, which nobody notices against 30 days.
export const SESSION_TOKEN_TOUCH_INTERVAL_MS = 60 * 60_000;

// ---------- frontends ----------
//
// The only place the official frontends are named. A backend serves
// whichever frontends its owner lists in CORS_ALLOWED_ORIGINS; when that is
// blank it serves the Hestia app WebViews alone (server.ts's allowedOrigins).
// The web frontend isn't offered: a backend that wants it lists it, and `hestia
// pair --link web` sends a phone to the first web frontend in that list,
// or to this one (cli/pairLink.ts's frontendOrigin).
//
// The web frontend: not in the defaults; only for a backend that lists it.
export const DEFAULT_FRONTEND_ORIGIN = 'https://hestia.maderaojen.me';
// The origins Hestia app WebViews use in production:
// Capacitor iOS/Android, then Tauri macOS/Windows. These use bearer tokens,
// never cookie credentials, even when also present in a custom allowlist.
export const APP_WEBVIEW_ORIGINS: readonly string[] = [
  'capacitor://localhost',
  'https://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
];
// CORS_ALLOWED_ORIGINS left blank means exactly these app origins.
export const DEFAULT_CORS_ALLOWED_ORIGINS: readonly string[] = [...APP_WEBVIEW_ORIGINS];

// HESTIA_STATE_DIR overrides it (tests use that to never touch the
// real user state directory); see resolveHostPaths for the default.
export const STATE_DIR = HOST_PATHS.stateDir;
export const REGISTRY_PATH = path.join(STATE_DIR, 'registry.json');
// What happened to each session's tmux, one JSON line per event
// (session-events.ts): who closed, deleted or relaunched it, and when a
// tmux was found gone.
export const SESSION_EVENTS_PATH = path.join(STATE_DIR, 'session-events.jsonl');
// This run's token for tools on this machine (the hestia command);
// see auth.ts's issueLocalToolToken.
export const LOCAL_TOOL_TOKEN_PATH = path.join(STATE_DIR, 'cli-token');
// Login tokens that survive a restart (auth.ts's loadSessionTokens): only
// each token's SHA-256, never the token itself.
export const SESSION_TOKENS_PATH = path.join(STATE_DIR, 'session-tokens.json');
// Web Push: this server's VAPID keys (made on first use, never leave the
// host) and the browsers that asked to be notified.
// The interface language the person's app last used (i18n/host-locale.ts).
export const INTERFACE_LOCALE_PATH = path.join(STATE_DIR, 'interface-locale.json');
export const VAPID_KEYS_PATH = path.join(STATE_DIR, 'vapid.json');
export const PUSH_SUBSCRIPTIONS_PATH = path.join(STATE_DIR, 'push-subscriptions.json');
export const LAUNCH_PROFILES_PATH = path.join(STATE_DIR, 'launch-profiles.json');
// Projects (see project-store.ts) — one flat file, same "STATE_DIR 底下的一個檔案" convention as REGISTRY_PATH.
export const PROJECTS_PATH = path.join(STATE_DIR, 'projects.json');
// Per-session notes (便箋) scratchpad — see notes-store.ts/tag-index.ts.
export const NOTES_DIR = path.join(STATE_DIR, 'notes');
export const TAG_INDEX_PATH = path.join(NOTES_DIR, 'tag-index.json');
// Where uploaded images (see routes/uploads.ts) get saved on this host —
// this machine is also the one running tmux/the provider CLIs, so a saved
// file's own path is directly usable as a text reference sent into the
// pane (Claude Code's own image support reads a file path mentioned in a
// prompt with its Read tool — see conversation notes on why this is the
// only viable way to get real image bytes to the model through a
// keystroke-simulation pipeline that can't transmit binary data any other
// way).
export const UPLOADS_DIR = path.join(STATE_DIR, 'uploads');
// A note's image: a phone photo, not a raw camera dump. The composer's
// uploads take up to the contract's UPLOAD_MAX_BYTES.
export const NOTE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// Account status (account-status/): the one snapshot every sweep writes, and
// the scratch cwd the Claude /usage probe runs in.
export const ACCOUNT_STATUS_PATH = path.join(STATE_DIR, 'account-status.json');
export const USAGE_PROBE_DIR = path.join(STATE_DIR, 'usage-probe');
// Carrying on after a usage limit (continuity/): policies and the schedule.
export const CONTINUITY_PATH = path.join(STATE_DIR, 'continuity.json');
// Delegating work to another LLM (delegation/): every delegation and its settings.
export const DELEGATION_PATH = path.join(STATE_DIR, 'delegation.json');
// Branch lines (fork/): every one, where it came from and where it works.
export const FORK_PATH = path.join(STATE_DIR, 'fork.json');
// Launch permission modes: each runtime's default, and each tmux's own (permission-modes/).
export const PERMISSION_MODES_PATH = path.join(STATE_DIR, 'permission-modes.json');
// Conversation recaps (recap/): the settings and pause, and the empty
// folder every recap CLI runs in (no project's).
export const RECAP_SETTINGS_PATH = path.join(STATE_DIR, 'conversation-recap.json');
export const RECAP_RUNNER_DIR = path.join(STATE_DIR, 'recap-runner');

// Every archived turn (dialogue-store.ts). Under STATE_DIR by default;
// HESTIA_DIALOGUE_ROOT points it elsewhere, e.g. at mnemosyne's
// `dialogue/` (a sibling of mnemo-cli's own `exports/`, distinct so the two
// tools never collide).
export const DIALOGUE_ROOT = HOST_PATHS.dialogueRoot;

// `fs.stat` is a cheap syscall (unlike capture-pane, which spawns a
// subprocess) — there's no real cost reason to poll it slowly. This was
// 5000ms originally, an arbitrary "reasonable interval" guess, not a real
// constraint; tightened once that stopped making sense.
export const POLL_INTERVAL_MS = 800;
// After a CLI launch command is dispatched (any transition — launch, app
// /clear relaunch, conversation switch, Claude resume, or one submitted just
// before an API restart), the pane can still report its shell for a while.
// Keep the durable attempt pending long enough for the CLI to exec, then
// require two clean poll intervals of confirmed dead liveness before
// deciding startup failed (sync/startup.ts judgeStartup).
export const RUNTIME_STARTUP_GRACE_MS = 30_000;
export const RUNTIME_DEAD_STABILITY_MS = POLL_INTERVAL_MS * 2;
// A switch or app /clear asks the running CLI to exit first; if it's still
// running after this long, a switch asks the user whether to force-reset
// the pane (never done without asking) and a /clear tells the user to check
// the terminal. Neither ever re-sends the exit.
export const RUNTIME_EXIT_TIMEOUT_MS = 10_000;
// Claude Code and Gemini write their transcript only once the first prompt
// arrives, so a missing file means nothing until a message has been sent and
// the CLI has had this long to write it. Before that the lookup stays
// pending and nothing is shown.
export const TRANSCRIPT_NOT_FOUND_GRACE_MS = 15_000;
// A freshly started CLI (e.g. Codex opening its thread lock) exposes its
// identity evidence shortly after the pane process appears, so a missing
// observation right after launch is normal. Only one that stays unobservable
// this long is worth a warning.
export const RUNTIME_IDENTITY_WARN_AFTER_MS = 5_000;
// A resumed conversation of a runtime whose identity is observed (Codex)
// only counts once the CLI is seen holding exactly that conversation
// (sync/resumeIdentity.ts). Codex 0.160.0 took about a second, even for a
// 40MB rollout; past this long from dispatch, with no start-up prompt on
// screen, the resume is given up and the CLI asked to exit.
export const RESUME_IDENTITY_TIMEOUT_MS = 30_000;
// A finalized turn's session file must be unchanged across this many
// consecutive polls before we treat the reply as complete and hand it to
// the frontend — at the interval above, ~1.6s of quiescence. Cheap
// stand-in for a real "turn finished" signal; still long enough to not be
// fooled by a brief pause between two tool calls in the same turn.
export const STABLE_POLLS_BEFORE_FINAL = 2;
// After the stop button's Esc, how long to keep re-reading the transcript
// for the interrupted turn (the CLI writes its interrupted marker a moment
// after the key lands) before importing whatever complete turn is there.
export const STOP_IMPORT_TIMEOUT_MS = 3_000;
export const STOP_IMPORT_POLL_MS = 200;

// If a replying session's transcript has gone quiet for this long (wall
// clock, not poll count — so it stays meaningful regardless of how
// POLL_INTERVAL_MS is tuned) with no new complete turn and no
// structurally-confirmed pending interaction, we can't be *sure* it's stuck
// (e.g. a local CLI UI screen like `/status` that writes nothing to the
// transcript while open — see docs/reference/human-in-the-loop.md) — but it's worth
// hinting the user to go check the terminal. Never changes `status`.
export const STUCK_HINT_MS = 30_000;

// Safety net for a replying session the transcript alone would keep open
// forever: isTurnComplete says "still mid-turn" (e.g. a tool interrupted
// before its tool_result was written) yet the CLI's pane has been sitting
// at its input box, not busy, for this long without interruption. Long
// enough that a brief idle-looking frame between two tool calls never
// counts; see polling.ts's pollOne.
export const PANE_IDLE_FINALIZE_MS = 5_000;
// ...and the transcript too must have been quiet this long: the pane is only
// read for its main screen, and a CLI showing something else (a subagent's
// view, a task panel) while it keeps working can look idle. A turn ended
// this way that the transcript then shows still going is taken up again
// (polling.ts pollIdle). Under STUCK_HINT_MS, so the hint never comes first.
export const PANE_IDLE_FINALIZE_QUIET_MS = 15_000;

// How long to wait for a just-sent (non-slash) message to show up as a
// real user-role entry in the transcript before flagging it as possibly
// undelivered. Deliberately short compared to STUCK_HINT_MS: this only
// confirms the CLI *received and recorded* the input at all, which should
// happen within seconds regardless of how long the actual reply takes —
// it is not a reply-latency timeout, and never gates sending (see
// routes/messages.ts — sending is no longer blocked on session status at
// all, since imperfect detection making that block permanent turned out
// to be worse than not blocking).
export const DELIVERY_ECHO_TIMEOUT_MS = 25_000;

// A CLI stamps its transcript with its own clock, and a send is recorded
// only once its text has been typed in, so a message's transcript time can
// come a little before the send's own; allow that much.
export const TRANSCRIPT_CLOCK_SKEW_MS = 2_000;

// A turn the CLI starts within this of a send made from idle is taken as
// that send being received (sync/delivery.ts reconcileSends). Codex 0.161.0
// starts it a fraction of a second after the text is submitted.
export const DELIVERY_RECEIPT_WINDOW_MS = 10_000;

// Real dimensions every tmux pane we create gets (`new-session -x -y`), not
// tmux's own default (commonly 80×24). 80 columns is too narrow for
// Claude Code's TUI layout. capture-pane text comes back already wrapped
// at the pane's real width, which the pane stream reports alongside it
// (pane-stream.ts), so the frontend needs no copy of these numbers.
export const PANE_COLS = 133;
export const PANE_ROWS = 40;

// Read-only "watch the terminal" feature (docs discussion, not part of the
// correctness-critical reply-detection path). How often the shared SSE
// stream re-captures a pane while at least one client is watching it.
export const PANE_STREAM_INTERVAL_MS = 700;

// Claude Code's prompt suggestion (sync/cliSuggestion.ts) shows up a few
// seconds after a reply ends. The bottom of the pane is read with
// attributes every CLI_SUGGESTION_SAMPLE_MS for CLI_SUGGESTION_WATCH_MS
// after the turn goes idle, then only every CLI_SUGGESTION_RECHECK_MS while
// one is shown (to notice it gone: typed over, or the CLI moved on). A
// terminal view's own capture no older than CLI_SUGGESTION_REUSE_MS is
// used instead of capturing again.
export const CLI_SUGGESTION_SAMPLE_MS = 2_000;
export const CLI_SUGGESTION_WATCH_MS = 60_000;
export const CLI_SUGGESTION_RECHECK_MS = 10_000;
export const CLI_SUGGESTION_REUSE_MS = 1_500;
// How long an idle SSE connection (pane or session events) goes without a
// real update before we send a comment-only heartbeat, so intermediary
// proxies don't time it out.
export const SSE_HEARTBEAT_MS = 15_000;

// Not 4317 — that's the standard OTLP gRPC port and gets intercepted by
// observability sidecars in some sandboxed dev environments.
export const PORT = Number(process.env.PORT ?? 4791);

// Loopback only: this API is shell-equivalent access to the machine, so it
// is never reachable from the network directly. The only supported ways in
// from another device, `tailscale serve` on this machine and the native
// app's SSH mode (a port forward through the user's own sshd), both connect
// over loopback. main.ts refuses to start on any other HOST
// (isLoopbackHost), rather than leave the login as the only protection.
export const HOST = process.env.HOST || '127.0.0.1';

/** Whether HOST is one the API agrees to listen on: this machine only. */
export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

/**
 * The address a client on this machine (the hestia command) connects
 * to: HOST itself, except that a wildcard bind is reached over loopback.
 */
export function connectHostFor(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host;
}

/** http://host:port with an IPv6 literal bracketed, for fetch(). */
export function localApiOrigin(host: string, port: number): string {
  const connect = connectHostFor(host).replace(/^\[(.*)\]$/, '$1');
  return `http://${connect.includes(':') ? `[${connect}]` : connect}:${port}`;
}

// Each provider CLI's native home (see nativeProviderHomes) and where under
// it that CLI keeps its conversations. The runtime drivers hand these out
// (nativeLocations); the transcript adapters fall back to them.
export const NATIVE_PROVIDER_HOMES = HOST_PATHS.providerHomes;
export const PROVIDER_ROOTS = {
  claude: path.join(NATIVE_PROVIDER_HOMES.claude, 'projects'),
  codex: path.join(NATIVE_PROVIDER_HOMES.codex, 'sessions'),
  gemini: path.join(NATIVE_PROVIDER_HOMES.gemini, 'tmp'),
} as const;
