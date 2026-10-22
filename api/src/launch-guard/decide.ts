import { MAX_RELAUNCHES, type LaunchGuard } from '../contract/launch-guard.js';
import type { TurnPhase } from '../contract/sessions.js';
import type { LaunchScreen } from '../runtimes/launch-screen.js';

// The first message after a launch,
// decided from one look at a time, so a caller stepping a state machine
// (spawn/startup.ts, continuity/handoff.ts) can stop and pick up anywhere:
//   beforeFirstMessage  typed only into the CLI's own input box
//   confirmFirstDelivery  in only once its transcript shows it, whole
//   watchFirstTurn  taken over only once the CLI got through its first turn
//   afterExit  a CLI that quit to finish updating itself is started again
//              once; any other quit is the user's to look at
// Pure: the caller reads the pane and the session, and keeps the guard.

// How long an unknown screen is waited on before the user is told.
export const UNKNOWN_NOTICE_MS = 60_000;
// After choosing Skip in an update menu, how long it may stay on screen.
export const UPDATE_SETTLE_MS = 10_000;
// A message the transcript shows nothing of (missing) is sent again after
// this; one with no conversation bound to read it from (unknown), after
// the longer while (a CLI just started can take a moment to be bound).
export const MISSING_GIVE_UP_MS = 30_000;
export const FIRST_DELIVERY_GIVE_UP_MS = 60_000;
const MAX_RESENDS = 1;
// The CLI is watched through its first turn, at most this long.
export const FIRST_TURN_WATCH_MS = 2 * 60_000;
// A turn that ends within this of the message isn't its turn yet.
const OWN_SEND_SLACK_MS = 3_000;

/** One look at the pane: what it is, and its last lines for the user. */
export type ScreenReading = { screen: LaunchScreen; tail: string };

export type BeforeFirst =
  | { do: 'send' }
  | { do: 'wait' }
  // Choose "Skip" in the CLI's update menu (confirming the cursor first).
  | { do: 'skip_update' }
  // Tell the user, with the screen's tail; nothing is typed.
  | { do: 'notice'; about: 'unknown_screen' | 'update_prompt'; tail: string };

function since(iso: string | null, now: Date): number {
  return iso ? now.getTime() - Date.parse(iso) : 0;
}

/** What to do about the first message now. The guard comes back updated. */
export function beforeFirstMessage(reading: ScreenReading | null, guard: LaunchGuard, now: Date): { decision: BeforeFirst; guard: LaunchGuard } {
  const at = now.toISOString();
  if (!reading) return { decision: { do: 'wait' }, guard };
  const { screen, tail } = reading;
  switch (screen.kind) {
    case 'input_ready':
    case 'unverified':
      return { decision: { do: 'send' }, guard: { ...guard, unknownSince: null, noticeAt: null } };
    // The trust prompt has its own handling; a CLI that updated itself and
    // quit is seen as exited once the app notices (afterExit).
    case 'startup_prompt':
    case 'cli_updated':
      return { decision: { do: 'wait' }, guard: { ...guard, unknownSince: null } };
    case 'update_prompt':
      if (!guard.updateSkippedAt) return { decision: { do: 'skip_update' }, guard: { ...guard, unknownSince: null, updateSkippedAt: at } };
      if (since(guard.updateSkippedAt, now) <= UPDATE_SETTLE_MS || guard.noticeAt) return { decision: { do: 'wait' }, guard };
      return { decision: { do: 'notice', about: 'update_prompt', tail }, guard: { ...guard, noticeAt: at, tail } };
    case 'unknown': {
      const next = { ...guard, unknownSince: guard.unknownSince ?? at };
      if (next.noticeAt || since(next.unknownSince, now) <= UNKNOWN_NOTICE_MS) return { decision: { do: 'wait' }, guard: next };
      return { decision: { do: 'notice', about: 'unknown_screen', tail }, guard: { ...next, noticeAt: at, tail } };
    }
  }
}

/** The user is told now (e.g. Skip couldn't be confirmed): written on the guard. */
export function noticed(guard: LaunchGuard, tail: string | null, now: Date): LaunchGuard {
  return { ...guard, noticeAt: now.toISOString(), tail };
}

/**
 * Whether the first message is in. Only the transcript showing it whole
 * ('exact', which needs the conversation bound) counts; 'unknown' means
 * nothing is bound to read yet, never that it arrived.
 */
export function confirmFirstDelivery(input: {
  delivered: 'exact' | 'partial' | 'missing' | 'unknown'; sentAt: string; now: Date; resent: number;
}): 'delivered' | 'wait' | 'resend' | 'failed' {
  if (input.delivered === 'exact') return 'delivered';
  const waited = since(input.sentAt, input.now);
  if (input.delivered === 'missing' && waited <= MISSING_GIVE_UP_MS) return 'wait';
  if (input.delivered === 'unknown' && waited <= FIRST_DELIVERY_GIVE_UP_MS) return 'wait';
  return input.resent < MAX_RESENDS ? 'resend' : 'failed';
}

/** The CLI after its first message arrived: still on it, through it, or gone. */
export function watchFirstTurn(input: {
  running: boolean; switching: boolean; phase: TurnPhase | null; deliveredAt: string; now: Date;
}): 'watching' | 'over' | 'exited' {
  if (!input.running && !input.switching) return 'exited';
  const waited = since(input.deliveredAt, input.now);
  // Its turn ended, or it is at work asking for a go-ahead: it took over.
  if (input.running && !input.switching && input.phase === 'awaiting_approval') return 'over';
  if (input.running && !input.switching && input.phase === 'idle' && waited > OWN_SEND_SLACK_MS) return 'over';
  return waited > FIRST_TURN_WATCH_MS ? 'over' : 'watching';
}

/**
 * The CLI quit before taking over. Started again (same profile, same tmux)
 * only when its screen says it quit to finish updating itself, and at most
 * MAX_RELAUNCHES times; otherwise it is the user's, with the screen's tail.
 */
export function afterExit(reading: ScreenReading | null, guard: LaunchGuard):
  | { relaunch: true; why: 'cli_updated'; tail: string }
  | { relaunch: false; tail: string | null } {
  if (reading?.screen.kind === 'cli_updated' && guard.relaunches < MAX_RELAUNCHES) return { relaunch: true, why: 'cli_updated', tail: reading.tail };
  return { relaunch: false, tail: reading?.tail ?? null };
}
