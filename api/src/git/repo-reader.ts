import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { RepoBranchState, RepoCommitDetail, RepoCommitSummary, RepoDiff, RepoDiffMode, RepoFileChange, RepoStatus } from '../contract/repo.js';
import { parseUnifiedDiff } from './diff-parse.js';
import { DETAIL_FORMAT, SUMMARY_FORMAT, parseCommitDetail, parseDiffTreeFiles, parseLogSummaries } from './log-parse.js';
import { GitError, git } from './run.js';
import { parsePorcelainV2 } from './status-parse.js';

// What the project files and git view reads from one project path (`cwd`,
// already realpath'd and fenced by repo-paths.ts). Read-only: nothing here
// writes to the repo, fetches, or takes a lock.

export const MAX_STATUS_FILES = 2000;
export const MAX_UNPUSHED = 100;
export const MAX_COMMIT_FILES = 1000;

export class CommitNotFoundError extends Error {}

export type RepoInfo = { toplevel: string; prefix: string };

/** The repo the path is in, or null when it isn't in a work tree. */
export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
  let out: string;
  try {
    out = await git(cwd, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--show-prefix']);
  } catch (error) {
    if (error instanceof GitError && error.kind === 'not_repo') return null;
    throw error;
  }
  const [inside, toplevel, prefix] = out.split('\n');
  if (inside !== 'true' || !toplevel) return null;
  return { toplevel, prefix: prefix ?? '' };
}

/** When the repo last fetched: FETCH_HEAD's time. */
export async function lastFetchAt(cwd: string): Promise<string | null> {
  const fetchHead = (await git(cwd, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim();
  try {
    return (await stat(path.resolve(cwd, fetchHead))).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Changes whenever a local branch or HEAD moves. */
export async function refsFingerprint(cwd: string, headOid: string | null): Promise<string> {
  const refs = await git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads']);
  return createHash('sha1').update(refs).update(`HEAD ${headOid ?? ''}`).digest('hex');
}

export async function readWorkingState(cwd: string, prefix: string): Promise<{ branch: RepoBranchState; files: RepoFileChange[] }> {
  const out = await git(cwd, [
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty', '--find-renames', '--', '.',
  ]);
  return parsePorcelainV2(out, prefix);
}

/** The commits HEAD has that its upstream (or, with none, every remote) doesn't. */
export async function readUnpushed(cwd: string, branch: RepoBranchState): Promise<{ base: RepoStatus['unpushedBase']; commits: RepoCommitSummary[] }> {
  const log = (range: string[]) => git(cwd, ['log', '-z', `--format=${SUMMARY_FORMAT}`, '-n', String(MAX_UNPUSHED + 1), ...range, '--']);
  if (branch.upstream && !branch.unborn) {
    return { base: 'upstream', commits: parseLogSummaries(await log(['@{upstream}..HEAD'])) };
  }
  const remotes = (await git(cwd, ['remote'])).trim();
  if (!remotes) return { base: 'none', commits: [] };
  if (branch.unborn) return { base: 'remotes', commits: [] };
  return { base: 'remotes', commits: parseLogSummaries(await log(['HEAD', '--not', '--remotes'])) };
}

export async function readStatus(cwd: string, info: RepoInfo, root: string): Promise<RepoStatus> {
  const { branch, files } = await readWorkingState(cwd, info.prefix);
  const [unpushed, fetchedAt, fingerprint] = await Promise.all([
    readUnpushed(cwd, branch),
    lastFetchAt(cwd),
    refsFingerprint(cwd, branch.oid),
  ]);
  return {
    root,
    prefix: info.prefix,
    branch,
    lastFetchAt: fetchedAt,
    files: files.slice(0, MAX_STATUS_FILES),
    filesTruncated: files.length > MAX_STATUS_FILES,
    unpushedBase: unpushed.base,
    unpushed: unpushed.commits.slice(0, MAX_UNPUSHED),
    unpushedTruncated: unpushed.commits.length > MAX_UNPUSHED,
    refsFingerprint: fingerprint,
  };
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '-U3'];

async function emptyTree(cwd: string): Promise<string> {
  return (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/** The full sha of a commit, or CommitNotFoundError. `rev` is a hex sha. */
export async function resolveCommit(cwd: string, rev: string): Promise<{ sha: string; parents: string[] }> {
  try {
    await git(cwd, ['cat-file', '-e', '--end-of-options', `${rev}^{commit}`]);
  } catch (error) {
    if (error instanceof GitError && error.kind === 'failed') throw new CommitNotFoundError(`no commit ${rev}`);
    throw error;
  }
  const [sha, ...parents] = (await git(cwd, ['rev-list', '--parents', '-n', '1', '--end-of-options', rev])).trim().split(' ');
  return { sha: sha!, parents };
}

export type DiffRequest = {
  // Relative to the project path; `orig` is a rename's source.
  path: string;
  orig: string | null;
  mode: RepoDiffMode;
  commit: string | null;
  // Whether the file exists in the work tree now.
  exists: boolean;
};

// Whether HEAD points at a commit (a new repo's branch doesn't yet).
async function hasHead(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okExitCodes: [1] })).trim() !== '';
}

export async function readDiff(cwd: string, info: RepoInfo, request: DiffRequest): Promise<RepoDiff> {
  const spec = info.prefix + request.path;
  const pathspecs = request.orig ? ['--', spec, info.prefix + request.orig] : ['--', spec];
  const answer = (patch: string, statusOverride?: RepoDiff['status']): RepoDiff => {
    const parsed = parseUnifiedDiff(patch);
    return {
      path: request.path,
      origPath: request.orig,
      mode: request.mode,
      status: statusOverride ?? parsed.status,
      binary: parsed.binary,
      truncated: parsed.truncated,
      hunks: parsed.hunks,
    };
  };

  if (request.mode === 'commit') {
    const { sha, parents } = await resolveCommit(cwd, request.commit ?? '');
    const patch = parents[0]
      ? await git(cwd, [...DIFF_ARGS, parents[0], sha, ...pathspecs])
      : await git(cwd, ['diff-tree', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--no-commit-id', '-M', '--root', sha, ...pathspecs]);
    return answer(patch);
  }

  // An untracked folder (a single '…/' entry in status) has no diff of its own.
  if (request.path.endsWith('/')) return answer('', 'untracked');

  let patch: string;
  if (request.mode === 'staged') patch = await git(cwd, [...DIFF_ARGS, '--cached', ...pathspecs]);
  else if (request.mode === 'unstaged') patch = await git(cwd, [...DIFF_ARGS, ...pathspecs]);
  else patch = await git(cwd, [...DIFF_ARGS, await hasHead(cwd) ? 'HEAD' : await emptyTree(cwd), ...pathspecs]);

  if (!patch.trim() && request.mode !== 'staged' && request.exists) {
    // Nothing against the index: an untracked file shows as all-new.
    const tracked = await git(cwd, ['ls-files', '-z', '--', spec]);
    if (!tracked) {
      const relativeToCwd = path.relative(cwd, path.join(info.toplevel, spec)) || '.';
      patch = await git(cwd, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', '/dev/null', relativeToCwd], { okExitCodes: [1] });
      return answer(patch, 'untracked');
    }
  }
  return answer(patch);
}

export async function readCommit(cwd: string, info: RepoInfo, rev: string): Promise<RepoCommitDetail> {
  const { sha, parents } = await resolveCommit(cwd, rev);
  const [shown, changed] = await Promise.all([
    git(cwd, ['show', '-s', '-z', '--no-notes', `--format=${DETAIL_FORMAT}`, '--end-of-options', sha]),
    git(cwd, ['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-commit-id', ...(parents[0] ? [parents[0], sha] : ['--root', sha])]),
  ]);
  const files = parseDiffTreeFiles(changed, info.prefix);
  return {
    ...parseCommitDetail(shown),
    files: files.slice(0, MAX_COMMIT_FILES),
    filesTruncated: files.length > MAX_COMMIT_FILES,
  };
}
