import { parseResetText } from '../account-status/reset-time.js';
import type { LimitHit } from '../contract/continuity.js';
import { textFromContent } from './msg.js';

// How Claude Code records stopping on a usage limit. Verified against the
// transcripts of 2.1.259 through 2.1.288 (fixtures in
// api/test/fixtures/limit-hits/): a synthetic assistant record
//   { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
//     apiErrorStatus: 429, message: { model: '<synthetic>', content:
//     [{ type: 'text', text: "You've hit your session limit · resets 6:30am (Asia/Taipei)" }] },
//     quotaLimits: { rateLimitType: 'five_hour', resetsAt: <epoch seconds>, status: 'rejected', … } }
// The structured quotaLimits is read first; the text is the fallback.
//
// From 2.1.296 (fixture claude.session-limit.2.1.296.jsonl) the CLI also
// carries on by itself at the reset, and says so in the record after it:
//   { type: 'system', subtype: 'informational',
//     content: 'Usage limit reached · continuing automatically at 9:30pm · esc to cancel' }
// Background tasks that stopped on the same limit then report in after the
// hit as transcript-only notes ({ type: 'user', queueTranscriptOnly: true,
// origin: { kind: 'task-notification' } }): the model never sees them, so
// they don't carry the conversation on.

// Kinds of limit actually seen in a transcript. Any other rateLimitType is
// still a limit hit, reported as scope 'unknown' with its own word kept.
const LIMIT_TYPES: Record<string, Pick<LimitHit, 'scope' | 'model'>> = {
  five_hour: { scope: 'session', model: null },
};

const RESETS_IN_TEXT = /\bresets\s+(.+?)\s*$/i;
const CLI_RESUMES_TEXT = /\bcontinuing automatically at\b/i;

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

// A record that is part of the main conversation: what the user or the
// model said, or a tool's result. Everything else the CLI writes between
// them (system notes, attachments, queue bookkeeping, a subagent's
// sidechain, meta companions) neither causes nor clears a limit hit.
function isConversationRecord(rec: Rec): boolean {
  if (rec.type !== 'user' && rec.type !== 'assistant') return false;
  if (rec.isMeta === true || rec.isSidechain === true) return false;
  // Written for the record only, never sent to the model.
  if (rec.queueTranscriptOnly === true) return false;
  return asRecord(rec.message) !== null;
}

function fromRecord(rec: Rec, now: Date): LimitHit | null {
  if (rec.type !== 'assistant' || rec.isApiErrorMessage !== true || rec.error !== 'rate_limit') return null;
  const at = typeof rec.timestamp === 'string' ? rec.timestamp : now.toISOString();
  const message = textFromContent(asRecord(rec.message)?.content);
  const quota = asRecord(rec.quotaLimits);
  if (quota) {
    const limitType = typeof quota.rateLimitType === 'string' ? quota.rateLimitType : null;
    const known = limitType ? LIMIT_TYPES[limitType] : undefined;
    const resetsAt = typeof quota.resetsAt === 'number' && Number.isFinite(quota.resetsAt)
      ? new Date(quota.resetsAt * 1000).toISOString()
      : null;
    return {
      at, scope: known?.scope ?? 'unknown', limitType, model: known?.model ?? null,
      resetsAt, message, ruleId: 'claude-code/quota-limits',
    };
  }
  // The wording is relative to when it was written, not to now.
  const resetsText = RESETS_IN_TEXT.exec(message)?.[1];
  const resetsAt = resetsText ? parseResetText(`Resets ${resetsText}`, new Date(at)) : null;
  return { at, scope: 'unknown', limitType: null, model: null, resetsAt, message, ruleId: 'claude-code/message-text' };
}

// When the CLI says, right after the hit, that it carries on by itself: at
// the hit's reset. Its own wording gives no zone, so a hit without a reset
// time is left to the app.
function cliResumesAt(records: readonly unknown[], after: number, hit: LimitHit): string | null {
  if (!hit.resetsAt) return null;
  for (let i = after + 1; i < records.length; i++) {
    const rec = asRecord(records[i]);
    if (!rec || rec.type !== 'system' || rec.subtype !== 'informational' || typeof rec.content !== 'string') continue;
    if (CLI_RESUMES_TEXT.test(rec.content)) return hit.resetsAt;
  }
  return null;
}

/**
 * The limit hit the conversation ends on, if it does: its last
 * conversation record is the CLI's rate-limit error. Anything said after
 * it — the user carrying on, a background task waking the model — means
 * it is no longer where things stand.
 */
export function claudeLimitHit(records: readonly unknown[], now: Date = new Date()): LimitHit | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = asRecord(records[i]);
    if (!rec || !isConversationRecord(rec)) continue;
    const hit = fromRecord(rec, now);
    if (!hit) return null;
    const resumesAt = cliResumesAt(records, i, hit);
    return resumesAt ? { ...hit, cliResumesAt: resumesAt } : hit;
  }
  return null;
}
