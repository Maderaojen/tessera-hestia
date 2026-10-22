import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { WORKTREES_DIR, WORKTREES_FALLBACK_DIR } from '../config.js';
import type { SpawnIsolation, SpawnWorkspace } from '../contract/workspace.js';
import type { ErrorCode } from '../contract/errors.js';
import { isDeniedPath } from '../files/denied-paths.js';
import { repoInfo } from '../git/repo-reader.js';
import { addWorktree, branchExists, currentBranch, deleteMergedBranch, headCommit, headContains, isClean, isMerged, pruneWorktrees, removeWorktree } from '../git/worktree.js';
import { worktreeFolderName, worktreesHomeName, type SpawnKind } from './naming.js';

// A delegation's or a branch line's own worktree, against real git: planned
// without changing anything, made, checked, and removed once it is over.

export type RemovalRefusal = { ok: false; code: Extract<ErrorCode, 'workspace_dirty' | 'branch_not_merged'>; message: string };

const exists = (target: string) => stat(target).then(() => true, () => false);

async function writable(dir: string): Promise<boolean> {
  return access(dir, constants.W_OK).then(() => true, () => false);
}

/**
 * The folder a repo's new worktrees go into:
 * the one HESTIA_WORKTREES_DIR names; else one folder beside the repo,
 * `<repo>-worktrees`, so its parent gains one entry rather than one per
 * worktree; else, when that can't be written, the fallback under the XDG
 * data dir. Never anywhere the git panel won't read (the state dir, say):
 * with the fallback there too (a state dir set under the XDG data dir),
 * it refuses rather than make a worktree nobody could open.
 */
export async function worktreesHome(repoTop: string, dirs: { configured: string | null; fallback: string } = { configured: WORKTREES_DIR, fallback: WORKTREES_FALLBACK_DIR }): Promise<string> {
  if (dirs.configured && !isDeniedPath(dirs.configured)) return dirs.configured;
  const beside = path.join(path.dirname(repoTop), worktreesHomeName(path.basename(repoTop)));
  const canWrite = await exists(beside) ? await writable(beside) : await writable(path.dirname(repoTop));
  if (canWrite && !isDeniedPath(beside)) return beside;
  if (isDeniedPath(dirs.fallback)) {
    throw new Error(`nowhere to put a worktree that the git panel can read: ${dirs.fallback} is under the state dir; set HESTIA_WORKTREES_DIR`);
  }
  return dirs.fallback;
}

async function planWorktree(kind: SpawnKind, input: { id: string; branch: string }, info: { toplevel: string; prefix: string }, base: string): Promise<SpawnWorkspace> {
  const folder = worktreeFolderName(kind, path.basename(info.toplevel), input.id);
  const worktree = path.join(await worktreesHome(info.toplevel), folder);
  return {
    isolation: 'worktree',
    repoRoot: info.toplevel,
    path: path.resolve(worktree, info.prefix),
    worktree,
    branch: input.branch,
    baseCommit: base,
  };
}

/**
 * Where it will work, read without changing anything: a new worktree
 * in the folder worktreesHome picks, or
 * the starting session's own folder when it isn't in a git repo (or one
 * with no commit to branch from), or 'shared' was asked for.
 */
export async function planWorkspace(
  kind: SpawnKind, input: { id: string; branch: string; parentCwd: string; isolation: SpawnIsolation },
): Promise<SpawnWorkspace> {
  const info = await repoInfo(input.parentCwd);
  const base = info ? await headCommit(input.parentCwd) : null;
  if (!info || !base || input.isolation === 'shared') {
    return { isolation: 'shared', repoRoot: info?.toplevel ?? null, path: input.parentCwd, worktree: null, branch: null, baseCommit: base };
  }
  return planWorktree(kind, input, info, base);
}

/** Makes the planned worktree; one already there on the right branch is taken as it is. Throws when that can't be done. */
export async function ensureWorkspace(workspace: SpawnWorkspace): Promise<void> {
  if (workspace.isolation === 'shared' || !workspace.worktree || !workspace.repoRoot || !workspace.branch) {
    if (!(await exists(workspace.path))) throw new Error(`no such folder: ${workspace.path}`);
    return;
  }
  if (await exists(workspace.worktree)) {
    const branch = await currentBranch(workspace.worktree).catch(() => null);
    if (branch !== workspace.branch) throw new Error(`${workspace.worktree} already exists and is not on ${workspace.branch}`);
  } else {
    await mkdir(path.dirname(workspace.worktree), { recursive: true });
    await addWorktree(workspace.repoRoot, workspace.worktree, workspace.branch, workspace.baseCommit);
  }
  // The starting session's subfolder may hold nothing tracked.
  await mkdir(workspace.path, { recursive: true });
}

/** Whether its work is all committed, and its HEAD. */
export async function workspaceState(workspace: SpawnWorkspace): Promise<{ clean: boolean; head: string | null }> {
  if (!workspace.repoRoot) return { clean: true, head: null };
  return { clean: await isClean(workspace.path), head: await headCommit(workspace.path) };
}

/**
 * The branch the repo it was cut from has checked out ('HEAD' when
 * detached), when that has `head` — the commit its work was delivered at —
 * and `head` is more than where it started; null otherwise (nothing
 * delivered, nothing new, not merged, or not a repo).
 */
export async function mergedInto(workspace: SpawnWorkspace, head: string | null): Promise<string | null> {
  const { repoRoot, baseCommit } = workspace;
  if (!repoRoot || !head || head === baseCommit) return null;
  if (!(await headContains(repoRoot, head))) return null;
  return await currentBranch(repoRoot).catch(() => null) ?? 'HEAD';
}

/** What removing this worktree (and branch) would be refused for; null when nothing. */
export async function removalRefusal(workspace: SpawnWorkspace, { deleteBranch }: { deleteBranch: boolean }): Promise<RemovalRefusal | null> {
  const { repoRoot, worktree, branch } = workspace;
  if (!repoRoot || !worktree) throw new Error('not a worktree');
  if (deleteBranch && branch && await branchExists(repoRoot, branch) && !(await isMerged(repoRoot, branch))) {
    return { ok: false, code: 'branch_not_merged', message: `${branch} is not merged into ${await currentBranch(repoRoot).catch(() => null) ?? 'HEAD'}; it is kept` };
  }
  if (!workspace.removedAt && await exists(worktree) && !(await isClean(worktree))) {
    return { ok: false, code: 'workspace_dirty', message: `${worktree} has uncommitted changes; it is kept` };
  }
  return null;
}

/**
 * Removes the worktree (only with nothing uncommitted; skipped when
 * `removedAt` says it is gone already), and with `deleteBranch` its branch
 * (only a merged one, `git branch -d`). Nothing is done when either is
 * refused. Throws when git fails.
 */
export async function removeWorkspace(workspace: SpawnWorkspace, { deleteBranch }: { deleteBranch: boolean }): Promise<
  { ok: true; removed: boolean; branchDeleted: boolean } | RemovalRefusal
> {
  // Refused before anything is removed, so nothing is half done.
  const refused = await removalRefusal(workspace, { deleteBranch });
  if (refused) return refused;
  const { repoRoot, worktree, branch } = workspace as SpawnWorkspace & { repoRoot: string; worktree: string };
  const deleting = deleteBranch && !!branch && await branchExists(repoRoot, branch);
  let removed = false;
  if (!workspace.removedAt) {
    if (await exists(worktree)) {
      await removeWorktree(repoRoot, worktree);
    } else {
      // Removed by hand already: git only has to forget it.
      await pruneWorktrees(repoRoot);
    }
    removed = true;
  }
  if (deleting) await deleteMergedBranch(repoRoot, branch!);
  return { ok: true, removed, branchDeleted: deleting };
}

/** Whether the starting session's own folder has uncommitted changes (which the worktree won't have); null when unknown. */
export async function parentDirty(parentCwd: string): Promise<boolean | null> {
  return isClean(parentCwd).then((clean) => !clean, () => null);
}
