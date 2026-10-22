// Branch lines: another conversation started from this one's memory, in a
// worktree and a tmux of its own, going its own way — nothing to report
// back, nothing to deliver. Only the user starts one. Needs the `fork` capability
// (meta.ts).

import type { PermissionMode } from './permissions.js';
import type { SpawnStartup, SpawnWorkspace } from './workspace.js';
import { typedText } from './typed.js';

/**
 * How the branch line carries the memory: 'native', the CLI's own fork of
 * the conversation (same profile, a runtime that forks); 'brief', a short
 * brief saying where the upstream conversation is, to read when needed.
 */
export type ForkMemory = 'native' | 'brief';

/** Why it is a brief: another profile, a CLI with no fork, or a conversation that can't be forked. */
export type ForkMemoryReason = 'other_profile' | 'runtime_unsupported' | 'conversation_unforkable';

/**
 * Where a branch line is, from its fields (forkStatus): 'starting' until
 * the brief is in, 'failed' when its start gave up, 'closed' once the user
 * closed it (or its session was removed), 'open' otherwise. No flow beyond
 * that: no delivery, no review.
 */
export type ForkStatus = 'starting' | 'open' | 'failed' | 'closed';

/**
 * Something on its start that needs a person, kept until it clears:
 * 'workspace_trust', 'startup_prompt', 'cli_exited', 'brief_not_delivered';
 * 'launch_failed' with `failedAt`. A client shows its own text for the
 * ones it knows and the raw value otherwise.
 */
export type ForkIssueReason = string;

export type Fork = {
  // Short; also in the branch, the worktree folder and file names.
  id: string;
  title: string;
  createdAt: string;
  // The conversation it was forked from, as it was then.
  origin: {
    sessionId: string;
    conversationId: string;
    tmuxName: string;
    profileId: string | null;
    // Its turns when it was forked; the branch line's memory ends there.
    turnsAtFork: number;
    // The main line's HEAD (the worktree's base); null outside git.
    commit: string | null;
  };
  profileId: string;
  // The profile's label when it was made.
  profileLabel: string;
  // The permission mode its CLI is launched in, decided when it was made.
  // Absent on branch lines made before modes: the setting at launch.
  permissionMode?: PermissionMode;
  memory: ForkMemory;
  // The user's first instruction, when they gave one.
  instruction: string | null;
  // Chosen before anything is made.
  childSessionId: string;
  // isolation 'shared': not a git repo, the main line's own folder.
  workspace: SpawnWorkspace;
  // Absolute path of the brief: <workspace.path>/.hestia/forks/<id>/brief.md.
  briefFile: string;
  // null once the brief is in (or given up on).
  startup: SpawnStartup | null;
  issue: { reason: ForkIssueReason; detail: string | null; at: string } | null;
  failedAt: string | null;
  closedAt: string | null;
  closedReason: 'user' | 'session_removed' | null;
  // The last close's worktree outcome.
  cleanup: { at: string; result: 'removed' | 'kept' | 'shared'; reason?: 'branch_not_merged' | 'workspace_dirty' } | null;
};

export function forkStatus(fork: Pick<Fork, 'closedAt' | 'failedAt' | 'startup'>): ForkStatus {
  if (fork.closedAt) return 'closed';
  if (fork.failedAt) return 'failed';
  return fork.startup ? 'starting' : 'open';
}

/**
 * GET /forks/preview?parentSessionId=&profileId=: what a branch line would
 * be, read without writing anything. `workspace.path` and `branch` show the
 * id that isn't chosen yet as '…'.
 */
export type ForkPreview = {
  memory: ForkMemory;
  memoryReason: ForkMemoryReason | null;
  profileId: string;
  workspace: Pick<SpawnWorkspace, 'isolation' | 'path' | 'branch' | 'baseCommit' | 'repoRoot'>;
  // The main line's uncommitted files (repo-relative), which the worktree
  // won't have; null outside git or when unknown.
  parentDirtyFiles: string[] | null;
  turnsAtFork: number;
};

/**
 * POST /forks (the user's login only). `profileId` defaults to the main
 * line's current one. A low quota on the profile's account is answered 409
 * `quota_low_confirm`, and starts once sent again with `confirmLowQuota`.
 */
export type StartForkRequest = {
  parentSessionId: string;
  profileId?: string;
  title?: string;
  instruction?: string;
  confirmLowQuota?: boolean;
  // The permission mode its CLI starts in (permissions.ts). Absent: the
  // main line's tmux's or the global setting for its runtime.
  permissionMode?: PermissionMode;
};

/**
 * POST /forks/:id/close (the user's login only; may be sent again): closes
 * its tmux as the app's 關閉此 tmux does (`force` ends it as it is; a CLI
 * that won't exit is 409 `fork_still_running`), then removes its worktree
 * and branch only when the branch is merged into the repo's current HEAD
 * and nothing is uncommitted — otherwise both are kept, which is a normal
 * outcome. Nothing is merged, pushed or force-deleted.
 */
export type CloseForkRequest = { force?: boolean };

export type ForkCloseOutcome = {
  tmuxClosed: boolean;
  workspace: 'removed' | 'kept' | 'shared';
  keptReason?: 'branch_not_merged' | 'workspace_dirty';
};

/** POST /forks, GET /forks/:id. */
export type ForkResponse = { fork: Fork };
/** GET /forks?session=<id>&open=1: newest first; `session` is the main line or the branch line. */
export type ForkListResponse = { forks: Fork[] };
export type CloseForkResponse = { fork: Fork; outcome: ForkCloseOutcome };

/**
 * What a branch line types into its CLI, word for word: one line (a
 * newline would submit early) telling it to read the brief, then start on
 * the instruction in it, or wait for the user.
 */
export const FORK_MESSAGES = {
  brief: (file: string, hasInstruction: boolean) =>
    typedText(hasInstruction ? 'typed.fork.briefWithInstruction' : 'typed.fork.briefWaiting', { file }),
};

const squeeze = (text: string) => text.replace(/\s+/g, '');
// The line's fixed opening: its [tag].
const BRIEF_SHAPE = FORK_MESSAGES.brief('', false);
const BRIEF_HEAD = BRIEF_SHAPE.slice(0, BRIEF_SHAPE.indexOf(']') + 1);

/** Whether `text` is a branch line's brief line, so a client labels it (like a handoff's). */
export function forkMessageKind(text: string): 'brief' | null {
  const got = squeeze(text);
  return got.startsWith(squeeze(BRIEF_HEAD)) && got.includes('.hestia/forks/') ? 'brief' : null;
}
