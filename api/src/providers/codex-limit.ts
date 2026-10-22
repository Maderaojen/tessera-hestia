import { zonedTimeToUtc } from '../account-status/reset-time.js';
import type { LimitHit } from '../contract/continuity.js';

// How Codex CLI records stopping on a usage limit. Verified against the
// rollouts of 0.153.4 and 0.156.1 (fixtures in api/test/fixtures/limit-hits/):
// the turn ends with
//   { type: 'event_msg', payload: { type: 'task_complete', error: {
//       codex_error_info: 'usage_limit_exceeded',
//       message: "You've hit your usage limit. … try again at 5:30 PM." } } }
// and the token_count just before it reports the window that ran out:
//   payload.rate_limits = { limit_id: 'codex', primary: { used_percent: 100,
//     window_minutes: 300, resets_at: <epoch seconds> }, secondary: { … 10080 … } }
// The wording's time is the host's local time (no zone is printed); it is
// only the fallback.

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

const WINDOW_KINDS: Record<number, Pick<LimitHit, 'scope' | 'limitType'>> = {
  300: { scope: 'session', limitType: 'five_hour' },
  10080: { scope: 'weekly', limitType: 'seven_day' },
};

// The window at 100% in the token_count closest before the hit.
function exhaustedWindow(records: readonly unknown[], before: number): Pick<LimitHit, 'scope' | 'limitType' | 'resetsAt'> | null {
  for (let i = before - 1; i >= 0; i--) {
    const payload = asRecord(asRecord(records[i])?.payload);
    if (payload?.type !== 'token_count') continue;
    const limits = asRecord(payload.rate_limits);
    for (const key of ['primary', 'secondary']) {
      const window = asRecord(limits?.[key]);
      if (!window || typeof window.used_percent !== 'number' || window.used_percent < 100) continue;
      const minutes = typeof window.window_minutes === 'number' ? window.window_minutes : NaN;
      const kind = WINDOW_KINDS[minutes] ?? { scope: 'unknown' as const, limitType: Number.isFinite(minutes) ? `${minutes}m` : null };
      const resetsAt = typeof window.resets_at === 'number' ? new Date(window.resets_at * 1000).toISOString() : null;
      return { ...kind, resetsAt };
    }
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const TRY_AGAIN = /try again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?([AP]M)/i;

/** "try again at 5:30 PM." / "try again at Aug 28th, 2026 10:06 AM." in `timeZone`, from `written`. */
export function parseCodexRetryTime(message: string, written: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  const m = TRY_AGAIN.exec(message);
  if (!m) return null;
  const hour = (Number(m[4]) % 12) + (m[6]!.toUpperCase() === 'PM' ? 12 : 0);
  const minute = Number(m[5]);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(written);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (month === 0) return null;
    return new Date(zonedTimeToUtc({ year: Number(m[3]), month, day: Number(m[2]), hour, minute }, timeZone)).toISOString();
  }
  let instant = zonedTimeToUtc({ year: get('year'), month: get('month'), day: get('day'), hour, minute }, timeZone);
  // A time of day earlier than when it was written is tomorrow's.
  if (instant <= written.getTime()) instant += 24 * 60 * 60_000;
  return new Date(instant).toISOString();
}

/**
 * The limit hit the rollout ends on: its last turn event is a task_complete
 * with usage_limit_exceeded. A later task_started or user message is a new
 * attempt, so the hit is behind it.
 */
export function codexLimitHit(records: readonly unknown[]): LimitHit | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = asRecord(records[i]);
    if (rec?.type !== 'event_msg') continue;
    const payload = asRecord(rec.payload);
    if (payload?.type === 'task_started' || payload?.type === 'user_message') return null;
    if (payload?.type !== 'task_complete') continue;
    const error = asRecord(payload.error);
    if (error?.codex_error_info !== 'usage_limit_exceeded') return null;
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : new Date().toISOString();
    const message = typeof error.message === 'string' ? error.message : '';
    const window = exhaustedWindow(records, i);
    if (window) return { at, ...window, model: null, message, ruleId: 'codex-cli/rate-limits' };
    return {
      at, scope: 'unknown', limitType: null, model: null,
      resetsAt: parseCodexRetryTime(message, new Date(at)), message, ruleId: 'codex-cli/message-text',
    };
  }
  return null;
}
