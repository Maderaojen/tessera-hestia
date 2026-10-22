import type { SessionWorkspace } from '../contract/index.js';
import type { ActualPermissionModeState, PaneActivity, StartupPrompt } from '../types.js';

// What the poller observes of a session's running CLI (polling.ts and
// sync/*), stored on its record (types.ts ManagedSession) so a restart and
// the clients see it too. Each is written only by its own observer, and
// only when it changes.
export type SessionObservations = {
  // What the CLI's own pane last looked like while replying (see
  // polling.ts's pollOne). Runtime observation only, never exposed as-is:
  // it just feeds the derived `activity`. Written only when it changes, and
  // reset to 'unknown' once the turn stops replying so a stale 'busy'
  // never outlives the turn it was observed in. Absent (older records)
  // means 'unknown'.
  paneActivity?: PaneActivity;
  // Absent on records written before start-up prompts were recognized.
  startupPrompt?: StartupPrompt | null;
  // How many of the CLI's own background subagents are still running
  // (sync/backgroundAgents.ts); written only when it changes. Deliberately
  // not part of the derived `activity`: nothing that waits on the turn
  // waits on these. Absent means none.
  backgroundAgents?: number;
  // The CLI is on a turn it started by itself (woken by a background
  // subagent's or task's result) while the app's turn is over
  // (sync/backgroundAgents.ts). Like backgroundAgents, not part of
  // `activity`. Absent means no.
  backgroundTurn?: boolean;
  // The next message the CLI itself suggests (Claude Code's dim ghost text
  // in its empty input box, sync/cliSuggestion.ts), while the turn is idle;
  // written only when it changes. Display only — nothing that decides
  // delivery or the turn reads it. Absent means none.
  cliSuggestion?: string | null;
  // The permission mode the running CLI is actually in, by its transcript,
  // and whether it differs from the launched one (sync/permissionMode.ts);
  // written only when either changes. Absent means not known.
  actualPermissionMode?: ActualPermissionModeState | null;
  // The checkout the CLI works in (sync/workspace.ts); written only when it
  // changes. Absent on records written before it was looked at.
  workspace?: SessionWorkspace | null;
};
