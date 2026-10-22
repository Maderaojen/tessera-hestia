import { stat } from 'node:fs/promises';

export type Fingerprint = { mtimeMs: number; size: number; walMtimeMs?: number; walSize?: number };

// Everything the poller remembers about one session between ticks. In memory
// only: an API restart starts every clock over, which is always the safe
// direction (a quiet period or an idle run has to be observed again).
export type SessionTracker = {
  // The transcript while replying / awaiting_approval. A fresh message
  // always needs STABLE_POLLS_BEFORE_FINAL clean polls of its own before its
  // turn is treated as final. changedAt: when the fingerprint last changed
  // (or was first seen) — the stuck hint measures quiet time from here, not
  // from the send.
  waiting?: { fingerprint: Fingerprint; stableCount: number; changedAt: number };
  // The transcript while 'ready' (see polling.ts pollIdle). `checked` marks
  // that the current fingerprint has already been looked at once it went
  // quiet, so an idle transcript is parsed once per change, not every tick.
  ready?: { fingerprint: Fingerprint; stableCount: number; checked: boolean };
  // When the pane was first seen idle in the current unbroken run of idle
  // observations while replying. Any non-idle observation (or leaving
  // replying) drops it, so PANE_IDLE_FINALIZE_MS always measures continuous
  // idleness.
  paneIdleSince?: number;
  // When a control key (arrows/Esc/Enter via /respond) was last sent.
  // Someone steering the CLI by hand isn't stuck, so the stuck hint's quiet
  // time also restarts from here.
  lastControlKeyAt?: number;
  // First "dead" observation of a pending CLI launch (any transition), so a
  // rollback needs the pane to stay dead for a while, not one bad sample.
  // Owned by sync/startup.ts judgeStartup.
  startupDead?: { attemptKey: string; since: number };
  // Transcript fingerprint at the last delivery check (polling.ts
  // settleOutgoingSends), so flagged sends are re-checked only on change.
  deliveryFingerprint?: Fingerprint;
  // When the app last ended a turn (replying / awaiting_approval → idle):
  // a turn the transcript still shows open afterwards is taken up again only
  // once the transcript is written after this (polling.ts pollIdle).
  turnEndedAt?: number;
  // When the delivery check last saw a reply in progress: a send made
  // mid-reply isn't overdue until DELIVERY_ECHO_TIMEOUT_MS after that.
  lastReplyingAt?: number;
};

const trackers = new Map<string, SessionTracker>();

export function trackerFor(sessionId: string): SessionTracker {
  let tracker = trackers.get(sessionId);
  if (!tracker) {
    tracker = {};
    trackers.set(sessionId, tracker);
  }
  return tracker;
}

// The turn being watched is over (imported, rebound to another transcript,
// blocked on a prompt): the next one starts its stability and idle clocks
// from scratch.
export function resetTurnWatch(sessionId: string): void {
  const tracker = trackerFor(sessionId);
  tracker.waiting = undefined;
  tracker.paneIdleSince = undefined;
}

export function sameFingerprint(a: Fingerprint | undefined, b: Fingerprint): boolean {
  return a !== undefined && a.mtimeMs === b.mtimeMs && a.size === b.size
    && a.walMtimeMs === b.walMtimeMs && a.walSize === b.walSize;
}

// null when the file can't be read right now (mid-rotation, briefly
// missing) — callers just try again next tick.
export async function readFingerprint(file: string): Promise<Fingerprint | null> {
  try {
    const st = await stat(file);
    if (!file.endsWith('.db')) return { mtimeMs: st.mtimeMs, size: st.size };
    // SQLite may append new steps to WAL while the main .db file is unchanged.
    const wal = await stat(`${file}-wal`).catch(() => null);
    return { mtimeMs: st.mtimeMs, size: st.size, walMtimeMs: wal?.mtimeMs ?? 0, walSize: wal?.size ?? 0 };
  } catch {
    return null;
  }
}
