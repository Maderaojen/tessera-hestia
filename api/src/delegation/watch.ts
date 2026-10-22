import { formatWakeTime } from '../continuity/engine.js';
import type { Delegation } from '../contract/delegation.js';
import { prompt, t } from '../i18n/index.js';
import { checkWorking, resumedWork, reviewEnds } from './policy.js';
import type { ChildView } from './ports.js';
import { addReport, dropUnsentReview, needAttention, setState, since, type StepContext } from './record.js';
import { toWorking } from './startup.js';

// A delegation past its start: whether its delegate is still at work, has
// gone quiet, or is back at work after asking for help; and whether the
// delegating LLM can still review it (ADR 0015 決策 13).

// While the delegate replies, its last activity is written down at most
// this often (each write rewrites delegation.json).
const ACTIVITY_WRITE_MS = 60_000;
// The understanding report is kept to this many characters.
const MAX_UNDERSTANDING = 4000;

export async function watchDelegation(ctx: StepContext, delegation: Delegation): Promise<void> {
  if (!delegation.childSessionId) return;
  const child = await ctx.ports.readChild(delegation.childSessionId);
  if (!child) {
    setState(ctx, delegation, 'stopped', 'child_gone');
    return;
  }
  if (delegation.state === 'reviewing') {
    await reviewing(ctx, delegation);
    return;
  }
  if (delegation.state !== 'working' && delegation.state !== 'needs_attention') return;
  noteProfile(ctx, delegation, child);
  if (child.phase === 'replying' && (!delegation.lastActivityAt || since(ctx, delegation.lastActivityAt) > ACTIVITY_WRITE_MS)) {
    delegation.lastActivityAt = ctx.now.toISOString();
  }
  if (delegation.state === 'working') await working(ctx, delegation, child);
  else attention(ctx, delegation, child);
}

async function working(ctx: StepContext, delegation: Delegation, child: ChildView): Promise<void> {
  await recordUnderstanding(ctx, delegation);
  const check = checkWorking({
    child,
    lastActivityAt: delegation.lastActivityAt,
    continuityBusy: await ctx.ports.continuityBusy(delegation.childSessionId!),
    idleAttentionMinutes: ctx.preferences.idleAttentionMinutes,
    now: ctx.now,
  });
  if (check !== 'none') needAttention(ctx, delegation, check);
}

function attention(ctx: StepContext, delegation: Delegation, child: ChildView): void {
  const startup = delegation.startup;
  // Stopped on a start-up screen before the brief went in: once the user
  // has dealt with it, the start picks up again.
  if (startup && !startup.sentAt && child.running && !child.switching && child.phase === 'idle' && !child.startupPrompt && !child.interaction) {
    startup.stageSince = ctx.now.toISOString();
    setState(ctx, delegation, 'starting');
    return;
  }
  if (!resumedWork(child, delegation.stateSince)) return;
  if (startup) toWorking(ctx, delegation, startup.sentAt);
  else setState(ctx, delegation, 'working');
  delegation.lastActivityAt = ctx.now.toISOString();
}

// Waiting on the delegating LLM's review: once its session is gone, or
// has moved on to other work, nobody will review it — it goes to the user.
async function reviewing(ctx: StepContext, delegation: Delegation): Promise<void> {
  const parentId = delegation.parentSessionId;
  const parentAlive = !!parentId && !!(await ctx.ports.readChild(parentId));
  const sameWork = parentAlive ? await ctx.ports.sameWork(parentId!, delegation.parentConversationId) : false;
  const ended = reviewEnds({ parentAlive, sameWork });
  if (!ended) {
    await heldByLimit(ctx, delegation, parentId!);
    return;
  }
  dropUnsentReview(delegation);
  addReport(ctx, delegation, {
    kind: 'decision', by: 'system',
    text: prompt(ended === 'parent_gone' ? 'delegation.record.parentGoneNoReview' : 'delegation.record.parentMovedNoReview'),
  });
  setState(ctx, delegation, 'delivered', ended);
  ctx.notify(delegation, t(ended === 'parent_gone' ? 'delegation.push.deliveredParentGone' : 'delegation.push.deliveredParentMoved'));
}

// The delegating conversation hit its usage limit and continuity waits for
// the reset before it carries on: the review waits as long. The user is
// told once per review, so they can decide themselves meanwhile.
async function heldByLimit(ctx: StepContext, delegation: Delegation, parentId: string): Promise<void> {
  if (delegation.parentHeldNoticeAt && delegation.parentHeldNoticeAt >= delegation.stateSince) return;
  const until = await ctx.ports.limitWaitUntil(parentId);
  if (!until) return;
  delegation.parentHeldNoticeAt = ctx.now.toISOString();
  ctx.notify(delegation, t('delegation.push.parentHeldByLimit', { time: formatWakeTime(until, ctx.now) }));
}

// The delegate's first reply, to the instruction to read the brief: what it
// understood. Not waited on — it carries on right after (決策 15).
async function recordUnderstanding(ctx: StepContext, delegation: Delegation): Promise<void> {
  if (!delegation.briefSentAt || delegation.reports.some((report) => report.kind === 'understanding')) return;
  const reply = await ctx.ports.firstReplyAfter(delegation.childSessionId!, delegation.briefSentAt);
  if (!reply?.trim()) return;
  const text = reply.trim();
  addReport(ctx, delegation, {
    kind: 'understanding', by: 'child',
    text: text.length > MAX_UNDERSTANDING ? `${text.slice(0, MAX_UNDERSTANDING)}…` : text,
  });
  const line = text.split('\n').find((candidate) => candidate.trim())?.trim() ?? '';
  ctx.notify(delegation, t('delegation.push.understanding', { line: line.length > 120 ? `${line.slice(0, 120)}…` : line }), 'all');
}

// Continuity handed the delegate to another profile in the same tmux (ADR
// 0015 決策 16): written down, read only — HESTIA_DELEGATION_ID is on the
// tmux, so the delegation carries on.
function noteProfile(ctx: StepContext, delegation: Delegation, child: ChildView): void {
  if (!child.profileId || child.switching) return;
  if (delegation.profileHistory.at(-1)?.profileId === child.profileId) return;
  delegation.profileHistory.push({ profileId: child.profileId, at: ctx.now.toISOString() });
}
