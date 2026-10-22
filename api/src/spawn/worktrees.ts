import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepoWorktree, RepoWorktreesResponse } from '../contract/repo.js';
import { isWithin } from '@maderaojen/fs-guard';
import { changedCount, isMerged, listWorktrees, type WorktreeEntry } from '../git/worktree.js';
import { spawned, type Spawned } from './roots.js';
import { removalRefusal } from './workspace.js';

// A repo's worktrees for the git view:
// every one git knows, Hestia's or not, with what each is — never what is
// in it. Which of them the git view may read is decided elsewhere (the
// roots passed in, repo-paths.ts); this only says which root opens which.
// Cleaning one up is the delegation's or branch line's own (their
// engines), so nothing here writes.

// Hestia's own worktrees, over but still there, at which the user is told
// to clean up. Nothing is refused for it.
export const ENDED_KEPT_WARN_AT = 5;

const real = (target: string) => realpath(target).catch(() => null);

type Located = { entry: WorktreeEntry; at: string; exists: boolean };

/** The worktree `target` is in: the deepest one holding it (a worktree may sit inside another). */
function holderOf(worktrees: Located[], target: string): Located | null {
  let found: Located | null = null;
  for (const worktree of worktrees) {
    if (isWithin(target, worktree.at) && (!found || worktree.at.length > found.at.length)) found = worktree;
  }
  return found;
}

/**
 * The worktrees of the repo `rootReal` is in. `roots` are the roots the
 * git view reads for this project (its paths, its own spawn worktrees);
 * a worktree holding one of them is opened as that root.
 */
export async function repoWorktrees(rootReal: string, roots: string[]): Promise<RepoWorktreesResponse> {
  const listed = (await listWorktrees(rootReal)).filter((entry) => !entry.bare);
  const worktrees: Located[] = await Promise.all(listed.map(async (entry) => {
    const at = await real(entry.path);
    return { entry, at: at ?? path.resolve(entry.path), exists: !!at && !entry.prunable };
  }));
  const mainPath = listed[0]?.path ?? null;
  const current = holderOf(worktrees, rootReal);

  // Each readable root to the worktree it is in; an exact match first.
  const openAs = new Map<Located, string>();
  const located = await Promise.all(roots.map(async (root) => ({ root, at: await real(root) })));
  for (const exact of [true, false]) {
    for (const { root, at } of located) {
      const holder = at ? holderOf(worktrees, at) : null;
      if (holder && (holder.at === at) === exact && !openAs.has(holder)) openAs.set(holder, root);
    }
  }

  // Hestia's own, by their worktree's folder.
  const records = new Map<string, Spawned>();
  for (const record of await spawned()) {
    if (record.removed || !record.workspace.worktree) continue;
    records.set((await real(record.workspace.worktree)) ?? path.resolve(record.workspace.worktree), record);
  }

  const answer = await Promise.all(worktrees.map(async (worktree, index): Promise<RepoWorktree> => {
    const { entry, exists } = worktree;
    const record = records.get(worktree.at) ?? null;
    const main = index === 0;
    const [changed, merged, blocked] = await Promise.all([
      exists ? changedCount(entry.path).catch(() => null) : Promise.resolve(null),
      // A spawned one against the repo it was cut from, as its cleanup asks.
      !main && entry.branch && (record?.workspace.repoRoot ?? mainPath)
        ? isMerged(record?.workspace.repoRoot ?? mainPath!, entry.branch).catch(() => null)
        : Promise.resolve(null),
      record?.ended && exists
        ? removalRefusal(record.workspace, { deleteBranch: record.kind === 'fork' }).then((refusal) => refusal?.code ?? null, () => null)
        : Promise.resolve(null),
    ]);
    return {
      path: entry.path,
      main,
      current: worktree === current,
      branch: entry.branch,
      head: entry.head,
      detached: entry.detached,
      locked: entry.locked,
      exists,
      changedCount: changed,
      merged,
      root: openAs.get(worktree) ?? null,
      spawn: record
        ? { kind: record.kind, id: record.id, title: record.title, status: record.status, ended: record.ended, cleanupBlocked: blocked, sessionId: record.sessionId }
        : null,
    };
  }));
  return {
    worktrees: answer,
    endedKept: answer.filter((worktree) => worktree.spawn?.ended && worktree.exists).length,
    endedKeptWarnAt: ENDED_KEPT_WARN_AT,
  };
}
