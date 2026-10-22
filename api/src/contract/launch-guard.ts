// What the app has seen of a CLI it just launched, before and right after
// its first message (a handoff's brief, a delegation's or branch line's
// instruction): docs/decisions/0030-launch-guard.md. Kept on the handoff
// (ContinuityHandoff.guard) and on a start (SpawnStartup.guard), so a
// restart of the API picks up where it was.

export type LaunchGuard = {
  // When the screen was first seen showing something that is neither the
  // CLI's input box nor a prompt the app knows; null while it isn't.
  unknownSince: string | null;
  // The user was told about the screen (once, until it clears).
  noticeAt: string | null;
  // The CLI's update menu was answered "Skip" on the user's behalf.
  updateSkippedAt: string | null;
  // Times the CLI was started again, same profile, same tmux (at most
  // MAX_RELAUNCHES automatically).
  relaunches: number;
  // The pane's last lines when something went wrong, for the user.
  tail: string | null;
};

export const MAX_RELAUNCHES = 1;

export function newLaunchGuard(): LaunchGuard {
  return { unknownSince: null, noticeAt: null, updateSkippedAt: null, relaunches: 0, tail: null };
}
