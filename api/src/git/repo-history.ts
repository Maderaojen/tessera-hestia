import type { RepoLogPage, RepoRefs } from '../contract/repo.js';
import { BRANCH_FORMAT, SUMMARY_FORMAT, parseBranchRefs, parseLogSummaries, parseRefTips } from './log-parse.js';
import { lastFetchAt, refsFingerprint } from './repo-reader.js';
import { git } from './run.js';

// The history the git graph draws: the local branches and HEAD, and their commits a page at a
// time. Lanes are laid out by the client (@maderaojen/git-graph in the web app);
// this only reads git. Local branches only — no remote branches, no tags,
// never a fetch.

export const LOG_PAGE_DEFAULT = 200;
export const LOG_PAGE_MAX = 500;
export const MAX_UNPUSHED_SHAS = 1000;

/** A cursor from before a branch or HEAD moved. */
export class RepoChangedError extends Error {}
/** A cursor this server didn't hand out. */
export class BadCursorError extends Error {}

type Cursor = { skip: number; fp: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(text: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (Number.isSafeInteger(value.skip) && (value.skip ?? -1) >= 0 && typeof value.fp === 'string') return { skip: value.skip!, fp: value.fp };
  } catch {
    // Falls through to the error below.
  }
  throw new BadCursorError('not a cursor');
}

/** Where HEAD is: on a branch (oid null before its first commit), or detached. */
export async function readHead(cwd: string): Promise<RepoRefs['head']> {
  const [branch, oid] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okExitCodes: [1] }),
    git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okExitCodes: [1] }),
  ]);
  return { branch: branch.trim() || null, oid: oid.trim() || null };
}

/**
 * The branch the history keeps leftmost, first that a local branch has:
 * the one origin/HEAD names, init.defaultBranch, then main, master, trunk.
 */
export async function defaultBranch(cwd: string, local: ReadonlySet<string>): Promise<string | null> {
  const [originHead, configured] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { okExitCodes: [1, 128] }),
    git(cwd, ['config', '--get', 'init.defaultBranch'], { okExitCodes: [1] }),
  ]);
  const candidates = [originHead.trim().replace(/^origin\//, ''), configured.trim(), 'main', 'master', 'trunk'];
  return candidates.find((name) => name && local.has(name)) ?? null;
}

// The history's starting points: every local branch, and HEAD when it's
// detached (a branch's HEAD adds nothing — switching branch changes no row).
function logStarts(head: RepoRefs['head']): string[] {
  return head.branch === null && head.oid !== null ? ['--branches', 'HEAD'] : ['--branches'];
}

export async function readRefs(cwd: string): Promise<RepoRefs> {
  const [heads, remoteRefs, head, remotes, fetchedAt] = await Promise.all([
    git(cwd, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads']),
    git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes']),
    readHead(cwd),
    git(cwd, ['remote']),
    lastFetchAt(cwd),
  ]);
  const branches = parseBranchRefs(heads, parseRefTips(remoteRefs));
  const hasRemote = remotes.trim() !== '';
  const unpushed = hasRemote && (branches.length > 0 || head.oid !== null)
    ? (await git(cwd, ['rev-list', '-n', String(MAX_UNPUSHED_SHAS), ...logStarts(head), '--not', '--remotes', '--'])).split('\n').filter(Boolean)
    : [];
  return {
    head,
    defaultBranch: await defaultBranch(cwd, new Set(branches.map((branch) => branch.name))),
    branches,
    unpushed,
    unpushedBase: hasRemote ? 'remotes' : 'none',
    fingerprint: await refsFingerprint(cwd, head.oid),
    lastFetchAt: fetchedAt,
  };
}

/** One page of the history; `cursor` from the page before, null for the first. */
export async function readLogPage(cwd: string, cursor: string | null, limit: number): Promise<RepoLogPage> {
  let skip = 0;
  let refs: RepoRefs | null = null;
  let head: RepoRefs['head'];
  let fingerprint: string;
  if (cursor === null) {
    refs = await readRefs(cwd);
    head = refs.head;
    fingerprint = refs.fingerprint;
  } else {
    const decoded = decodeCursor(cursor);
    head = await readHead(cwd);
    fingerprint = await refsFingerprint(cwd, head.oid);
    if (fingerprint !== decoded.fp) throw new RepoChangedError('a branch moved since the last page');
    skip = decoded.skip;
  }

  // Nothing to walk yet: no commit on any branch, HEAD unborn.
  const hasBranches = (await git(cwd, ['for-each-ref', '--count=1', '--format=x', 'refs/heads'])).trim() !== '';
  if (!hasBranches && head.oid === null) return { commits: [], nextCursor: null, refs };

  const out = await git(cwd, [
    'log', '-z', '--topo-order', `--format=${SUMMARY_FORMAT}`, `--skip=${skip}`, '-n', String(limit + 1), ...logStarts(head), '--',
  ]);
  const commits = parseLogSummaries(out);
  return {
    commits: commits.slice(0, limit),
    nextCursor: commits.length > limit ? encodeCursor({ skip: skip + limit, fp: fingerprint }) : null,
    refs,
  };
}
