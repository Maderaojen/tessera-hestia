import { RUNTIME_DEAD_STABILITY_MS, RUNTIME_STARTUP_GRACE_MS } from '../config.js';
import type { PaneLiveness } from '../tmux.js';
import { trackerFor } from './tracker.js';

export type StartupVerdict =
  | { verdict: 'confirmed' }
  | { verdict: 'failed' }
  // grace: dead, but too soon after dispatch to tell "not exec'd yet" from
  // "exited"; stabilizing: dead past the grace, not yet for long enough;
  // unknown: nothing positive either way.
  | { verdict: 'waiting'; reason: 'grace' | 'stabilizing' | 'unknown' };

/**
 * The one rule every CLI transition (launch, app /clear relaunch,
 * conversation switch, Claude resume) uses after its launch command was
 * dispatched: alive confirms; unknown waits; dead fails only once the
 * startup grace has passed *and* the pane has stayed dead across polls.
 * `attemptKey` scopes the dead observation to one attempt, so a new attempt
 * never inherits an old one's clock. A session has at most one pending
 * transition, so one observation slot per session suffices.
 */
export function judgeStartup(
  sessionId: string,
  attemptKey: string,
  liveness: PaneLiveness,
  dispatchedAt: string | null,
  now = Date.now(),
): StartupVerdict {
  const tracker = trackerFor(sessionId);
  if (liveness !== 'dead') {
    tracker.startupDead = undefined;
    return liveness === 'alive' ? { verdict: 'confirmed' } : { verdict: 'waiting', reason: 'unknown' };
  }
  // An absent or unparsable dispatch time, or a clock that moved backwards,
  // keeps waiting: failing here could invite a duplicate launch.
  const ageMs = now - Date.parse(dispatchedAt ?? '');
  if (!Number.isFinite(ageMs) || ageMs < RUNTIME_STARTUP_GRACE_MS) {
    tracker.startupDead = undefined;
    return { verdict: 'waiting', reason: 'grace' };
  }
  const observation = tracker.startupDead;
  if (!observation || observation.attemptKey !== attemptKey) {
    tracker.startupDead = { attemptKey, since: now };
    return { verdict: 'waiting', reason: 'stabilizing' };
  }
  if (now - observation.since < RUNTIME_DEAD_STABILITY_MS) return { verdict: 'waiting', reason: 'stabilizing' };
  tracker.startupDead = undefined;
  return { verdict: 'failed' };
}

/** Forget any dead observation, e.g. when the attempt ended some other way. */
export function forgetStartupObservation(sessionId: string): void {
  trackerFor(sessionId).startupDead = undefined;
}
