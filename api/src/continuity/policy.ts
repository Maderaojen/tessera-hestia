import type { ContinuityDefaults, ContinuityOverride, ContinuityPending, LimitHit } from '../contract/continuity.js';
import { prompt } from '../i18n/index.js';

// What to do about a usage limit, as pure functions of what was observed. engine.ts gathers the observations and
// carries the decisions out.

export const DEFAULT_CONTINUITY: ContinuityDefaults = {
  mode: 'off',
  // Typed into the CLI, so in i18n/prompts (the user may change it).
  resumePrompt: prompt('continuity.resume.prompt'),
  resumeDelaySeconds: 120,
  maxAutoResumesPerDay: 6,
  chain: [],
  softRemainingPercent: 15,
  hardRemainingPercent: 8,
  handoffSource: 'self_then_mechanical',
  handoffConfirm: 'ask',
  selfBriefTimeoutSeconds: 300,
};

// A soft handoff only follows work that is going on: a turn that ended this
// recently. A session left idle while its account ran low elsewhere is not
// handed over.
export const RECENT_TURN_MS = 10 * 60_000;
// Within this many points above the soft threshold, a session at work asks
// for fresher quota numbers than the 15-minute sweep gives.
export const REFRESH_MARGIN_PERCENT = 10;

export type ProfileCandidate = {
  id: string;
  accountId: string | null;
  // The lower of its 5-hour and 7-day remaining percent; null when unknown.
  remainingPercent: number | null;
  // Set while its account is known to be over its limit.
  limitedUntil: string | null;
};

/**
 * The profile to hand off to: the first in the chain after the current one
 * (wrapping around) that is not the current account, isn't over its
 * limit, and has more than the soft threshold left. Unknown quota counts
 * as available — the chain is the user's own choice.
 */
export function selectTarget(input: {
  chain: readonly string[];
  currentProfileId: string | null;
  currentAccountId: string | null;
  candidates: readonly ProfileCandidate[];
  softRemainingPercent: number;
  now: Date;
}): string | null {
  const start = input.currentProfileId ? input.chain.indexOf(input.currentProfileId) + 1 : 0;
  const ordered = [...input.chain.slice(start), ...input.chain.slice(0, start)];
  for (const id of ordered) {
    if (id === input.currentProfileId) continue;
    const candidate = input.candidates.find((c) => c.id === id);
    if (!candidate) continue; // no longer offered
    if (candidate.accountId && candidate.accountId === input.currentAccountId) continue;
    if (candidate.limitedUntil && Date.parse(candidate.limitedUntil) > input.now.getTime()) continue;
    if (candidate.remainingPercent !== null && candidate.remainingPercent <= input.softRemainingPercent) continue;
    return id;
  }
  return null;
}

export type MonitorDecision = 'none' | 'refresh' | 'soft' | 'hard';

/** What the current account's remaining quota calls for, for a session in 'handoff' mode. */
export function monitorDecision(input: {
  policy: ContinuityDefaults;
  phase: 'idle' | 'replying' | 'awaiting_approval' | null;
  remainingPercent: number | null;
  lastTurnAt: string | null;
  now: Date;
}): MonitorDecision {
  const { policy, phase, remainingPercent, now } = input;
  if (policy.mode !== 'handoff' || remainingPercent === null || phase === null) return 'none';
  if (remainingPercent <= policy.hardRemainingPercent && phase === 'replying') return 'hard';
  const recent = input.lastTurnAt !== null && now.getTime() - Date.parse(input.lastTurnAt) < RECENT_TURN_MS;
  if (remainingPercent <= policy.softRemainingPercent && phase === 'idle' && recent) return 'soft';
  if (remainingPercent <= policy.softRemainingPercent + REFRESH_MARGIN_PERCENT && (phase === 'replying' || recent)) return 'refresh';
  return 'none';
}

/** What each step of a handoff tells a CLI. One line each: a newline would submit early. */
export { HANDOFF_MESSAGES as HANDOFF_PROMPTS } from '../contract/continuity.js';

// A reset time already past when the hit is read (the limit outlived the
// time the CLI gave): try again this much later rather than right away.
export const PAST_RESET_RETRY_MS = 10 * 60_000;
// A hit whose reset passed longer ago than this is history, not something
// to act on: a conversation left sitting on an old limit (seen the first
// time this runs, or after a long outage) is not carried on days later.
export const STALE_HIT_MS = 2 * 60 * 60_000;
// A carry-on due while the CLI waits on a prompt is put off this long, at
// most MAX_POSTPONES times.
export const POSTPONE_MS = 5 * 60_000;
export const MAX_POSTPONES = 6;
export const DAY_MS = 24 * 60 * 60_000;

export function effectivePolicy(defaults: ContinuityDefaults, override: ContinuityOverride): ContinuityDefaults {
  return { ...defaults, ...override };
}

/** Carry-ons in the 24 hours before `now`. */
export function resumesWithinDay(resumedAt: readonly string[], now: Date): string[] {
  return resumedAt.filter((at) => now.getTime() - Date.parse(at) < DAY_MS);
}

export type HitPlan =
  | { kind: 'ignore' }
  | { kind: 'stale' }
  | { kind: 'schedule'; wakeAt: string }
  | { kind: 'no_reset_time' }
  | { kind: 'daily_cap'; count: number };

/** A limit hit not seen before. */
export function planForHit(policy: ContinuityDefaults, hit: LimitHit, recentResumes: number, now: Date): HitPlan {
  if (policy.mode === 'off') return { kind: 'ignore' };
  // Without a reset time, how long ago it hit.
  if (now.getTime() - Date.parse(hit.resetsAt ?? hit.at) > STALE_HIT_MS) return { kind: 'stale' };
  if (recentResumes >= policy.maxAutoResumesPerDay) return { kind: 'daily_cap', count: recentResumes };
  if (!hit.resetsAt) return { kind: 'no_reset_time' };
  const resetsAt = Date.parse(hit.resetsAt);
  const wakeAt = resetsAt > now.getTime()
    ? resetsAt + policy.resumeDelaySeconds * 1000
    : now.getTime() + Math.max(PAST_RESET_RETRY_MS, policy.resumeDelaySeconds * 1000);
  return { kind: 'schedule', wakeAt: new Date(wakeAt).toISOString() };
}

/**
 * A hit the CLI carries on from by itself (hit.cliResumesAt), in any mode:
 * the app shows when, and checks a little after that it did.
 */
export function planForCliResume(policy: ContinuityDefaults, resumesAt: string, now: Date): HitPlan {
  const at = Date.parse(resumesAt);
  if (now.getTime() - at > STALE_HIT_MS) return { kind: 'stale' };
  return { kind: 'schedule', wakeAt: new Date(Math.max(at, now.getTime()) + policy.resumeDelaySeconds * 1000).toISOString() };
}

/** Where a session stands when its carry-on is due. */
export type WakeObservation = {
  policy: ContinuityDefaults;
  // null: the session is gone.
  session: null | {
    conversationId: string | null;
    running: boolean;
    phase: 'idle' | 'replying' | 'awaiting_approval' | null;
  };
  // The hit the conversation ends on now; null when it doesn't.
  currentHit: LimitHit | null;
  recentResumes: number;
};

export type DropReason =
  | 'mode_off'
  | 'session_gone'
  | 'conversation_changed'
  | 'cli_not_running'
  | 'already_continued'
  | 'daily_cap'
  | 'prompt_waiting'
  | 'cli_did_not_resume';

export type WakeDecision =
  | { kind: 'send' }
  | { kind: 'postpone'; wakeAt: string }
  | { kind: 'drop'; reason: DropReason };

/**
 * The carry-on is due. Sent only into the conversation that hit the limit,
 * still ending on that very hit, with the CLI alive and idle; a CLI waiting
 * on a prompt is given a few more chances.
 */
export function decideWake(pending: ContinuityPending, seen: WakeObservation, now: Date): WakeDecision {
  if (seen.policy.mode === 'off') return { kind: 'drop', reason: 'mode_off' };
  if (!seen.session) return { kind: 'drop', reason: 'session_gone' };
  if (seen.session.conversationId !== pending.conversationId) return { kind: 'drop', reason: 'conversation_changed' };
  if (!seen.session.running) return { kind: 'drop', reason: 'cli_not_running' };
  if (seen.session.phase === 'replying') return { kind: 'drop', reason: 'already_continued' };
  if (!seen.currentHit || seen.currentHit.at !== pending.hit.at) return { kind: 'drop', reason: 'already_continued' };
  if (seen.recentResumes >= seen.policy.maxAutoResumesPerDay) return { kind: 'drop', reason: 'daily_cap' };
  if (seen.session.phase === 'awaiting_approval') return postponeOrDrop(pending, now);
  return { kind: 'send' };
}

/**
 * The CLI was to carry on by itself by now (pending.by 'cli'): whether it
 * did. The app sends nothing either way — a CLI still on the hit was most
 * likely told not to (Esc in its terminal).
 */
export function decideCliWake(pending: ContinuityPending, seen: WakeObservation): { kind: 'resumed' } | { kind: 'drop'; reason: DropReason } {
  if (!seen.session) return { kind: 'drop', reason: 'session_gone' };
  if (seen.session.conversationId !== pending.conversationId) return { kind: 'drop', reason: 'conversation_changed' };
  if (seen.session.phase === 'replying') return { kind: 'resumed' };
  if (!seen.currentHit || seen.currentHit.at !== pending.hit.at) return { kind: 'resumed' };
  if (!seen.session.running) return { kind: 'drop', reason: 'cli_not_running' };
  return { kind: 'drop', reason: 'cli_did_not_resume' };
}

/** Put off again, unless it has been put off enough. */
export function postponeOrDrop(pending: ContinuityPending, now: Date): WakeDecision {
  if (pending.postponed >= MAX_POSTPONES) return { kind: 'drop', reason: 'prompt_waiting' };
  return { kind: 'postpone', wakeAt: new Date(now.getTime() + POSTPONE_MS).toISOString() };
}
