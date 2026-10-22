import {
  DELEGATION_LIMIT_KEYS, DELEGATION_TERMINAL_STATUSES, isStricterLimit,
  type DelegationInitiator, type DelegationIsolation, type DelegationLimits, type DelegationOverride, type DelegationPreferences,
  type DelegationReport, type DelegationStatus,
} from '../contract/delegation.js';
import type { ErrorCode } from '../contract/errors.js';
import { prompt } from '../i18n/index.js';
import { branchName as spawnBranchName, worktreeFolderName as spawnFolderName } from '../spawn/naming.js';

// What a delegation may do next, as pure functions of what was observed. engine.ts gathers the
// observations and carries the decisions out.

export const DEFAULT_PREFERENCES: DelegationPreferences = {
  targets: [],
  llmInitiated: 'ask',
  isolation: 'worktree',
  parentReview: false,
  notify: 'key',
  idleAttentionMinutes: 20,
};

export const DEFAULT_LIMITS: DelegationLimits = {
  maxConcurrent: 3,
  maxDepth: 1,
  maxReviewRounds: 3,
  minRemainingPercent: 20,
};

export function isTerminal(state: DelegationStatus): boolean {
  return DELEGATION_TERMINAL_STATUSES.includes(state);
}

// Who may move a delegation where (the table's rows): 'review' is the
// delegating LLM's verdict, 'send_back' the user's; 'cleanup' removes the
// worktree of one that is over.
export type DelegationAction = 'approve' | 'decline' | 'deliver' | 'review' | 'send_back' | 'accept' | 'reject' | 'stop' | 'cleanup';

export function allows(state: DelegationStatus, action: DelegationAction): boolean {
  switch (action) {
    case 'review':
      return state === 'reviewing';
    case 'send_back':
      return state === 'reviewing' || state === 'delivered';
    case 'cleanup':
      return isTerminal(state);
    case 'approve':
    case 'decline':
      return state === 'proposed';
    case 'deliver':
      return state === 'working' || state === 'needs_attention';
    case 'accept':
    case 'reject':
      return state === 'delivered' || state === 'reviewing';
    case 'stop':
      return !isTerminal(state);
  }
}

// Titles, branch and folder names are shared with branch lines (spawn/naming.ts).
export { defaultTitle, slugify } from '../spawn/naming.js';

export function branchName(id: string, title: string): string {
  return spawnBranchName('delegate', id, title);
}

/** The worktree's own folder name (spawn/naming.ts). */
export function worktreeFolderName(repoName: string, id: string): string {
  return spawnFolderName('delegate', repoName, id);
}

// What the delegate's session looks like, for the checks below.
export type ChildActivity = {
  running: boolean;
  switching: boolean;
  phase: 'idle' | 'replying' | 'awaiting_approval' | null;
  lastTurnAt: string | null;
  lastSentAt: string | null;
};

const latest = (...times: (string | null)[]): number => Math.max(0, ...times.filter((at): at is string => !!at).map(Date.parse));

/** When the delegate was last seen at work: a turn starting or ending, or what was recorded. */
export function lastActive(recorded: string | null, child: Pick<ChildActivity, 'lastTurnAt' | 'lastSentAt'>): number {
  return latest(recorded, child.lastTurnAt, child.lastSentAt);
}

export type WorkingCheck = 'none' | 'idle' | 'cli_exited';

/**
 * A delegation at work that needs a person: its CLI ended, or it has sat
 * without a turn for `idleAttentionMinutes` without delivering. Neither
 * while continuity is about to carry it on (a usage-limit reset or a
 * handoff), nor while the CLI is being relaunched.
 */
export function checkWorking(input: {
  child: ChildActivity;
  lastActivityAt: string | null;
  continuityBusy: boolean;
  idleAttentionMinutes: number;
  now: Date;
}): WorkingCheck {
  const { child, continuityBusy, now } = input;
  if (continuityBusy || child.switching) return 'none';
  if (!child.running) return 'cli_exited';
  if (child.phase === 'replying') return 'none';
  const since = lastActive(input.lastActivityAt, child);
  if (since > 0 && now.getTime() - since >= input.idleAttentionMinutes * 60_000) return 'idle';
  return 'none';
}

/**
 * A delegation needing attention goes back to work once its delegate starts
 * a turn the user gave it after the delegation stopped to ask (answering
 * in its tmux): a turn already going when it asked — the delegate's own
 * `hestia delegate done --blocked` runs inside one — doesn't count.
 */
export function resumedWork(child: ChildActivity, stateSince: string): boolean {
  return child.running && child.phase === 'replying' && !!child.lastSentAt && Date.parse(child.lastSentAt) > Date.parse(stateSince);
}

// --- the delegating LLM's review (決策 5, 13) ----------------------------------

/** How many times the delegating LLM sent it back (the user's own send-backs don't count). */
export function llmSendBacks(reports: readonly Pick<DelegationReport, 'kind' | 'by' | 'verdict'>[]): number {
  return reports.filter((report) => report.kind === 'review' && report.by === 'parent' && report.verdict === 'send_back').length;
}

export type DeliveryRoute = { state: 'reviewing' } | { state: 'delivered'; reason: 'review_rounds' | 'parent_gone' | null };

/**
 * Where a delivery goes: to the delegating LLM to review first when
 * parentReview is on, its session is there, and it may still send it back
 * (`maxReviewRounds` counts the LLM's send-backs; a review that can only
 * pass would be for nothing); otherwise straight to the user, saying why.
 */
export function routeDelivery(input: { parentReview: boolean; parentAlive: boolean; sendBacks: number; maxReviewRounds: number }): DeliveryRoute {
  if (!input.parentReview) return { state: 'delivered', reason: null };
  if (!input.parentAlive) return { state: 'delivered', reason: 'parent_gone' };
  if (input.sendBacks >= input.maxReviewRounds) return { state: 'delivered', reason: 'review_rounds' };
  return { state: 'reviewing' };
}

/**
 * A review that can't happen any more: the delegating session is gone, or
 * has moved on to another conversation (a continuity handoff is the same
 * work, and doesn't count). null while it still can.
 */
export function reviewEnds(input: { parentAlive: boolean; sameWork: boolean }): 'parent_gone' | 'parent_switched' | null {
  if (!input.parentAlive) return 'parent_gone';
  if (!input.sameWork) return 'parent_switched';
  return null;
}

// --- settings: global → this tmux → this delegation (ADR 0015 決策 10) -----

/** The first limit a tmux would loosen beyond the global one, or null when none does. */
export function looserLimit(global: DelegationLimits, override: Partial<DelegationLimits>): keyof DelegationLimits | null {
  for (const key of DELEGATION_LIMIT_KEYS) {
    const value = override[key];
    if (value !== undefined && !isStricterLimit(key, value, global[key])) return key;
  }
  return null;
}

export function effectivePreferences(global: DelegationPreferences, override: Partial<DelegationPreferences> | undefined): DelegationPreferences {
  return { ...global, ...(override ?? {}) };
}

/** Per field the stricter of the global limit and the tmux's own (a looser one, saved before the global changed, never wins). */
export function effectiveLimits(global: DelegationLimits, override: Partial<DelegationLimits> | undefined): DelegationLimits {
  const limits = { ...global };
  for (const key of DELEGATION_LIMIT_KEYS) {
    const value = override?.[key];
    if (value !== undefined && isStricterLimit(key, value, global[key])) limits[key] = value;
  }
  return limits;
}

/** A stored override with `patch` applied; null drops a field back to the global value. */
export function applyOverridePatch<T extends object>(current: Partial<T>, patch: { [K in keyof T]?: T[K] | null } | undefined): Partial<T> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as Partial<T>;
}

export function emptyOverride(): DelegationOverride {
  return { preferences: {}, limits: {} };
}

// --- the checks before a delegation starts (決策 7, 10, 14) -----------------

export type CheckRefusal = { ok: false; status: 400 | 409; code: ErrorCode; message: string; params?: Record<string, string> };

const refusal = (status: CheckRefusal['status'], code: ErrorCode, message: string, params?: Record<string, string>): CheckRefusal => (
  { ok: false, status, code, message, ...(params ? { params } : {}) }
);

/** Whether an LLM may start one here at all, and whether it waits for the user's approval. */
export function checkInitiation(initiator: DelegationInitiator, preferences: DelegationPreferences): CheckRefusal | { ok: true; propose: boolean } {
  if (initiator !== 'llm') return { ok: true, propose: false };
  if (preferences.llmInitiated === 'off') return refusal(409, 'delegation_disabled', 'delegating is off for LLMs in this tmux');
  return { ok: true, propose: preferences.llmInitiated === 'ask' };
}

/**
 * The profile it goes to. An LLM may only pick one of the targets, the
 * first by default; with none, it can't delegate. The user picks any
 * available profile (the first target when they don't say).
 */
export function pickProfile(input: {
  initiator: DelegationInitiator;
  requested: string | undefined;
  targets: readonly string[];
  available: readonly string[];
}): CheckRefusal | { ok: true; profileId: string } {
  const { initiator, requested, targets, available } = input;
  if (initiator === 'llm') {
    if (!targets.length) return refusal(409, 'profile_not_allowed', 'no profile is allowed for LLMs to delegate to; the user sets them in Settings');
    if (requested && !targets.includes(requested)) {
      return refusal(409, 'profile_not_allowed', `${requested} is not one of the profiles LLMs may delegate to (${targets.join(', ')})`, { profile: requested });
    }
  }
  const profileId = requested ?? targets[0];
  if (!profileId) return refusal(400, 'invalid_request', 'profileId is required (no default target is set)');
  if (!available.includes(profileId)) return refusal(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
  return { ok: true, profileId };
}

/** Isolation for this one: an LLM may only make it stricter (shared → worktree), the user either way. */
export function pickIsolation(initiator: DelegationInitiator, requested: DelegationIsolation | undefined, preferred: DelegationIsolation): CheckRefusal | { ok: true; isolation: DelegationIsolation } {
  if (!requested) return { ok: true, isolation: preferred };
  if (initiator === 'llm' && requested === 'shared' && preferred === 'worktree') {
    return refusal(400, 'invalid_request', 'an LLM may not share the delegating folder when the settings say worktree');
  }
  return { ok: true, isolation: requested };
}

/** A delegate delegating again goes one deeper than its own delegation. */
export function depthOf(parentDelegationDepth: number | null): number {
  return parentDelegationDepth === null ? 1 : parentDelegationDepth + 1;
}

export function checkDepth(depth: number, limits: DelegationLimits): CheckRefusal | null {
  return depth > limits.maxDepth
    ? refusal(409, 'limit_reached', `a delegation ${depth} deep is more than the limit (${limits.maxDepth})`, { limit: 'depth', max: String(limits.maxDepth) })
    : null;
}

/**
 * How many at once: host-wide against the global limit, and this tmux's
 * own against its override when it has one. Counts every delegation not
 * over (a proposal too), not counting the one being approved.
 */
export function checkConcurrent(input: {
  activeOnHost: number;
  activeFromParent: number;
  globalMax: number;
  parentMax: number | undefined;
}): CheckRefusal | null {
  if (input.activeOnHost >= input.globalMax) {
    return refusal(409, 'limit_reached', `${input.activeOnHost} delegations are going on this host (limit ${input.globalMax})`, { limit: 'concurrent', max: String(input.globalMax) });
  }
  if (input.parentMax !== undefined && input.activeFromParent >= input.parentMax) {
    return refusal(409, 'limit_reached', `${input.activeFromParent} delegations from this tmux are going (its limit ${input.parentMax})`, { limit: 'concurrent', max: String(input.parentMax) });
  }
  return null;
}

export type QuotaReading = {
  // The lower of the 5-hour and 7-day remaining percent; null when unknown.
  remainingPercent: number | null;
  // Continuity has the account over its limit until then; null when not.
  limitedUntil: string | null;
};

/**
 * The target account's quota: too low under the floor, or while continuity
 * has it over its limit. Unknown is allowed (as continuity's selectTarget
 * does) and recorded as null.
 */
export function checkQuota(quota: QuotaReading, limits: DelegationLimits, now: Date): CheckRefusal | { ok: true; quotaAtStart: number | null } {
  if (quota.limitedUntil && Date.parse(quota.limitedUntil) > now.getTime()) {
    return refusal(409, 'quota_too_low', `the target account is over its usage limit until ${quota.limitedUntil}`, {
      remaining: '0', min: String(limits.minRemainingPercent), until: quota.limitedUntil,
    });
  }
  if (quota.remainingPercent !== null && quota.remainingPercent < limits.minRemainingPercent) {
    return refusal(409, 'quota_too_low', `the target account has ${quota.remainingPercent}% left (the floor is ${limits.minRemainingPercent}%)`, {
      remaining: String(quota.remainingPercent), min: String(limits.minRemainingPercent),
    });
  }
  return { ok: true, quotaAtStart: quota.remainingPercent };
}

/**
 * What a low quota means for this start (決策 7): an LLM's is refused; the
 * user's asks them to confirm first, and goes ahead once they have —
 * `overridden` is the refusal they went past, written down as a decision.
 */
export function gateQuota(input: {
  check: ReturnType<typeof checkQuota>;
  quota: QuotaReading;
  initiator: DelegationInitiator;
  confirmed: boolean;
}): CheckRefusal | { ok: true; quotaAtStart: number | null; overridden: CheckRefusal | null } {
  const { check } = input;
  if (check.ok) return { ...check, overridden: null };
  if (input.initiator !== 'user') return check;
  if (!input.confirmed) {
    return refusal(409, 'quota_low_confirm', `${check.message}; confirm to delegate anyway`, check.params);
  }
  return { ok: true, quotaAtStart: input.quota.remainingPercent, overridden: check };
}

/** The decision written down when the user delegates on a low quota anyway. */
export function lowQuotaDecision(overridden: CheckRefusal): string {
  const params = overridden.params ?? {};
  const why = params.until
    ? prompt('delegation.record.lowQuotaUntil', { until: params.until })
    : prompt('delegation.record.lowQuotaRemaining', { remaining: params.remaining ?? '?', min: params.min ?? '?' });
  return prompt('delegation.record.lowQuotaOverridden', { why });
}

// A proposal nobody answers is dropped after this long.
export const PROPOSAL_EXPIRY_MS = 24 * 60 * 60_000;

export function proposalExpired(createdAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(createdAt) >= PROPOSAL_EXPIRY_MS;
}

// --- telling the delegating conversation (決策 6) ----------------------------

// The delegating CLI is left alone this long after its last turn ended (or
// a message was sent), so a message never lands right as the user carries on.
export const PARENT_QUIET_MS = 30_000;

export type ParentActivity = ChildActivity & { startupPrompt: unknown; interaction: boolean };

/**
 * Whether the delegating CLI can be told something now: up, at its input
 * box with nothing on screen, not being switched or handed off, and quiet
 * for a while — never in the middle of its work.
 */
export function parentReady(parent: ParentActivity, continuityBusy: boolean, now: Date): boolean {
  if (!parent.running || parent.switching || continuityBusy) return false;
  if (parent.phase !== 'idle' || parent.startupPrompt || parent.interaction) return false;
  const since = lastActive(null, parent);
  return since === 0 || now.getTime() - since >= PARENT_QUIET_MS;
}

/** Which events the user is pushed about: 'key' ones always, the rest only with notify 'all'. */
export type NotifyLevel = 'key' | 'all';

export function shouldNotify(level: NotifyLevel, preference: DelegationPreferences['notify']): boolean {
  return level === 'key' || preference === 'all';
}

/**
 * The delegation a session works on as the delegate, if any (not one
 * that is over): what its tmux's HESTIA_DELEGATION_ID names, also when the
 * tmux is made again (a dead one recovered).
 */
export function activeDelegationOf<T extends { id: string; childSessionId: string | null; state: DelegationStatus; createdAt: string }>(
  delegations: readonly T[], sessionId: string,
): T | null {
  return delegations
    .filter((d) => d.childSessionId === sessionId && !isTerminal(d.state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
