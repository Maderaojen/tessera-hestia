// `hestia delegate …`: delegating work from a tmux, and delivering it
// (ADR 0015 決策 14).
//
//   hestia delegate start (--task <text> | --task-file <file>) [--profile <id>] [--title <t>] [--worktree]
//   hestia delegate stop <id>
//   hestia delegate done (--report <text> | --report-file <file>) [--blocked]
//   hestia delegate review <id> (--pass | --send-back) [--feedback <text> | --feedback-file <file>]
//   hestia delegate status [<id>]
//
// Run by the LLM in a tmux the app manages, which it is found by (its tmux
// name). `start`, `review` and `stop` are the delegating LLM's; `done` the
// delegate's, whose delegation comes from HESTIA_DELEGATION_ID, set on its
// tmux when it was made — without it, from the delegation whose delegate
// is this tmux.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Delegation, DelegationListResponse, DelegationResponse, ReviewDelegationRequest, StartDelegationRequest } from '../contract/delegation.js';
import { t } from '../i18n/index.js';

export type DelegateDeps = {
  api<T>(route: string, init?: { method?: string; body?: unknown }): Promise<T>;
  fail(message: string): never;
  env: NodeJS.ProcessEnv;
  // The name of the tmux session this runs in, or null outside tmux.
  tmuxName(): string | null;
  readFile(file: string): Promise<string>;
  log(line: string): void;
};

export const DELEGATE_USAGE = [
  'usage: hestia delegate start (--task <text> | --task-file <file>) [--profile <id>] [--title <t>] [--worktree]',
  '       hestia delegate stop <id>',
  '       hestia delegate done (--report <text> | --report-file <file>) [--blocked]',
  '       hestia delegate review <id> (--pass | --send-back) [--feedback <text> | --feedback-file <file>]',
  '       hestia delegate status [<id>]',
].join('\n');

const NOT_MANAGED = 'not in a tmux the Hestia app manages; run this inside the tmux of the conversation that delegates';

const TERMINAL = new Set(['accepted', 'rejected', 'stopped']);

export type DoneArgs = { report: { text: string } | { file: string }; blocked: boolean };

/** `done`'s options, or a message saying what is wrong with them. */
export function parseDoneArgs(args: string[]): DoneArgs | string {
  let text: string | null = null;
  let file: string | null = null;
  let blocked = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--report') {
      const value = args[++i];
      if (value === undefined) return '--report needs the report text';
      text = value;
    } else if (arg === '--report-file') {
      const value = args[++i];
      if (value === undefined) return '--report-file needs a file';
      file = value;
    } else if (arg === '--blocked') {
      blocked = true;
    } else {
      return `unknown option ${arg}`;
    }
  }
  if ((text === null) === (file === null)) return 'give the report with exactly one of --report or --report-file';
  return { report: text !== null ? { text } : { file: file! }, blocked };
}

export type ReviewArgs = { id: string; verdict: 'pass' | 'send_back'; feedback: { text: string } | { file: string } | null };

/** `review`'s arguments, or a message saying what is wrong with them. */
export function parseReviewArgs(args: string[]): ReviewArgs | string {
  let id: string | null = null;
  let verdict: ReviewArgs['verdict'] | null = null;
  let text: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--pass' || arg === '--send-back') {
      const next = arg === '--pass' ? 'pass' : 'send_back';
      if (verdict && verdict !== next) return 'give exactly one of --pass or --send-back';
      verdict = next;
    } else if (arg === '--feedback' || arg === '--feedback-file') {
      const value = args[++i];
      if (value === undefined) return `${arg} needs a value`;
      if (arg === '--feedback') text = value;
      else file = value;
    } else if (arg.startsWith('-')) {
      return `unknown option ${arg}`;
    } else if (id) {
      return `unexpected ${arg}`;
    } else {
      id = arg;
    }
  }
  if (!id) return 'give the delegation id';
  if (!verdict) return 'give exactly one of --pass or --send-back';
  if (text !== null && file !== null) return 'give the feedback with at most one of --feedback or --feedback-file';
  if (verdict === 'send_back' && text === null && file === null) return '--send-back needs --feedback or --feedback-file (what to change)';
  return { id, verdict, feedback: text !== null ? { text } : file !== null ? { file } : null };
}

export type StartArgs = { task: { text: string } | { file: string }; profileId?: string; title?: string; worktree: boolean };

/** `start`'s options, or a message saying what is wrong with them. */
export function parseStartArgs(args: string[]): StartArgs | string {
  let text: string | null = null;
  let file: string | null = null;
  let profileId: string | undefined;
  let title: string | undefined;
  let worktree = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => args[++i];
    if (arg === '--task' || arg === '--task-file' || arg === '--profile' || arg === '--title') {
      const given = value();
      if (given === undefined) return `${arg} needs a value`;
      if (arg === '--task') text = given;
      else if (arg === '--task-file') file = given;
      else if (arg === '--profile') profileId = given;
      else title = given;
    } else if (arg === '--worktree') {
      worktree = true;
    } else {
      return `unknown option ${arg}`;
    }
  }
  if ((text === null) === (file === null)) return 'give the task with exactly one of --task or --task-file';
  return { task: text !== null ? { text } : { file: file! }, ...(profileId ? { profileId } : {}), ...(title ? { title } : {}), worktree };
}

export function defaultTmuxName(env: NodeJS.ProcessEnv): string | null {
  if (!env.TMUX) return null;
  const result = spawnSync('tmux', ['display-message', '-p', '#{session_name}'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

async function ownSessionId(deps: DelegateDeps): Promise<string | null> {
  const name = deps.tmuxName();
  if (!name) return null;
  const sessions = await deps.api<{ id: string; tmuxName: string }[]>('/sessions');
  return sessions.find((session) => session.tmuxName === name)?.id ?? null;
}

export function formatDelegation(delegation: Delegation, ownSessionId: string | null = null): string {
  const reason = delegation.stateReason
    ? t('format.text.parenSuffix', { text: delegation.stateDetail ? t('format.text.labelValue', { label: delegation.stateReason, value: delegation.stateDetail }) : delegation.stateReason })
    : '';
  const role = !ownSessionId ? ''
    : delegation.childSessionId === ownSessionId ? `  ${t('cli.delegate.roleDelegate')}`
      : delegation.parentSessionId === ownSessionId ? `  ${t('cli.delegate.roleDelegator')}` : '';
  const lines = [
    `${delegation.id}  ${delegation.state}${reason}  ${delegation.title}${role}`,
    `  ${t(delegation.initiator === 'llm' ? 'cli.delegate.toByLlm' : 'cli.delegate.toByUser', { profile: delegation.profileLabel, depth: delegation.depth })}`,
    `  ${t('cli.delegate.cwd', { path: delegation.workspace.path })}`,
  ];
  if (delegation.workspace.branch) lines.push(`  ${t('cli.delegate.branchBase', { branch: delegation.workspace.branch, base: delegation.workspace.baseCommit?.slice(0, 8) ?? '?' })}`);
  lines.push(`  ${t('cli.delegate.brief', { file: delegation.briefFile })}`);
  return lines.join('\n');
}

async function start(args: string[], deps: DelegateDeps): Promise<void> {
  const parsed = parseStartArgs(args);
  if (typeof parsed === 'string') deps.fail(`${parsed}\n${DELEGATE_USAGE}`);
  const task = 'text' in parsed.task
    ? parsed.task.text
    : await deps.readFile(parsed.task.file).catch(() => deps.fail(`can't read ${(parsed.task as { file: string }).file}`));
  if (!task.trim()) deps.fail('the task is empty');
  const sessionId = await ownSessionId(deps);
  if (!sessionId) deps.fail(NOT_MANAGED);
  const body: StartDelegationRequest = {
    parentSessionId: sessionId,
    task,
    ...(parsed.profileId ? { profileId: parsed.profileId } : {}),
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.worktree ? { isolation: 'worktree' as const } : {}),
  };
  const { delegation } = await deps.api<DelegationResponse>('/delegations', { method: 'POST', body });
  deps.log(`${delegation.id} ${delegation.state}`);
  deps.log(delegation.state === 'proposed'
    ? t('cli.delegate.proposed', { profile: delegation.profileLabel, id: delegation.id })
    : t('cli.delegate.started', { profile: delegation.profileLabel, id: delegation.id }));
}

async function stop(args: string[], deps: DelegateDeps): Promise<void> {
  const [id, ...rest] = args;
  if (!id || rest.length || id.startsWith('-')) deps.fail(DELEGATE_USAGE);
  const sessionId = await ownSessionId(deps);
  if (!sessionId) deps.fail(NOT_MANAGED);
  const { delegation } = await deps.api<DelegationResponse>(`/delegations/${encodeURIComponent(id)}/stop`, {
    method: 'POST', body: { fromSessionId: sessionId },
  });
  deps.log(t('cli.delegate.stopped', { id: delegation.id, state: delegation.state }));
}

async function done(args: string[], deps: DelegateDeps): Promise<void> {
  const parsed = parseDoneArgs(args);
  if (typeof parsed === 'string') deps.fail(`${parsed}\n${DELEGATE_USAGE}`);
  const report = 'text' in parsed.report
    ? parsed.report.text
    : await deps.readFile(parsed.report.file).catch(() => deps.fail(`can't read ${(parsed.report as { file: string }).file}`));
  if (!report.trim()) deps.fail('the report is empty');
  const sessionId = await ownSessionId(deps);
  if (!sessionId) deps.fail('not in a tmux the Hestia app manages; run this inside the delegate\'s own tmux');
  let id = deps.env.HESTIA_DELEGATION_ID?.trim() || null;
  if (!id) {
    const { delegations } = await deps.api<DelegationListResponse>(`/delegations?session=${encodeURIComponent(sessionId)}`);
    id = delegations.find((candidate) => candidate.childSessionId === sessionId && !TERMINAL.has(candidate.state))?.id ?? null;
    if (!id) deps.fail('this tmux is not working on any delegation');
  }
  const { delegation } = await deps.api<DelegationResponse>(`/delegations/${encodeURIComponent(id)}/deliver`, {
    method: 'POST', body: { fromSessionId: sessionId, report, blocked: parsed.blocked },
  });
  const branch = t('cli.delegate.branch', { branch: delegation.workspace.branch ?? t('cli.delegate.sharedFolder') });
  deps.log(parsed.blocked ? t('cli.delegate.blocked', { id: delegation.id })
    : delegation.state === 'reviewing' ? `${t('cli.delegate.deliveredForReview', { id: delegation.id })}${branch}`
      : `${t('cli.delegate.delivered', { id: delegation.id })}${branch}`);
}

async function review(args: string[], deps: DelegateDeps): Promise<void> {
  const parsed = parseReviewArgs(args);
  if (typeof parsed === 'string') deps.fail(`${parsed}\n${DELEGATE_USAGE}`);
  const feedback = !parsed.feedback ? undefined
    : 'text' in parsed.feedback ? parsed.feedback.text
      : await deps.readFile(parsed.feedback.file).catch(() => deps.fail(`can't read ${(parsed.feedback as { file: string }).file}`));
  if (parsed.verdict === 'send_back' && !feedback?.trim()) deps.fail('the feedback is empty');
  const sessionId = await ownSessionId(deps);
  if (!sessionId) deps.fail(NOT_MANAGED);
  const body: ReviewDelegationRequest = { fromSessionId: sessionId, verdict: parsed.verdict, ...(feedback?.trim() ? { feedback } : {}) };
  const { delegation } = await deps.api<DelegationResponse>(`/delegations/${encodeURIComponent(parsed.id)}/review`, { method: 'POST', body });
  if (delegation.state === 'working') {
    deps.log(t('cli.delegate.sentBack', { id: delegation.id, round: delegation.round }));
  } else if (delegation.stateReason === 'review_rounds') {
    deps.log(t('cli.delegate.roundsUsed', { id: delegation.id }));
  } else {
    deps.log(`${t('cli.delegate.passed', { id: delegation.id })}${t('cli.delegate.branch', { branch: delegation.workspace.branch ?? t('cli.delegate.sharedFolder') })}`);
  }
}

async function status(args: string[], deps: DelegateDeps): Promise<void> {
  const [id, ...rest] = args;
  if (rest.length || id?.startsWith('-')) deps.fail(DELEGATE_USAGE);
  if (id) {
    const { delegation } = await deps.api<DelegationResponse>(`/delegations/${encodeURIComponent(id)}`);
    deps.log(formatDelegation(delegation));
    return;
  }
  const sessionId = await ownSessionId(deps);
  if (!sessionId) deps.fail('not in a tmux the Hestia app manages; give a delegation id');
  const { delegations } = await deps.api<DelegationListResponse>(`/delegations?session=${encodeURIComponent(sessionId)}`);
  if (!delegations.length) {
    deps.log(t('cli.delegate.none'));
    return;
  }
  // Its own delegation first (when it is a delegate), then the ones it started.
  const own = delegations.filter((d) => d.childSessionId === sessionId);
  const started = delegations.filter((d) => d.childSessionId !== sessionId);
  deps.log([...own, ...started].map((d) => formatDelegation(d, sessionId)).join('\n\n'));
}

export async function delegateCommand(args: string[], deps: DelegateDeps): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'start') await start(rest, deps);
  else if (sub === 'stop') await stop(rest, deps);
  else if (sub === 'done') await done(rest, deps);
  else if (sub === 'review') await review(rest, deps);
  else if (sub === 'status') await status(rest, deps);
  else deps.fail(DELEGATE_USAGE);
}

export const fileReader = (file: string) => readFile(file, 'utf8');
