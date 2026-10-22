import { COMMAND_NAME } from '../config.js';
import { DELEGATION_MESSAGES, type Delegation, type DelegationOutboxItem, type DelegationParentEvent } from '../contract/delegation.js';
import { formatFeedback, formatParentReport } from './brief.js';
import { isTerminal, parentReady } from './policy.js';
import { prompt, type PromptKey } from '../i18n/index.js';
import { addReport, since, type StepContext } from './record.js';
import { reportFileOf } from './startup.js';

// What a delegation has to say to a CLI, said only while that CLI is idle
// (never interrupting it) and read back like the brief (ADR 0015 決策 6):
// to the delegating conversation, what became of its delegation; to the
// delegate, a send-back's feedback. One line each, pointing at a file. The
// queue is in delegation.json, so a restart keeps it; a session that is
// gone gets nothing, and that is written down.

// The transcript has shown what arrived by then (continuity's numbers).
const OWN_SEND_SLACK_MS = 3_000;
export const MISSING_GIVE_UP_MS = 30_000;
// Typed in at most this many times (once more after it arrived cut short
// or not at all).
export const MAX_ATTEMPTS = 2;

// Written into the delegation's record (a report), so in i18n/prompts.
const DROPPED = {
  parent_gone: 'delegation.dropped.parentGone',
  child_gone: 'delegation.dropped.childGone',
  over: 'delegation.dropped.over',
  not_delivered: 'delegation.dropped.notDelivered',
  report_failed: 'delegation.dropped.reportFailed',
} satisfies Record<string, PromptKey>;

const RECIPIENT: Record<DelegationOutboxItem['to'], PromptKey> = { parent: 'delegation.dropped.toParent', child: 'delegation.dropped.toChild' };

function drop(ctx: StepContext, delegation: Delegation, item: DelegationOutboxItem, reason: keyof typeof DROPPED, detail?: string): void {
  delegation.outbox = delegation.outbox.filter((candidate) => candidate !== item);
  addReport(ctx, delegation, {
    kind: 'decision', by: 'system',
    text: prompt(detail ? 'delegation.dropped.recordDetail' : 'delegation.dropped.record', { to: prompt(RECIPIENT[item.to]), event: item.event, reason: prompt(DROPPED[reason]), detail }),
  });
}

/**
 * Moves the first message for each recipient one step: typed in when that
 * CLI is ready, then checked. `busy` holds the sessions already typed into
 * this round, so two delegations never type into one at once.
 */
export async function advanceOutbox(ctx: StepContext, delegation: Delegation, busy: Set<string>): Promise<void> {
  await advanceTo(ctx, delegation, 'parent', busy);
  await advanceTo(ctx, delegation, 'child', busy);
}

async function advanceTo(ctx: StepContext, delegation: Delegation, to: DelegationOutboxItem['to'], busy: Set<string>): Promise<void> {
  const item = delegation.outbox.find((candidate) => candidate.to === to);
  if (!item) return;
  const sessionId = to === 'parent' ? delegation.parentSessionId : delegation.childSessionId;
  const gone = to === 'parent' ? 'parent_gone' : 'child_gone';
  if (!sessionId) {
    drop(ctx, delegation, item, gone);
    return;
  }
  // Feedback is for a delegate still at work; the user's verdict still goes to the delegating conversation.
  if (to === 'child' && isTerminal(delegation.state) && !item.sentAt) {
    for (const queued of delegation.outbox.filter((candidate) => candidate.to === 'child')) drop(ctx, delegation, queued, 'over');
    return;
  }
  const { ports } = ctx;
  const session = await ports.readChild(sessionId);
  if (!session) {
    // Everything still queued for it goes the same way.
    for (const queued of delegation.outbox.filter((candidate) => candidate.to === to)) drop(ctx, delegation, queued, gone);
    return;
  }
  if (busy.has(sessionId)) return;

  if (item.sentAt) {
    if (since(ctx, item.sentAt) < OWN_SEND_SLACK_MS) {
      busy.add(sessionId);
      return;
    }
    const delivered = await ports.checkDelivered(sessionId, item.text, item.sentAt);
    if (delivered === 'exact' || delivered === 'unknown') {
      delegation.outbox = delegation.outbox.filter((candidate) => candidate !== item);
      return;
    }
    if (delivered === 'missing' && since(ctx, item.sentAt) <= MISSING_GIVE_UP_MS) {
      busy.add(sessionId);
      return;
    }
    if (item.attempts >= MAX_ATTEMPTS) {
      drop(ctx, delegation, item, 'not_delivered');
      return;
    }
    // Typed in again once the CLI is back at its input box.
    item.sentAt = null;
    return;
  }

  if (!parentReady(session, await ports.continuityBusy(sessionId), ctx.now)) return;
  let text: string;
  try {
    text = await message(ctx, delegation, item);
  } catch (err) {
    // Gone between the read and the write; the next step sees it.
    if (!(await ports.readChild(sessionId))) return;
    drop(ctx, delegation, item, 'report_failed', (err as Error).message);
    return;
  }
  item.text = text;
  const outcome = await ports.send(sessionId, item.text);
  // Blocked by a prompt, or not up after all: tried again on a later step.
  if (outcome.status !== 'sent') return;
  item.sentAt = ctx.now.toISOString();
  item.attempts += 1;
  busy.add(sessionId);
}

/** The file it reads, written now (so it shows where things stand), and the line pointing at it. */
async function message(ctx: StepContext, delegation: Delegation, item: DelegationOutboxItem): Promise<string> {
  if (item.to === 'child') {
    const round = item.round ?? delegation.round;
    const file = await ctx.ports.writeFeedback(delegation, round, formatFeedback(delegation, round, reportFileOf(delegation)));
    return DELEGATION_MESSAGES.feedback(delegation.id, round, file, COMMAND_NAME);
  }
  const event = item.event as DelegationParentEvent;
  const file = await ctx.ports.writeParentReport(delegation, formatParentReport(delegation, event));
  return DELEGATION_MESSAGES.parent(event, delegation.id, file);
}
