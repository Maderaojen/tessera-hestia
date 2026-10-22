import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { SESSION_EVENTS_PATH } from './config.js';

// What was done to each session's tmux, and by whom: one JSON line per
// event, appended to SESSION_EVENTS_PATH. Written so a tmux that ended can
// be traced afterwards — closed from the app, deleted, relaunched, or found
// gone with nobody here having ended it.

// Who asked: the app (a signed-in user), the hestia command on this machine,
// the delegation, fork or continuity modules on their own, or the reconcile that
// found a tmux gone.
export type SessionEventSource = 'app' | 'cli' | 'delegation' | 'fork' | 'continuity' | 'reconcile';

export type SessionEvent = {
  at: string;
  sessionId: string;
  // close, close_force, delete, restore, purge, create, launch, launch_cancel, clear,
  // clear_force, clear_cancel, handoff, recover, switch, switch_force,
  // switch_cancel, kill_leftover (a delegation clearing a tmux it never
  // recorded), tmux_gone, cli_exited, and an app send's delivery:
  // send_flagged (shown as possibly undelivered), send_received (the CLI
  // started its turn before the text showed up), send_confirmed (seen at
  // last, after either).
  action: string;
  // 'ok', or what came of it (a close's status, a refusal's error code).
  result: string;
  source: SessionEventSource;
  // The signed-in username, when a person asked.
  actor?: string;
  detail?: Record<string, unknown>;
};

// Past this the file is moved to `.1` (replacing an older one) and a new
// one started: a few thousand events either way.
export const SESSION_EVENTS_MAX_BYTES = 2 * 1024 * 1024;

let queue: Promise<void> = Promise.resolve();

/** Appends one event. Never throws: a failed write is logged, the operation it records stands. */
export function recordSessionEvent(event: Omit<SessionEvent, 'at'>): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  queue = queue.then(() => append(line)).catch((err: unknown) => {
    console.error('[session-events] could not record an event', err);
  });
  return queue;
}

async function append(line: string): Promise<void> {
  await mkdir(path.dirname(SESSION_EVENTS_PATH), { recursive: true });
  const size = await stat(SESSION_EVENTS_PATH).then((info) => info.size, () => 0);
  if (size >= SESSION_EVENTS_MAX_BYTES) await rename(SESSION_EVENTS_PATH, `${SESSION_EVENTS_PATH}.1`);
  await appendFile(SESSION_EVENTS_PATH, line, { mode: 0o600 });
}
