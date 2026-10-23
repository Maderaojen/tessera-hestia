import { scrubProbeServerSecretEnv } from './account-status/claude.js';
import { startUsageAnalyticsSchedule } from './usage-analytics/wiring.js';
import { startAccountStatusSchedule } from './account-status/index.js';
import { issueLocalToolToken, loadSessionTokens } from './auth.js';
import { loadHostLocale } from './i18n/host-locale.js';
import { describeHostPaths, HOST, HOST_PATHS, isLoopbackHost, LOCAL_TOOL_TOKEN_PATH, PORT, SESSION_TOKENS_PATH, TMUX_SOCKET } from './config.js';
import { backfillHandoffSegments, continuity } from './continuity/wiring.js';
import { backfillDelegationSessionOrigins, delegation } from './delegation/wiring.js';
import { refreshCodexSandbox } from './permission-modes/codex-sandbox.js';
import { fork } from './fork/wiring.js';
import { startNotifications } from './notifications.js';
import { loadModules, startModules } from './module-host/load.js';
import { createModuleHost } from './module-host/ports.js';
import { startPolling } from './polling.js';
import { backfillRevisedTurns } from './sync/turns.js';
import { startRecap } from './recap/wiring.js';
import { createApp } from './server.js';
import * as registry from './registry.js';
import { scrubServerSecretEnv, useSessionSockets } from './tmux.js';
import { forgetSpawnWorktreePaths } from './spawn/roots.js';
import { spawnClosable } from './services/spawn-closable.js';
import { startLoginPathRefresh } from './login-path.js';

// First, before anything else: never listen where another machine could
// reach the API directly (see config.ts HOST).
if (!isLoopbackHost(HOST)) {
  console.error(
    `hestia: refusing to start: HOST=${HOST} is not a loopback address. This API is full access to this machine and only listens on 127.0.0.1 (or ::1, localhost). ` +
      'Reach it from other devices through Tailscale (scripts/install.sh --tailscale) or the Hestia app\'s SSH mode, never by exposing the port. ' +
      'Remove HOST from .env, or re-run scripts/install.sh, which resets it.',
  );
  process.exit(1);
}

// Which state dir, tmux prefix and archive this run picked (and whether
// .env chose them), once, so a surprise is visible in the journal.
for (const line of describeHostPaths(HOST_PATHS)) console.log(`hestia ${line}`);
console.log(`hestia tmux server: -L ${TMUX_SOCKET}`);

// A tmux server started before children got a scrubbed env still hands the
// API's secrets to every new pane; clear them before anything can create
// one. Panes already running keep their copy until they are restarted.
// Every tmux command goes to the server its session is on.
useSessionSockets(registry.tmuxSocketFor);
await Promise.all([scrubServerSecretEnv(), scrubProbeServerSecretEnv()]);
await issueLocalToolToken(LOCAL_TOOL_TOKEN_PATH);
// The probes' PATH also gets the login shell's (login-path.ts), read in the background.
startLoginPathRefresh();
// Before listening: a request must never be answered from an empty token
// map (a logged-in phone would be told to log in again), and the file must
// be read before anything writes it.
await loadSessionTokens(SESSION_TOKENS_PATH);
// Before anything writes text for the person (i18n/host-locale.ts).
await loadHostLocale();
// Delegation and branch line worktrees that sessions opened in them added
// to their project's paths before they were kept apart (spawn/roots.ts).
await forgetSpawnWorktreePaths().then(
  (removed) => { if (removed) console.log(`[spawn] took ${removed} worktree path(s) out of projects`); },
  (err: unknown) => console.error('[spawn] could not take worktree paths out of projects', err),
);
// The optional modules (api/modules/*), if this build has any.
const modules = await loadModules(createModuleHost());
const app = createApp({ modules });
// Before polling, so no import races it: stored turns re-read with the
// current parser (sync/turns.ts).
await backfillRevisedTurns().then(
  (revised) => { if (revised) console.log(`[turns] re-read ${revised} stored turn(s) from their transcripts`); },
  (err: unknown) => console.error('[turns] could not re-read stored turns', err),
);
startPolling();
startNotifications();
void startAccountStatusSchedule();
startUsageAnalyticsSchedule();
void continuity.start().catch((err: unknown) => console.error('[continuity] start failed', err));
delegation.start();
void backfillDelegationSessionOrigins().then(
  (filled) => { if (filled) console.log(`[delegation] recorded the delegation on ${filled} delegate session(s)`); },
  (err: unknown) => console.error('[delegation] could not record delegations on their sessions', err),
);
void backfillHandoffSegments().then(
  (filled) => { if (filled) console.log(`[continuity] recorded the handoff on ${filled} older conversation(s)`); },
  (err: unknown) => console.error('[continuity] could not record handoffs on older conversations', err),
);
fork.start();
// Finished branch lines and delegations, for the session list to offer closing (spawn/closable.ts).
spawnClosable.start();
// Whether Codex's sandbox works here, for its auto permission mode (ADR 0027).
void refreshCodexSandbox().then((available) => {
  if (!available) console.warn('[permission-modes] Codex sandbox unavailable on this host; Codex auto mode is not offered');
});
startRecap();
startModules(modules);

app.listen(PORT, HOST, () => {
  console.log(`hestia listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
});
