import { realpath } from 'node:fs/promises';
import { resolveInsideRoot as resolveFenced, type ResolvedPath } from '@maderaojen/fs-guard';
import { denied } from './denied-paths.js';
import * as projectStore from '../project-store.js';
import { spawnRoots } from '../spawn/roots.js';

// Where the project files and git view may look. Unlike the directory
// browser (fs-browser.ts), which lists folders anywhere, this one sends file
// contents and diffs over the network, so it is fenced:
// - only under one of the project's own registered paths (the "root"), or
//   one of its delegations' or branch lines' worktrees while it exists;
// - never through `..`, an absolute path, a symlink pointing out, or into
//   any `.git` folder;
// - never at this backend's own secrets or the user's keys (denied-paths.ts),
//   even when a project path happens to contain them;
// - never at a file that likely holds secrets by its name or folder
//   (fs-guard isSensitivePath: .env, keys, credentials…), as asked for or as its
//   realpath — 'sensitive', which the routes answer path_sensitive.
// A path may name something that no longer exists (a deleted file, a
// rename's source, a file in an old commit): it is checked by its nearest
// existing ancestor instead.
// The fence is @maderaojen/fs-guard's (its FileGuardError: 'outside',
// 'forbidden', 'sensitive'); which roots and which denied folders are this
// app's, and so is RepoPathError, for the project and its roots.

export type RepoPathErrorCode = 'project_not_found' | 'root_unknown' | 'root_missing';

export class RepoPathError extends Error {
  constructor(public readonly code: RepoPathErrorCode, message: string) {
    super(message);
  }
}

/** The project and the realpath of one of its registered paths. */
export async function resolveProjectRoot(projectId: string, root: string): Promise<{ project: projectStore.Project; rootReal: string }> {
  const project = await projectStore.getProject(projectId);
  if (!project || project.deletedAt) throw new RepoPathError('project_not_found', 'project not found');
  if (!project.paths.some((entry) => entry.path === root) && !(await spawnRoots(projectId)).some((entry) => entry.path === root)) {
    throw new RepoPathError('root_unknown', 'not one of the project\'s paths');
  }
  try {
    return { project, rootReal: await realpath(root) };
  } catch {
    throw new RepoPathError('root_missing', `the folder is gone: ${root}`);
  }
}

/**
 * `relative` (a path under the root, from a client) checked against the
 * fence above. Answers it absolute and normalised; throws FileGuardError
 * 'outside', 'forbidden' or 'sensitive'.
 */
export function resolveInsideRoot(rootReal: string, relative: string): Promise<ResolvedPath> {
  return resolveFenced(rootReal, relative, { denied });
}
