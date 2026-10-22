import type { ContinuityHandoff } from '../contract/continuity.js';
import type { RepoBranchState, RepoCommitSummary, RepoFileChange } from '../contract/repo.js';
import type { Turn } from '../contract/sessions.js';
import { prompt, type PromptKey } from '../i18n/index.js';
import { cut, formatUpstreamLocations, LAST_REQUEST_MAX } from '../upstream/brief.js';
import type { UpstreamView } from '../upstream/view.js';

// The app's own part of a handoff brief: what it knows without asking any
// LLM. Where things stand and where to pick up, quoted short, and where
// the conversation can be read for anything the brief doesn't say — never
// a copy of it (ADR 0023: `hestia conversation show` prints it when
// asked). It is the whole brief when the CLI being left couldn't write
// one, and follows its own otherwise. Its words are in
// i18n/prompts/handoff.json (written for the LLM, so Chinese only).

// The last reply is quoted from its end (where it stopped), this much of it.
export const LAST_REPLY_MAX = 2000;
const MAX_FILES = 60;
const MAX_COMMITS = 20;

export type LastTurnState = 'complete' | 'interrupted' | 'limit_hit' | 'none';

export type BriefInput = {
  handoff: Pick<ContinuityHandoff, 'trigger' | 'toLabel' | 'briefSource' | 'briefNote'>;
  fromLabel: string | null;
  cwd: string;
  now: Date;
  turns: readonly Turn[];
  lastTurn: LastTurnState;
  // The conversation being left, and where it can be read.
  upstream: { sessionId: string; conversationId: string; view: UpstreamView };
  git: null | {
    branch: RepoBranchState;
    files: readonly RepoFileChange[];
    unpushed: readonly RepoCommitSummary[];
  };
};

const TRIGGERS: Record<ContinuityHandoff['trigger'], PromptKey> = {
  soft: 'handoff.trigger.soft',
  hard: 'handoff.trigger.hard',
  limit_hit: 'handoff.trigger.limitHit',
  manual: 'handoff.trigger.manual',
};

const LAST_TURN: Record<LastTurnState, PromptKey> = {
  complete: 'handoff.lastTurn.complete',
  interrupted: 'handoff.lastTurn.interrupted',
  limit_hit: 'handoff.lastTurn.limitHit',
  none: 'handoff.lastTurn.none',
};

function quoteLines(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

/** One uncommitted file as a brief lists it (a branch line's brief too). */
export function change(file: RepoFileChange): string {
  const kinds = [file.staged && `staged ${file.staged}`, file.unstaged && file.unstaged].filter(Boolean).join(', ');
  return prompt('handoff.brief.changedFile', { file: `${file.origPath ? `${file.origPath} → ` : ''}${file.path}`, kinds });
}

function selfBriefLine(handoff: BriefInput['handoff']): string {
  if (handoff.briefSource === 'self') return prompt('handoff.brief.selfBriefYes');
  if (handoff.briefSource === 'incoming') return prompt('handoff.brief.selfBriefIncoming');
  return handoff.briefNote ? prompt('handoff.brief.selfBriefNoBecause', { note: handoff.briefNote }) : prompt('handoff.brief.selfBriefNo');
}

/** The brief: where things stand, where to pick up, and where to look for more. */
export function formatMechanicalBrief(input: BriefInput): string {
  const { handoff, turns, upstream } = input;
  const show = `hestia conversation show --session ${upstream.sessionId} --conversation ${upstream.conversationId}`;
  // What a cut quote says, pointing at the turn it came from.
  const omitted = (turn: Turn) => prompt('handoff.brief.omitted', { show, turn: turn.index });
  const request = (turn: Turn, text: string) => quoteLines(cut(text, LAST_REQUEST_MAX, omitted(turn)));
  const first = turns[0];
  const last = turns.at(-1);
  const lines: string[] = [
    prompt('handoff.brief.heading'),
    '',
    prompt('handoff.brief.intro'),
    '',
    prompt('handoff.brief.status'),
    '',
    prompt('handoff.brief.reason', { reason: prompt(TRIGGERS[handoff.trigger]) }),
    prompt('handoff.brief.fromTo', { from: input.fromLabel ?? prompt('handoff.brief.unknown'), to: handoff.toLabel }),
    prompt('handoff.brief.time', { time: input.now.toISOString() }),
    prompt('handoff.brief.cwd', { cwd: input.cwd }),
    prompt('handoff.brief.turns', { count: turns.length, lastTurn: prompt(LAST_TURN[input.lastTurn]) }),
    selfBriefLine(handoff),
    prompt('handoff.brief.fullRecord'),
  ];
  if (upstream.view.recapFile) lines.push(prompt('handoff.brief.recap', { file: upstream.view.recapFile }));
  lines.push('');
  if (first) lines.push(prompt('handoff.brief.taskSource'), '', request(first, first.user.text), '');
  if (last) {
    lines.push(prompt('handoff.brief.pickUp'), '', prompt('handoff.brief.lastRequest', { turn: last.index }), '', request(last, last.user.text), '');
    for (const followUp of last.followUps ?? []) lines.push(prompt('handoff.brief.followUp'), '', request(last, followUp.text), '');
    lines.push(prompt('handoff.brief.checkFirst'), '');
    const interrupted = last.assistant.interrupted || input.lastTurn === 'interrupted';
    lines.push(prompt(interrupted ? 'handoff.brief.lastReplyInterrupted' : 'handoff.brief.lastReply', { turn: last.index }), '');
    const reply = last.assistant.text.trim();
    if (!reply) {
      lines.push(prompt('handoff.brief.noText'));
    } else if (reply.length > LAST_REPLY_MAX) {
      // Where it stopped is at the end: keep that, and say what was left out.
      lines.push(prompt('handoff.brief.replyTail', { max: LAST_REPLY_MAX, show, turn: last.index }), '', quoteLines(`…${reply.slice(-LAST_REPLY_MAX)}`));
    } else {
      lines.push(quoteLines(reply));
    }
    lines.push('');
  }
  lines.push(prompt('handoff.git.heading'), '');
  if (!input.git) {
    lines.push(prompt('handoff.git.none'));
  } else {
    const { branch, files, unpushed } = input.git;
    const where = branch.detached ? `detached HEAD ${branch.oid?.slice(0, 8) ?? ''}` : branch.head ?? prompt('handoff.git.noCommit');
    lines.push(branch.upstream
      ? prompt('handoff.git.branchUpstream', { where, upstream: branch.upstream, ahead: branch.ahead ?? '?', behind: branch.behind ?? '?' })
      : prompt('handoff.git.branch', { where }));
    lines.push('', prompt('handoff.git.uncommitted', { count: files.length }), '');
    if (files.length === 0) lines.push(prompt('handoff.git.nothing'));
    for (const file of files.slice(0, MAX_FILES)) lines.push(change(file));
    if (files.length > MAX_FILES) lines.push(prompt('handoff.git.moreFiles', { count: files.length - MAX_FILES }));
    lines.push('', prompt('handoff.git.unpushed', { count: unpushed.length }), '');
    if (unpushed.length === 0) lines.push(prompt('handoff.git.nothing'));
    for (const commit of unpushed.slice(0, MAX_COMMITS)) lines.push(`- \`${commit.sha.slice(0, 8)}\` ${commit.subject}`);
  }
  lines.push(...formatUpstreamLocations({
    command: prompt('handoff.brief.showCommand', { show }),
    view: upstream.view,
  }));
  lines.push('');
  return lines.join('\n');
}

function turnBlock(turn: Turn): string[] {
  const quote = (text: string) => quoteLines(text.trim());
  const lines = [prompt('transcript.turn.user', { turn: turn.index }), '', quote(turn.user.text), ''];
  for (const followUp of turn.followUps ?? []) lines.push(prompt('transcript.turn.followUp'), '', quote(followUp.text), '');
  lines.push(prompt(turn.assistant.interrupted ? 'transcript.turn.replyInterrupted' : 'transcript.turn.reply', { turn: turn.index }), '');
  lines.push(turn.assistant.text.trim() ? quote(turn.assistant.text) : prompt('transcript.turn.noText'), '');
  return lines;
}

/** The whole recorded conversation, every turn in full, oldest first (`hestia conversation show`). */
export function formatConversationExport(input: Pick<BriefInput, 'fromLabel' | 'cwd' | 'now' | 'turns'>): string {
  const lines = [
    prompt('transcript.export.heading'),
    '',
    prompt('transcript.export.cli', { cli: input.fromLabel ?? prompt('transcript.export.unknown') }),
    prompt('transcript.export.cwd', { cwd: input.cwd }),
    prompt('transcript.export.exportedAt', { time: input.now.toISOString() }),
    prompt('transcript.export.turns', { count: input.turns.length }),
    '',
  ];
  for (const turn of input.turns) lines.push(...turnBlock(turn));
  return lines.join('\n');
}
