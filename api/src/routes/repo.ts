import { realpath } from 'node:fs/promises';
import { Router, type Response } from 'express';
import { FileGuardError } from '@maderaojen/fs-guard';
import { z } from 'zod';
import type { RepoRoot, RepoRootsResponse, RepoWorktreesResponse } from '../contract/repo.js';
import * as projectStore from '../project-store.js';
import { RepoPathError, resolveInsideRoot, resolveProjectRoot } from '../files/repo-paths.js';
import { spawnRoots } from '../spawn/roots.js';
import { repoWorktrees } from '../spawn/worktrees.js';
import { CommitNotFoundError, lastFetchAt, readCommit, readDiff, readStatus, readWorkingState, repoInfo } from '../git/repo-reader.js';
import { BadCursorError, LOG_PAGE_DEFAULT, LOG_PAGE_MAX, RepoChangedError, readLogPage } from '../git/repo-history.js';
import { GitError } from '../git/run.js';
import { listRepoDirectory, readCommittedFile, readWorkingFile } from '../repo-tree.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';

// A project's files and git, read-only (contract/repo.ts). Mounted under /projects next to the projects and notes
// routers; every call names one of the project's paths as `root`. Only the
// user's login may read them, never the local tool token a CLI holds (the
// same rule as routes/session-files.ts): an LLM in a tmux has its own shell.
export const repoRouter = Router();

function sendRepoError(res: Response, error: unknown): void {
  if (error instanceof RepoPathError) {
    if (error.code === 'project_not_found') sendError(res, 404, 'project_not_found', error.message);
    else if (error.code === 'root_unknown') sendError(res, 400, 'repo_root_unknown', error.message);
    else sendError(res, 404, 'folder_not_found', error.message);
    return;
  }
  if (error instanceof FileGuardError) {
    if (error.code === 'outside') sendError(res, 403, 'path_outside_project', 'path outside the project');
    else if (error.code === 'forbidden') sendError(res, 403, 'path_forbidden', error.message);
    else if (error.code === 'sensitive') sendError(res, 403, 'path_sensitive', error.message);
    else if (error.code === 'not_found') sendError(res, 404, 'path_not_found', error.message);
    else if (error.code === 'not_a_directory') sendError(res, 400, 'path_not_a_directory', error.message);
    else sendError(res, 400, 'invalid_request', error.message);
    return;
  }
  if (error instanceof CommitNotFoundError) {
    sendError(res, 404, 'commit_not_found', error.message);
    return;
  }
  if (error instanceof RepoChangedError) {
    sendError(res, 409, 'repo_changed', error.message);
    return;
  }
  if (error instanceof BadCursorError) {
    sendError(res, 400, 'invalid_request', error.message);
    return;
  }
  if (error instanceof GitError) {
    if (error.kind === 'not_repo') {
      sendError(res, 409, 'not_a_git_repo', 'not a git repository');
      return;
    }
    const reason = error.kind === 'failed' ? 'error' : error.kind;
    sendError(res, 502, 'git_failed', error.message || 'git failed', { reason });
    return;
  }
  throw error;
}

repoRouter.get('/:id/repos', requireLogin, async (req, res) => {
  const project = await projectStore.getProject(req.params.id as string);
  if (!project || project.deletedAt) {
    sendError(res, 404, 'project_not_found', 'project not found');
    return;
  }
  try {
    // The project's own paths, then its delegations' and branch lines'
    // worktrees still on this host (spawn/roots.ts).
    const spawned = (await spawnRoots(project.id)).filter((entry) => !project.paths.some((own) => own.path === entry.path));
    const entries: { path: string; primary: boolean; spawn: RepoRoot['spawn'] }[] = [
      ...project.paths.map((entry) => ({ path: entry.path, primary: entry.primary, spawn: null })),
      ...spawned.map(({ path, ...spawn }) => ({ path, primary: false, spawn })),
    ];
    const roots = await Promise.all(entries.map(async (entry): Promise<RepoRoot> => {
      let real: string;
      try {
        real = await realpath(entry.path);
      } catch {
        return { path: entry.path, primary: entry.primary, spawn: entry.spawn, exists: false, repo: null, repoError: null };
      }
      try {
        const info = await repoInfo(real);
        if (!info) return { path: entry.path, primary: entry.primary, spawn: entry.spawn, exists: true, repo: null, repoError: null };
        const [{ branch, files }, fetchedAt] = await Promise.all([readWorkingState(real, info.prefix), lastFetchAt(real)]);
        return {
          path: entry.path,
          primary: entry.primary,
          spawn: entry.spawn,
          exists: true,
          repo: { toplevel: info.toplevel, prefix: info.prefix, branch, changedCount: files.length, lastFetchAt: fetchedAt },
          repoError: null,
        };
      } catch (error) {
        // One path's git trouble doesn't hide the others; no git at all does.
        if (!(error instanceof GitError) || error.kind === 'unavailable') throw error;
        return { path: entry.path, primary: entry.primary, spawn: entry.spawn, exists: true, repo: null, repoError: error.kind === 'failed' || error.kind === 'not_repo' ? 'error' : error.kind };
      }
    }));
    const body: RepoRootsResponse = { roots };
    res.json(body);
  } catch (error) {
    sendRepoError(res, error);
  }
});

const rootQuery = z.object({ root: z.string().min(1) });

// A root that is a git work tree, or not_a_git_repo.
async function openRepo(projectId: string, root: string) {
  const { rootReal } = await resolveProjectRoot(projectId, root);
  const info = await repoInfo(rootReal);
  if (!info) throw new GitError('not_repo', 'not a git repository');
  return { rootReal, info };
}

repoRouter.get('/:id/repo/status', requireLogin, async (req, res) => {
  const parsed = rootQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  try {
    const { rootReal, info } = await openRepo(req.params.id as string, parsed.data.root);
    res.json(await readStatus(rootReal, info, parsed.data.root));
  } catch (error) {
    sendRepoError(res, error);
  }
});

// Every worktree of the root's repo, Hestia's or not: what each is, never
// what is in it. Only those that are
// one of the roots read here say which root opens them.
repoRouter.get('/:id/repo/worktrees', requireLogin, async (req, res) => {
  const parsed = rootQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  try {
    const projectId = req.params.id as string;
    const { rootReal } = await openRepo(projectId, parsed.data.root);
    const project = await projectStore.getProject(projectId);
    const roots = [...(project?.paths.map((entry) => entry.path) ?? []), ...(await spawnRoots(projectId)).map((entry) => entry.path)];
    const body: RepoWorktreesResponse = await repoWorktrees(rootReal, roots);
    res.json(body);
  } catch (error) {
    sendRepoError(res, error);
  }
});

const SHA = z.string().regex(/^[0-9a-f]{4,64}$/i);

const diffQuery = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  orig: z.string().min(1).optional(),
  mode: z.enum(['worktree', 'staged', 'unstaged', 'commit']).default('worktree'),
  commit: SHA.optional(),
}).refine((query) => query.mode !== 'commit' || query.commit !== undefined, { message: 'commit is required for mode=commit' });

repoRouter.get('/:id/repo/diff', requireLogin, async (req, res) => {
  const parsed = diffQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const query = parsed.data;
  try {
    const { rootReal, info } = await openRepo(req.params.id as string, query.root);
    const target = await resolveInsideRoot(rootReal, query.path);
    const orig = query.orig === undefined ? null : await resolveInsideRoot(rootReal, query.orig);
    // An untracked folder keeps its trailing '/' (status lists it so).
    const relative = query.path.endsWith('/') ? `${target.relative}/` : target.relative;
    res.json(await readDiff(rootReal, info, {
      path: relative, orig: orig?.relative ?? null, mode: query.mode, commit: query.commit ?? null, exists: target.exists,
    }));
  } catch (error) {
    sendRepoError(res, error);
  }
});

const commitQuery = z.object({ root: z.string().min(1), sha: SHA });

repoRouter.get('/:id/repo/commit', requireLogin, async (req, res) => {
  const parsed = commitQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  try {
    const { rootReal, info } = await openRepo(req.params.id as string, parsed.data.root);
    res.json(await readCommit(rootReal, info, parsed.data.sha));
  } catch (error) {
    sendRepoError(res, error);
  }
});

// The file tree and a file's contents (phase 2): any project path, git
// work tree or not — only the ignored marks need git.
const treeQuery = z.object({
  root: z.string().min(1),
  dir: z.string().default(''),
  ignored: z.enum(['0', '1']).default('0'),
});

repoRouter.get('/:id/repo/tree', requireLogin, async (req, res) => {
  const parsed = treeQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const query = parsed.data;
  try {
    const { rootReal } = await resolveProjectRoot(req.params.id as string, query.root);
    const dir = await resolveInsideRoot(rootReal, query.dir);
    const isRepo = (await repoInfo(rootReal)) !== null;
    res.json(await listRepoDirectory(rootReal, query.root, isRepo, dir, query.ignored === '1'));
  } catch (error) {
    sendRepoError(res, error);
  }
});

const fileQuery = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  // Read from a commit instead of the work tree (a deleted file's last
  // version): HEAD, or a sha as the other endpoints take one.
  rev: z.union([z.literal('HEAD'), SHA]).optional(),
});

repoRouter.get('/:id/repo/file', requireLogin, async (req, res) => {
  const parsed = fileQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const query = parsed.data;
  try {
    if (query.rev === undefined) {
      const { rootReal } = await resolveProjectRoot(req.params.id as string, query.root);
      res.json(await readWorkingFile(await resolveInsideRoot(rootReal, query.path)));
      return;
    }
    const { rootReal, info } = await openRepo(req.params.id as string, query.root);
    res.json(await readCommittedFile(rootReal, info, query.rev, await resolveInsideRoot(rootReal, query.path)));
  } catch (error) {
    sendRepoError(res, error);
  }
});

// The history (phase 3): the local branches' commits a page at a time,
// with the branches themselves on the first page.
const logQuery = z.object({
  root: z.string().min(1),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  limit: z.coerce.number().int().min(1).max(LOG_PAGE_MAX).default(LOG_PAGE_DEFAULT),
});

repoRouter.get('/:id/repo/log', requireLogin, async (req, res) => {
  const parsed = logQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  try {
    const { rootReal } = await openRepo(req.params.id as string, parsed.data.root);
    res.json(await readLogPage(rootReal, parsed.data.cursor ?? null, parsed.data.limit));
  } catch (error) {
    sendRepoError(res, error);
  }
});
