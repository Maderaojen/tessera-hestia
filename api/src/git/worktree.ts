import { git, GitError } from './run.js';

// The few git writes the app makes, all for a delegation's worktree: a new worktree on a new
// branch, reading whether its work is committed, and — once the delegation
// is over, at the user's word — removing a clean worktree and deleting a
// merged branch. Nothing here pushes, merges or forces anything.

// A checkout of a large repo can take longer than a read.
const WORKTREE_ADD_TIMEOUT_MS = 120_000;

/** The commit HEAD is at, or null in a repo with no commit yet. */
export async function headCommit(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim() || null;
  } catch (error) {
    if (error instanceof GitError && error.kind === 'failed') return null;
    throw error;
  }
}

/** The branch checked out in `cwd`; null when detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const name = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okExitCodes: [1] })).trim();
  return name || null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { okExitCodes: [1] });
  return out.trim().length > 0;
}

/** Nothing uncommitted: no staged, unstaged or untracked (not ignored) file. */
export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=normal'])).trim() === '';
}

/**
 * A worktree at `dir` with `branch` checked out, from `base` when the
 * branch doesn't exist yet. Run in the repo (`repoRoot`).
 */
export async function addWorktree(repoRoot: string, dir: string, branch: string, base: string | null): Promise<void> {
  const args = await branchExists(repoRoot, branch)
    ? ['worktree', 'add', '--end-of-options', dir, branch]
    : ['worktree', 'add', '-b', branch, '--end-of-options', dir, ...(base ? [base] : [])];
  await git(repoRoot, args, { timeoutMs: WORKTREE_ADD_TIMEOUT_MS });
}

/** Whether `branch` is merged into the repo's HEAD (what `git branch -d` asks for). */
export async function isMerged(repoRoot: string, branch: string): Promise<boolean> {
  const merged = await git(repoRoot, ['branch', '--list', '--merged', 'HEAD', '--format=%(refname:short)', '--end-of-options', branch]);
  return merged.split('\n').some((line) => line.trim() === branch);
}

/**
 * Whether `commit` is in the repo's HEAD (HEAD has it, or is it): what a
 * delegation's delivery is checked against once the user may have merged
 * it. False for a commit the repo doesn't have.
 */
export async function headContains(repoRoot: string, commit: string): Promise<boolean> {
  const known = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`], { okExitCodes: [1] })).trim();
  if (!known) return false;
  return (await git(repoRoot, ['rev-list', '--max-count=1', '--end-of-options', known, '^HEAD'])).trim() === '';
}

/** Removes a worktree; git refuses one with uncommitted or untracked (not ignored) files. Never forced. */
export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--end-of-options', dir]);
}

/** Forgets worktrees whose folder is gone. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(repoRoot, ['worktree', 'prune']);
}

/** A worktree as `git worktree list --porcelain` tells it. */
export type WorktreeEntry = {
  path: string;
  head: string | null;
  // Short name; null when detached (or bare).
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  // git's own word that its folder is gone.
  prunable: boolean;
};

/** `git worktree list --porcelain -z`: one NUL per field, one more after each worktree. Pure. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let entry: WorktreeEntry | null = null;
  for (const field of out.split('\0')) {
    if (!field) {
      if (entry) entries.push(entry);
      entry = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (entry) entries.push(entry);
      entry = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (entry) {
      if (key === 'HEAD') entry.head = value || null;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '') || null;
      else if (key === 'detached') entry.detached = true;
      else if (key === 'bare') entry.bare = true;
      else if (key === 'locked') entry.locked = true;
      else if (key === 'prunable') entry.prunable = true;
    }
  }
  if (entry) entries.push(entry);
  return entries;
}

/** Every worktree of the repo `cwd` is in, its main checkout first. */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain', '-z']));
}

/** How many entries `git status` has: staged, unstaged and untracked (not ignored). */
export async function changedCount(cwd: string): Promise<number> {
  // One line each (a rename too; a name with a newline comes quoted).
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=normal'])).split('\n').filter((line) => line.trim() !== '').length;
}

/** Deletes a branch that is merged (`-d`, never `-D`). */
export async function deleteMergedBranch(repoRoot: string, branch: string): Promise<void> {
  await git(repoRoot, ['branch', '-d', '--end-of-options', branch]);
}
