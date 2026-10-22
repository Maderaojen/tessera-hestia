import { COMMAND_NAME } from '../config.js';
import type { Delegation, DelegationParentEvent, DelegationReport } from '../contract/delegation.js';
import { prompt, type PromptKey } from '../i18n/index.js';
import { cut, formatUpstreamLocations, LAST_REQUEST_MAX } from '../upstream/brief.js';
import type { UpstreamView } from '../upstream/view.js';

// The delegate's brief (ADR 0015 決策 15): the task, who it is, the rules,
// how to deliver, and where the delegating conversation can be read — never
// a copy of it (ADR 0023). The CLI is only told one line pointing at it.
// Its words, and those of the other files here, are in
// i18n/prompts/delegation.json (written for the LLM, so Chinese only).

export type DelegationBriefInput = {
  delegation: Pick<Delegation, 'id' | 'title' | 'task' | 'workspace' | 'depth'>;
  parent: { tmuxName: string; profileLabel: string | null } | null;
  // The delegating session's folder has uncommitted changes (null: unknown).
  parentDirty: boolean | null;
  // The delegating conversation, read up to the turns it had when delegated
  // (`turns`); null when there is none.
  upstream: { sessionId: string; conversationId: string; turns: number; view: UpstreamView } | null;
  // Where the delegate is told to write its report.
  reportFile: string;
  // The delegate may delegate further (its depth is under the limit).
  canDelegate: boolean;
};

function quote(text: string): string {
  return text.trim().split('\n').map((line) => `> ${line}`).join('\n');
}

function delegatorLine(parent: DelegationBriefInput['parent']): string {
  if (!parent) return prompt('delegation.brief.delegatorUnknown');
  return parent.profileLabel
    ? prompt('delegation.brief.delegatorWithProfile', { tmux: parent.tmuxName, profile: parent.profileLabel })
    : prompt('delegation.brief.delegator', { tmux: parent.tmuxName });
}

export function formatDelegationBrief(input: DelegationBriefInput): string {
  const { delegation, parent } = input;
  const ws = delegation.workspace;
  const worktree = ws.isolation === 'worktree';
  const lines: string[] = [
    prompt('delegation.brief.heading', { title: delegation.title }),
    '',
    prompt('delegation.brief.intro'),
    '',
    prompt('delegation.brief.task'),
    '',
    quote(delegation.task),
    '',
    prompt('delegation.brief.whoYouAre'),
    '',
    prompt('delegation.brief.id', { id: delegation.id }),
    delegatorLine(parent),
    prompt('delegation.brief.cwd', { cwd: ws.path }),
    worktree ? prompt('delegation.brief.isolationWorktree', { worktree: ws.worktree ?? ws.path }) : prompt('delegation.brief.isolationShared'),
  ];
  if (ws.branch) lines.push(prompt('delegation.brief.branch', { branch: ws.branch }));
  if (ws.baseCommit) lines.push(prompt('delegation.brief.baseCommit', { commit: ws.baseCommit }));
  lines.push('', prompt('delegation.brief.rules'), '');
  if (worktree) {
    lines.push(prompt('delegation.brief.ruleWorktree', { branch: ws.branch ?? prompt('delegation.brief.thisBranch') }));
  } else {
    lines.push(prompt('delegation.brief.ruleShared'));
  }
  lines.push(prompt('delegation.brief.ruleNoPush'));
  lines.push(prompt('delegation.brief.ruleNoSettings'));
  if (!input.canDelegate) lines.push(prompt('delegation.brief.ruleNoDelegate'));
  if (worktree && input.parentDirty) lines.push(prompt('delegation.brief.ruleParentDirty'));
  if (worktree) lines.push(prompt('delegation.brief.ruleInstall'));
  lines.push(
    '',
    prompt('delegation.brief.howToDeliver'),
    '',
    prompt(worktree ? 'delegation.brief.deliverReportCommit' : 'delegation.brief.deliverReport', { file: input.reportFile }),
    prompt('delegation.brief.deliverDone', { command: COMMAND_NAME, file: input.reportFile }),
    prompt('delegation.brief.deliverBlocked', { command: COMMAND_NAME }),
    prompt('delegation.brief.deliverStatus', { command: COMMAND_NAME }),
    '',
    prompt('delegation.brief.acceptance'),
    '',
    prompt('delegation.brief.background'),
    '',
  );
  const upstream = input.upstream;
  if (!upstream || upstream.view.lastIndex === null) {
    lines.push(prompt('delegation.brief.noUpstream'), '');
    return lines.join('\n');
  }
  const { view } = upstream;
  lines.push(view.lastRequest?.trim()
    ? prompt('delegation.brief.lastRequest', { request: quote(cut(view.lastRequest, LAST_REQUEST_MAX)) })
    : prompt('delegation.brief.noLastRequest'));
  if (view.recapFile) lines.push('', prompt('delegation.brief.recap', { file: view.recapFile }));
  lines.push(...formatUpstreamLocations({
    command: [
      prompt('delegation.brief.showUpstream', { command: COMMAND_NAME, turns: upstream.turns }),
      prompt('delegation.brief.showExplicit', { command: COMMAND_NAME, session: upstream.sessionId, conversation: upstream.conversationId, last: view.lastIndex }),
    ].join('\n'),
    view,
  }), '');
  return lines.join('\n');
}

// --- what a continuity handoff brief adds (決策 16) ---------------------------

/**
 * For a CLI taking over a delegate's tmux from continuity: it reads only the
 * handoff brief, so this tells it that the work is a delegation, where the
 * rules are, and how to deliver it.
 */
export function formatDelegationAddendum(input: { delegation: Pick<Delegation, 'id' | 'title' | 'workspace' | 'briefFile'>; reportFile: string }): string {
  const { delegation, reportFile } = input;
  const ws = delegation.workspace;
  const worktree = ws.isolation === 'worktree';
  return [
    prompt('delegation.addendum.heading', { id: delegation.id }),
    '',
    prompt('delegation.addendum.intro', { title: delegation.title, brief: delegation.briefFile }),
    '',
    worktree
      ? prompt('delegation.addendum.ruleWorktree', { branch: ws.branch ?? prompt('delegation.addendum.currentBranch') })
      : prompt('delegation.addendum.ruleShared'),
    prompt(worktree ? 'delegation.addendum.deliverCommit' : 'delegation.addendum.deliver', { command: COMMAND_NAME, file: reportFile }),
    prompt('delegation.addendum.blocked', { command: COMMAND_NAME }),
    prompt('delegation.addendum.status', { command: COMMAND_NAME }),
  ].join('\n');
}

/**
 * For a CLI taking over a delegating tmux from continuity: the delegations
 * this tmux started that aren't over, so a result or a request to review
 * arriving later makes sense to it.
 */
export function formatDelegatorAddendum(delegations: readonly Pick<Delegation, 'id' | 'title' | 'state' | 'profileLabel' | 'workspace'>[]): string | null {
  if (!delegations.length) return null;
  const lines = [
    prompt('delegation.delegator.heading'),
    '',
    prompt('delegation.delegator.intro', { command: COMMAND_NAME }),
    '',
  ];
  for (const d of delegations) {
    const values = { id: d.id, title: d.title, profile: d.profileLabel, state: d.state, branch: d.workspace.branch };
    lines.push(prompt(d.workspace.branch ? 'delegation.delegator.itemBranch' : 'delegation.delegator.item', values));
  }
  lines.push('', prompt('delegation.delegator.commands', { command: COMMAND_NAME }));
  return lines.join('\n');
}

// --- what the delegating conversation reads (決策 6) ---------------------------

const EVENT_HEADINGS: Record<DelegationParentEvent, PromptKey> = {
  delivered: 'delegation.event.delivered',
  review: 'delegation.event.review',
  blocked: 'delegation.event.blocked',
  accepted: 'delegation.event.accepted',
  rejected: 'delegation.event.rejected',
  declined: 'delegation.event.declined',
  expired: 'delegation.event.expired',
};

const REPORT_HEADINGS: Record<DelegationReport['kind'], PromptKey> = {
  understanding: 'delegation.reportKind.understanding',
  delivery: 'delegation.reportKind.delivery',
  blocked: 'delegation.reportKind.blocked',
  review: 'delegation.reportKind.review',
  decision: 'delegation.reportKind.decision',
};

function stateLine(delegation: Delegation): string {
  if (!delegation.stateReason) return prompt('delegation.parent.state', { state: delegation.state });
  const reason = delegation.stateDetail ? prompt('delegation.parent.reasonDetail', { reason: delegation.stateReason, detail: delegation.stateDetail }) : delegation.stateReason;
  return prompt('delegation.parent.stateReason', { state: delegation.state, reason });
}

/**
 * The file the delegating conversation is pointed at: what happened, where
 * the work is, how to look at it, and what it may (not) do about it. Written
 * when the message goes in, so it shows where things stand then.
 */
export function formatParentReport(delegation: Delegation, event: DelegationParentEvent): string {
  const ws = delegation.workspace;
  const lines: string[] = [
    prompt('delegation.parent.heading', { id: delegation.id, event: prompt(EVENT_HEADINGS[event]) }),
    '',
    prompt('delegation.parent.intro', { title: delegation.title, profile: delegation.profileLabel }),
    '',
    prompt('delegation.parent.status'),
    '',
    stateLine(delegation),
    prompt('delegation.parent.cwd', { cwd: ws.path }),
  ];
  if (ws.branch) lines.push(prompt('delegation.parent.branch', { branch: ws.branch, base: ws.baseCommit ?? '?' }));
  if (ws.headAtDelivery) lines.push(prompt('delegation.parent.deliveredCommit', { commit: ws.headAtDelivery }));
  if (ws.isolation === 'worktree' && ws.worktree && ws.baseCommit && ws.branch) {
    lines.push(prompt('delegation.parent.diff', { worktree: ws.worktree, base: ws.baseCommit, branch: ws.branch }));
  }
  const latest = [...delegation.reports].reverse().find((report) => report.kind === 'delivery' || report.kind === 'blocked');
  if (latest && (event === 'delivered' || event === 'review' || event === 'blocked')) {
    lines.push('', `## ${prompt(REPORT_HEADINGS[latest.kind])}`, '', latest.text.trim());
  }
  if (event === 'review') {
    lines.push(
      '',
      prompt('delegation.parent.reviewHeading'),
      '',
      prompt('delegation.parent.reviewIntro', { round: delegation.round }),
      '',
      prompt('delegation.parent.reviewPass', { command: COMMAND_NAME, id: delegation.id }),
      prompt('delegation.parent.reviewSendBack', { command: COMMAND_NAME, id: delegation.id }),
      prompt('delegation.parent.reviewLimit'),
    );
  }
  lines.push(
    '',
    prompt('delegation.parent.canDo'),
    '',
    prompt('delegation.parent.onlyUserAccepts'),
    prompt('delegation.parent.commands', { command: COMMAND_NAME, id: delegation.id }),
  );
  if (event === 'blocked') lines.push(prompt('delegation.parent.blocked'));
  if (event === 'accepted' && ws.branch) lines.push(prompt('delegation.parent.accepted', { branch: ws.branch }));
  lines.push('');
  return lines.join('\n');
}

// --- what the delegate reads when sent back (決策 5) ---------------------------

/** The feedback of a send-back: who sent it back, what they said, and how to deliver again. */
export function formatFeedback(delegation: Delegation, round: number, reportFile: string): string {
  const review = [...delegation.reports].reverse().find((report) => report.kind === 'review' && report.verdict === 'send_back');
  const who = prompt(review?.by === 'user' ? 'delegation.feedback.byUser' : 'delegation.feedback.byParent');
  const worktree = delegation.workspace.isolation === 'worktree';
  return [
    prompt('delegation.feedback.heading', { id: delegation.id, round }),
    '',
    prompt('delegation.feedback.intro', { who, title: delegation.title }),
    '',
    prompt('delegation.feedback.comments'),
    '',
    review?.text.trim() || prompt('delegation.feedback.noComments'),
    '',
    prompt('delegation.feedback.next'),
    '',
    prompt(worktree ? 'delegation.feedback.fixCommit' : 'delegation.feedback.fix'),
    prompt('delegation.feedback.report', { command: COMMAND_NAME, file: reportFile }),
    prompt('delegation.feedback.blocked', { command: COMMAND_NAME }),
    '',
    prompt('delegation.feedback.brief', { brief: delegation.briefFile }),
    '',
  ].join('\n');
}
