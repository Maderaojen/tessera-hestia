import type {
  Delegation, DelegationLimits, DelegationParentEvent, DelegationPreferences, DelegationReport, DelegationStatus,
} from '../contract/delegation.js';
import { isTerminal, type NotifyLevel } from './policy.js';
import type { DelegationPorts } from './ports.js';
import { t } from '../i18n/index.js';

// What every step of a delegation shares: the ports, the settings that
// apply to it, the time of this step, and how it changes the record.

export type StepContext = {
  ports: DelegationPorts;
  // What applies to this delegation: the global settings, then its
  // delegating tmux's own.
  preferences: DelegationPreferences;
  limits: DelegationLimits;
  now: Date;
  // Pushed to the user: 'key' always, 'all' only with notify 'all'.
  notify(delegation: Delegation, body: string, level?: NotifyLevel): void;
};

export function since(ctx: StepContext, iso: string | null): number {
  return iso ? ctx.now.getTime() - Date.parse(iso) : 0;
}

export function setState(
  ctx: StepContext, delegation: Delegation, state: DelegationStatus, reason: string | null = null, detail: string | null = null,
): void {
  const at = ctx.now.toISOString();
  delegation.state = state;
  delegation.stateReason = reason;
  delegation.stateDetail = detail;
  delegation.stateSince = at;
  if (isTerminal(state)) {
    delegation.endedAt = at;
    delegation.startup = null;
  }
}

export function addReport(ctx: StepContext, delegation: Delegation, report: Omit<DelegationReport, 'at'>): void {
  delegation.reports.push({ ...report, at: ctx.now.toISOString() });
}

// What the user is told when a delegation needs them, by reason.
const ATTENTION: Record<string, (ctx: StepContext) => string> = {
  idle: (ctx) => t('delegation.attention.idle', { minutes: ctx.preferences.idleAttentionMinutes }),
  cli_exited: () => t('delegation.attention.cliExited'),
  blocked: () => t('delegation.attention.blocked'),
  workspace_trust: () => t('delegation.attention.workspaceTrust'),
  startup_prompt: () => t('delegation.attention.startupPrompt'),
  brief_not_delivered: () => t('delegation.attention.briefNotDelivered'),
};

export function attentionText(ctx: StepContext, reason: string): string {
  return ATTENTION[reason]?.(ctx) ?? reason;
}

/** To needs_attention, telling the user why — once, on the way in. */
export function needAttention(ctx: StepContext, delegation: Delegation, reason: string, detail: string | null = null): void {
  const already = delegation.state === 'needs_attention' && delegation.stateReason === reason;
  setState(ctx, delegation, 'needs_attention', reason, detail);
  if (!already) ctx.notify(delegation, detail ? t('format.text.labelValue', { label: attentionText(ctx, reason), value: detail }) : attentionText(ctx, reason));
}

/** Didn't get going: stopped, with what went wrong. The worktree is kept to look at. */
export function launchFailed(ctx: StepContext, delegation: Delegation, detail: string): void {
  setState(ctx, delegation, 'stopped', 'launch_failed', detail);
  ctx.notify(delegation, t('delegation.push.launchFailed', { detail }));
}

/**
 * Something the delegating conversation is told, once its CLI is idle
 * (決策 6): queued in the outbox, kept across restarts. Nothing when no
 * session delegated it.
 */
export function toParent(ctx: StepContext, delegation: Delegation, event: DelegationParentEvent): void {
  if (!delegation.parentSessionId) return;
  delegation.outbox.push({ to: 'parent', event, text: '', createdAt: ctx.now.toISOString(), attempts: 0, sentAt: null });
}

/**
 * A send-back's feedback for the delegate, typed in once its CLI is idle
 * (the file is written then). Anything for the delegating LLM to review is
 * moot now, and dropped if it hasn't gone yet.
 */
export function toChild(ctx: StepContext, delegation: Delegation): void {
  dropUnsentReview(delegation);
  delegation.outbox.push({ to: 'child', event: 'feedback', round: delegation.round, text: '', createdAt: ctx.now.toISOString(), attempts: 0, sentAt: null });
}

/** A request to review that hasn't been typed in yet, no longer wanted (the review is over). */
export function dropUnsentReview(delegation: Delegation): void {
  delegation.outbox = delegation.outbox.filter((item) => !(item.to === 'parent' && item.event === 'review' && !item.sentAt));
}
