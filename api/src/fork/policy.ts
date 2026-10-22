import type { ErrorCode } from '../contract/errors.js';
import type { Fork, ForkMemory, ForkMemoryReason } from '../contract/fork.js';
import { forkDefaultTitle } from '../contract/spawnTitle.js';
import { t } from '../i18n/index.js';

// What a branch line may be, as pure functions of what was observed. engine.ts
// gathers the observations and carries the decisions out.

export { forkStatus } from '../contract/fork.js';

/**
 * Native fork only for the same profile (the same account and folders the
 * conversation was recorded under), a runtime that forks, and a
 * conversation that can be forked; a brief otherwise (決策 3).
 */
export function chooseMemory(input: {
  parentProfileId: string | null;
  profileId: string;
  forkBlocked: 'runtime_unsupported' | 'conversation_unforkable' | null;
}): { memory: ForkMemory; reason: ForkMemoryReason | null } {
  if (input.parentProfileId !== input.profileId) return { memory: 'brief', reason: 'other_profile' };
  if (input.forkBlocked) return { memory: 'brief', reason: input.forkBlocked };
  return { memory: 'native', reason: null };
}

/** A title from the first instruction, else from the main line. */
export function forkTitle(input: { title?: string; instruction: string | null; parentTitle: string }): string {
  return input.title?.trim() || forkDefaultTitle(input.instruction, input.parentTitle, (title) => t('fork.title.branchOf', { title }));
}

// The account's quota under this many percent asks the user to confirm
// first (as the user's own delegation does with the default floor).
export const FORK_MIN_REMAINING_PERCENT = 20;

export type QuotaReading = { remainingPercent: number | null; limitedUntil: string | null };

export type ForkRefusal = { ok: false; status: 400 | 403 | 404 | 409; code: ErrorCode; message: string; params?: Record<string, string> };

/**
 * A low quota on the profile's account (under the floor, or over its limit
 * as continuity saw it) waits for the user to confirm; unknown is allowed.
 * The branch line's own continuity carries it past the limit.
 */
export function gateForkQuota(quota: QuotaReading, now: Date, confirmed: boolean): ForkRefusal | null {
  if (confirmed) return null;
  const min = String(FORK_MIN_REMAINING_PERCENT);
  if (quota.limitedUntil && Date.parse(quota.limitedUntil) > now.getTime()) {
    return {
      ok: false, status: 409, code: 'quota_low_confirm', message: `the account is over its usage limit until ${quota.limitedUntil}; confirm to open the branch line anyway`,
      params: { remaining: '0', min, until: quota.limitedUntil },
    };
  }
  if (quota.remainingPercent !== null && quota.remainingPercent < FORK_MIN_REMAINING_PERCENT) {
    return {
      ok: false, status: 409, code: 'quota_low_confirm', message: `the account has ${quota.remainingPercent}% left; confirm to open the branch line anyway`,
      params: { remaining: String(quota.remainingPercent), min },
    };
  }
  return null;
}

/**
 * The branch line a session is (not one closed): what its tmux's
 * HESTIA_FORK_ID names, also when the tmux is made again.
 */
export function openForkOf<T extends Pick<Fork, 'childSessionId' | 'closedAt' | 'createdAt'>>(forks: readonly T[], sessionId: string): T | null {
  return forks
    .filter((fork) => fork.childSessionId === sessionId && !fork.closedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
