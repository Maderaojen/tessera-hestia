import { COMMAND_NAME } from '../config.js';
import { change } from '../continuity/brief.js';
import type { Fork } from '../contract/fork.js';
import type { RepoFileChange } from '../contract/repo.js';
import { prompt } from '../i18n/index.js';
import { cut, formatUpstreamLocations, LAST_REQUEST_MAX } from '../upstream/brief.js';
import type { UpstreamLocations } from '../upstream/view.js';

// A branch line's brief (ADR 0023 決策 3):
// what it is, where it came from, where it works now, and — without the
// CLI's own fork — where the upstream conversation can be read. Never the
// conversation itself: the one quote is the last request, cut short.
// Its words are in i18n/prompts/fork.json (written for the LLM, so Chinese only).

// The last request is quoted up to this many characters.
export { LAST_REQUEST_MAX };

export type ForkBriefInput = {
  fork: Pick<Fork, 'id' | 'title' | 'createdAt' | 'origin' | 'memory' | 'instruction' | 'workspace' | 'profileLabel'>;
  parent: { cwd: string; profileLabel: string | null };
  // The main line's uncommitted files; null when unknown or not in git.
  parentDirty: RepoFileChange[] | null;
  // Only for a brief-mode branch line.
  upstream: UpstreamLocations | null;
};

function quote(text: string): string {
  return text.trim().split('\n').map((line) => `> ${line}`).join('\n');
}

export function formatForkBrief(input: ForkBriefInput): string {
  const { fork, parent } = input;
  const ws = fork.workspace;
  const worktree = ws.isolation === 'worktree';
  const native = fork.memory === 'native';
  const lines: string[] = [
    prompt('fork.brief.heading', { title: fork.title }),
    '',
    prompt('fork.brief.intro'),
    '',
    prompt(native ? 'fork.brief.memoryNative' : 'fork.brief.memoryBrief'),
    '',
    prompt('fork.brief.mainLine'),
    '',
    parent.profileLabel
      ? prompt('fork.brief.tmuxWithProfile', { tmux: fork.origin.tmuxName, profile: parent.profileLabel })
      : prompt('fork.brief.tmux', { tmux: fork.origin.tmuxName }),
    prompt('fork.brief.conversationId', { id: fork.origin.conversationId }),
    prompt('fork.brief.forkedAt', { at: fork.createdAt, turns: fork.origin.turnsAtFork }),
    '',
    prompt('fork.brief.workspace'),
    '',
  ];
  if (worktree) {
    lines.push(
      prompt('fork.brief.worktree', { worktree: ws.worktree ?? ws.path }),
      prompt('fork.brief.cwd', { cwd: ws.path }),
      prompt('fork.brief.branch', { branch: ws.branch ?? prompt('fork.brief.unknown') }),
    );
    if (ws.baseCommit) lines.push(prompt('fork.brief.baseCommit', { commit: ws.baseCommit }));
    lines.push(
      '',
      prompt(native ? 'fork.brief.pathsNative' : 'fork.brief.pathsBrief', { parent: parent.cwd, path: ws.path }),
      prompt('fork.brief.install'),
    );
  } else {
    lines.push(
      prompt('fork.brief.cwdShared', { cwd: ws.path }),
      '',
      prompt('fork.brief.sharedWarning'),
    );
  }
  if (worktree && input.parentDirty?.length) {
    lines.push('', prompt('fork.brief.parentDirty'), '', ...input.parentDirty.map(change));
  }
  lines.push(
    '',
    prompt('fork.brief.rules'),
    '',
    worktree ? prompt('fork.brief.ruleWorktree', { branch: ws.branch ?? prompt('fork.brief.thisBranch') }) : prompt('fork.brief.ruleShared'),
    prompt('fork.brief.ruleNoPush'),
    prompt('fork.brief.ruleNoSettings'),
  );
  if (!native && input.upstream) lines.push(...upstreamSection(input.upstream));
  lines.push('', prompt('fork.brief.instruction'), '');
  lines.push(fork.instruction?.trim() ? quote(fork.instruction) : prompt('fork.brief.noInstruction'));
  lines.push('');
  return lines.join('\n');
}

function upstreamSection(upstream: UpstreamLocations): string[] {
  const lines = ['', prompt('fork.upstream.heading'), ''];
  lines.push(upstream.lastRequest?.trim()
    ? prompt('fork.upstream.lastRequest', { request: quote(cut(upstream.lastRequest, LAST_REQUEST_MAX)) })
    : prompt('fork.upstream.noLastRequest'));
  if (upstream.recapFile) lines.push('', prompt('fork.upstream.recap', { file: upstream.recapFile }));
  lines.push(...formatUpstreamLocations({
    command: prompt('fork.upstream.show', { command: COMMAND_NAME }),
    view: upstream,
  }));
  return lines;
}

/**
 * What a continuity handoff brief adds when it hands a branch line's tmux
 * to another profile: the CLI taking over is a branch line too.
 */
export function formatForkAddendum(fork: Pick<Fork, 'id' | 'title' | 'origin' | 'briefFile'>): string {
  return [
    prompt('fork.addendum.heading'),
    '',
    prompt('fork.addendum.intro', { tmux: fork.origin.tmuxName, conversation: fork.origin.conversationId, turns: fork.origin.turnsAtFork, title: fork.title }),
    prompt('fork.addendum.brief', { brief: fork.briefFile }),
    prompt('fork.addendum.upstream', { command: COMMAND_NAME }),
  ].join('\n');
}
