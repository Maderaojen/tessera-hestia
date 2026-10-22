// What a delegation's or a branch line's title, branch and worktree folder
// are called. Pure functions.

import { spawnDefaultTitle } from '../contract/spawnTitle.js';

export type SpawnKind = 'delegate' | 'fork';

/** A title from a text when none was given: its first clause, cut short (contract/spawnTitle.ts). */
export const defaultTitle = spawnDefaultTitle;

/** The ASCII words of a title, for a branch name; '' when there are none (a Chinese title). */
export function slugify(title: string, max = 32): string {
  const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '');
}

/** `delegate/<id>-<slug>` or `fork/<id>-<slug>`; just the id when the title has no ASCII words. */
export function branchName(kind: SpawnKind, id: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${kind}/${id}-${slug}` : `${kind}/${id}`;
}

/**
 * The worktree's own folder name, wherever it goes: the repo's name stays
 * in it, so the folder alone (in a CLI's title, `git worktree list`) still
 * says whose and what it is.
 */
export function worktreeFolderName(kind: SpawnKind, repoName: string, id: string): string {
  return `${repoName}-${kind}-${id}`;
}

/** The one folder beside a repo its worktrees go into. */
export function worktreesHomeName(repoName: string): string {
  return `${repoName}-worktrees`;
}
