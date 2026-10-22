// Where a delegation or a branch line works, and how far its start has got: both open
// a worktree and a tmux of their own the same way (api/src/spawn/).

import type { LaunchGuard } from './launch-guard.js';

export type SpawnIsolation = 'worktree' | 'shared';

export type SpawnWorkspace = {
  isolation: SpawnIsolation;
  // The repo it was cut from (the starting session's), null when that is
  // not a git repo.
  repoRoot: string | null;
  // Its own cwd: inside its worktree, the same subfolder the starting
  // session works in.
  path: string;
  // The worktree's top folder; null in 'shared' mode.
  worktree: string | null;
  branch: string | null;
  // The starting session's HEAD when it was made.
  baseCommit: string | null;
  // Cleaned up once it is over: when the worktree was removed, and when its
  // branch was deleted (only ever a merged one). Absent in records from before.
  removedAt?: string | null;
  branchDeletedAt?: string | null;
};

/**
 * Where a start is: its workspace, its tmux, its CLI, then the one-line
 * instruction to read the brief. null once the brief is in.
 */
export type SpawnStartup = {
  stage: 'workspace' | 'session' | 'launch' | 'briefing';
  stageSince: string;
  launchedAt: string | null;
  // When the start-up trust prompt was answered on the user's behalf.
  trustAnsweredAt: string | null;
  // When the instruction went to the CLI; null before it has.
  sentAt: string | null;
  resent: number;
  // When its transcript showed the instruction, whole: the CLI is then
  // watched through its first turn before the start is over (ADR 0030).
  // Absent on starts saved before it existed.
  deliveredAt?: string | null;
  // What the launch guard saw of the CLI's screen, and its relaunches.
  guard?: LaunchGuard;
};

/**
 * A branch line or delegation that looks finished, on its session
 * (SessionDto `closable`): its worktree has nothing uncommitted, its CLI is
 * not at work, and either its work is in the branch the repo it was cut
 * from has checked out ('merged', `into` that branch) or it made no commit
 * at all ('unchanged', `into` null). Only a hint for the session list to
 * offer closing it quietly; closing is still POST /forks/:id/close or
 * POST /delegations/:id/cleanup, with their own checks.
 */
export type SpawnClosable = { reason: 'merged' | 'unchanged'; into: string | null };
