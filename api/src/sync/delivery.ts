import { DELIVERY_ECHO_TIMEOUT_MS, DELIVERY_RECEIPT_WINDOW_MS, TRANSCRIPT_CLOCK_SKEW_MS } from '../config.js';
import type { Msg } from '../providers/msg.js';
import type { OutgoingSend } from '../types.js';

export type { OutgoingSend };

// Enough to cover a burst of sends while a CLI is stuck behind a dialog;
// the oldest entries are the least useful to keep.
const MAX_TRACKED_SENDS = 10;

/**
 * Track a send until the transcript shows it. Slash commands are skipped:
 * they never produce a user-role transcript entry (see msg.ts isWrapper),
 * so tracking them would only ever raise false alarms.
 */
export function recordSend(sends: readonly OutgoingSend[] | undefined, text: string, at: string, midReply = false): OutgoingSend[] {
  const current = [...(sends ?? [])];
  if (!text.trim() || text.trim().startsWith('/')) return current;
  return [...current, { text, at, flagged: false, ...(midReply ? { midReply } : {}) }].slice(-MAX_TRACKED_SENDS);
}

/**
 * Settle tracked sends against the transcript's user messages, or against
 * nothing when no transcript is bound yet (e.g. a CLI whose transcript only
 * appears after its first prompt — exactly when a start-up dialog can eat
 * that prompt). A send is confirmed by a user message at or after it whose
 * text matches; anything unconfirmed past the timeout is flagged. Returns
 * null when nothing changed. `lastReplyingAt`: when a reply was last seen
 * in progress, which holds back the timeout of sends made mid-reply.
 * `turnStarts`: when the CLI started each turn, for a CLI that writes a
 * message only once the turn gets to it (TranscriptAdapter.parseTurnStarts).
 */
export function reconcileSends(
  sends: readonly OutgoingSend[] | undefined,
  messages: readonly Msg[] | null,
  now: number,
  lastReplyingAt?: number,
  turnStarts: readonly string[] = [],
): OutgoingSend[] | null {
  if (!sends || sends.length === 0) return null;
  const userMessages = (messages ?? []).filter((message) => message.role === 'user');
  const used = new Set<number>();
  const usedStarts = new Set<string>(sends.flatMap((send) => send.receivedAt ? [send.receivedAt] : []));
  let changed = false;
  const next: OutgoingSend[] = [];
  for (const send of sends) {
    const sentAt = Date.parse(send.at);
    const match = userMessages.findIndex((message, index) => !used.has(index)
      && (message.ts === null || !Number.isFinite(sentAt) || Date.parse(message.ts) >= sentAt - TRANSCRIPT_CLOCK_SKEW_MS)
      && sameText(message.text, send.text));
    if (match >= 0) {
      used.add(match);
      changed = true;
      continue;
    }
    let current = send;
    // A send made from idle starts the CLI's next turn: one starting right
    // after it means the CLI took it in, even before its text shows up. A
    // mid-reply send starts nothing of its own, so it never counts.
    if (!current.receivedAt && !current.midReply && Number.isFinite(sentAt)) {
      const start = turnStarts.find((ts) => !usedStarts.has(ts) && withinReceipt(Date.parse(ts), sentAt));
      if (start) {
        usedStarts.add(start);
        current = { ...current, receivedAt: start, flagged: false };
        changed = true;
      }
    }
    // A received send waits for its text until the CLI writes its turn's
    // message; one that then isn't this text (cut short, or the turn was
    // not this send's after all) falls back to the plain clock.
    const receivedAt = current.receivedAt ? Date.parse(current.receivedAt) : NaN;
    const awaitingEcho = Number.isFinite(receivedAt) && !userMessages.some((message, index) => !used.has(index)
      && message.ts !== null && Date.parse(message.ts) >= receivedAt - TRANSCRIPT_CLOCK_SKEW_MS);
    // A mid-reply send waits in the CLI's queue until the reply ends (or
    // is taken in mid-turn, which the follow-up parse confirms), so its
    // clock starts over whenever a reply is still seen in progress. A send
    // made from idle keeps its plain clock: that reply is its own, and a
    // start-up dialog eating it must still surface.
    const clockFrom = current.midReply && lastReplyingAt !== undefined ? Math.max(sentAt, lastReplyingAt) : sentAt;
    const overdue = !awaitingEcho && (!Number.isFinite(sentAt) || now - clockFrom >= DELIVERY_ECHO_TIMEOUT_MS);
    if (overdue && !current.flagged) {
      next.push({ ...current, flagged: true });
      changed = true;
    } else {
      next.push(current);
    }
  }
  return changed ? next : null;
}

function withinReceipt(startedAt: number, sentAt: number): boolean {
  return startedAt >= sentAt - TRANSCRIPT_CLOCK_SKEW_MS && startedAt <= sentAt + DELIVERY_RECEIPT_WINDOW_MS;
}

export type SendTransition =
  | { kind: 'received'; send: OutgoingSend; wasFlagged: boolean }
  | { kind: 'flagged'; send: OutgoingSend }
  | { kind: 'confirmed'; send: OutgoingSend };

/**
 * What changed for each send between two reconciles, for the session
 * events: a send taken as received (and whether it had already been shown
 * as undelivered), flagged, or confirmed after either. A send that is
 * simply confirmed in time is not worth a line.
 */
export function sendTransitions(before: readonly OutgoingSend[], after: readonly OutgoingSend[]): SendTransition[] {
  const transitions: SendTransition[] = [];
  for (const send of before) {
    const now = after.find((candidate) => candidate.at === send.at && candidate.text === send.text);
    if (!now) {
      if (send.flagged || send.receivedAt) transitions.push({ kind: 'confirmed', send });
      continue;
    }
    if (now.receivedAt && !send.receivedAt) transitions.push({ kind: 'received', send: now, wasFlagged: send.flagged });
    if (now.flagged && !send.flagged) transitions.push({ kind: 'flagged', send: now });
  }
  return transitions;
}

/** Drop one tracked send (dismissed, or put back into the composer). */
export function dismissSend(sends: readonly OutgoingSend[] | undefined, at: string): OutgoingSend[] | null {
  if (!sends?.some((send) => send.at === at)) return null;
  return sends.filter((send) => send.at !== at);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// CLIs may store a prompt slightly reformatted (whitespace, a wrapper
// prefix, a pasted-text placeholder), so long texts also match by
// containment; short ones must match exactly to avoid "hi" ⊂ "hi there".
function sameText(transcriptText: string, sentText: string): boolean {
  const a = normalize(transcriptText);
  const b = normalize(sentText);
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a));
}
