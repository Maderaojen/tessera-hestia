// A project's files and git, read-only.
// Every call names one of the project's registered paths as `root`; every
// path in a request or response is relative to that root, POSIX-style.
// Needs the `repo_view` capability (meta.ts).

/** Where HEAD is, and how it stands against its upstream. */
export type RepoBranchState = {
  // The branch name; null when detached or before the first commit.
  head: string | null;
  // HEAD's sha; null before the first commit.
  oid: string | null;
  detached: boolean;
  // A branch with no commit yet.
  unborn: boolean;
  // e.g. 'origin/main'; null when the branch tracks nothing.
  upstream: string | null;
  // Counted against the upstream as of the last fetch; null without one.
  ahead: number | null;
  behind: number | null;
};

/** One of the project's paths, as git sees it: GET /projects/:id/repos. */
export type RepoRoot = {
  path: string;
  primary: boolean;
  // false when the folder is gone from this host.
  exists: boolean;
  // null when the path isn't inside a git work tree.
  repo: null | {
    toplevel: string;
    // Where the root sits in the repo: '' at its top, else 'sub/dir/'.
    prefix: string;
    branch: RepoBranchState;
    // Uncommitted entries under the root, untracked ones included.
    changedCount: number;
    // When the repo last fetched (FETCH_HEAD's time); null if never.
    lastFetchAt: string | null;
  };
  // Why git couldn't read it, when it couldn't (repo is null then):
  // dubious_ownership = the repo belongs to another user.
  repoError: null | 'timeout' | 'dubious_ownership' | 'error';
  // Set on a delegation's or a branch line's worktree, listed after the
  // project's own paths while it exists; it isn't one of them.
  spawn?: { kind: 'delegation' | 'fork'; id: string; title: string; branch: string | null } | null;
};

export type RepoRootsResponse = { roots: RepoRoot[] };

/** What a worktree is for, when Hestia made it: a delegation's or a branch line's. */
export type RepoWorktreeSpawn = {
  kind: 'delegation' | 'fork';
  id: string;
  title: string;
  // A delegation's DelegationStatus, a branch line's ForkStatus.
  status: string;
  // A delegation accepted, rejected or stopped; a branch line closed or
  // given up starting.
  ended: boolean;
  // What cleaning it up now would be refused for; null when it would go
  // through. Only read once it has ended. A delegation's worktree goes
  // with an unmerged branch (the branch stays); a branch line's only with
  // a merged one.
  cleanupBlocked: null | 'workspace_dirty' | 'branch_not_merged';
  // Its own session.
  sessionId: string | null;
};

/**
 * One worktree of the repo a root is in.
 * Only what it is, never what is in it: a worktree that isn't one of the
 * roots the git view reads is listed, not opened (`root` null).
 */
export type RepoWorktree = {
  // Its top folder, as git gives it.
  path: string;
  // The repo's main checkout (listed first).
  main: boolean;
  // Holds the root it was asked about.
  current: boolean;
  // Short name; null when detached.
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  // false when its folder is gone (git says it can be pruned).
  exists: boolean;
  // Uncommitted entries, untracked ones included; null when unknown.
  changedCount: number | null;
  // Its branch merged into the repo's HEAD (a delegation's or branch line's:
  // the repo it was cut from, as cleaning up asks); null for the main
  // checkout, a detached one, or unknown.
  merged: boolean | null;
  // The root the git view opens it as; null when it doesn't read it.
  root: string | null;
  spawn: RepoWorktreeSpawn | null;
};

/**
 * GET /projects/:id/repo/worktrees?root= — `endedKept`: Hestia's own that
 * are over but still there; at `endedKeptWarnAt` or more, the user is
 * told to clean up.
 */
export type RepoWorktreesResponse = { worktrees: RepoWorktree[]; endedKept: number; endedKeptWarnAt: number };

export type RepoChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';

/** One uncommitted entry. */
export type RepoFileChange = {
  // Relative to the root; an untracked folder ends with '/'.
  path: string;
  // A rename or copy's source.
  origPath: string | null;
  // The index against HEAD (staged).
  staged: RepoChangeKind | null;
  // The work tree against the index; untracked and conflicted go here.
  unstaged: RepoChangeKind | null;
  submodule: boolean;
};

export type RepoCommitSummary = {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string; // ISO
  subject: string;
};

/** GET /projects/:id/repo/status?root= */
export type RepoStatus = {
  root: string;
  prefix: string;
  branch: RepoBranchState;
  lastFetchAt: string | null;
  // At most 2000; filesTruncated says there were more.
  files: RepoFileChange[];
  filesTruncated: boolean;
  // What "not pushed" is counted against: the branch's upstream; with none,
  // every remote; 'none' when the repo has no remote at all.
  unpushedBase: 'upstream' | 'remotes' | 'none';
  // Newest first, at most 100.
  unpushed: RepoCommitSummary[];
  unpushedTruncated: boolean;
  // Changes whenever a local branch or HEAD moves.
  refsFingerprint: string;
};

/**
 * What a diff compares: worktree = HEAD against the work tree (everything
 * `commit -a` would take); staged = HEAD against the index; unstaged = the
 * index against the work tree; commit = a commit against its first parent.
 */
export type RepoDiffMode = 'worktree' | 'staged' | 'unstaged' | 'commit';

export type RepoDiffLine = {
  kind: 'context' | 'add' | 'del' | 'note';
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type RepoDiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: RepoDiffLine[];
};

/** GET /projects/:id/repo/diff?root=&path=&orig=&mode=&commit= */
export type RepoDiff = {
  path: string;
  origPath: string | null;
  mode: RepoDiffMode;
  status: RepoChangeKind | null;
  binary: boolean;
  // Cut at 5000 lines or 512 KiB of patch.
  truncated: boolean;
  hunks: RepoDiffHunk[];
};

/** A file a commit changed. */
export type RepoCommitFile = {
  // Relative to the root; a file elsewhere in the repo starts with '../'
  // and has outsideRoot set (listed, but no diff).
  path: string;
  origPath: string | null;
  status: RepoChangeKind;
  // null for a binary file.
  additions: number | null;
  deletions: number | null;
  outsideRoot: boolean;
};

/** GET /projects/:id/repo/commit?root=&sha= */
export type RepoCommitDetail = RepoCommitSummary & {
  committerName: string;
  committedAt: string; // ISO
  // The whole message.
  message: string;
  // Against the first parent (a merge too), at most 1000.
  files: RepoCommitFile[];
  filesTruncated: boolean;
};

/** One entry of a folder in the file tree. */
export type RepoTreeEntry = {
  name: string;
  // Relative to the root.
  path: string;
  // submodule: a folder that is a repo of its own (has its own .git).
  type: 'dir' | 'file' | 'symlink' | 'submodule';
  // Bytes, for a file; null otherwise.
  size: number | null;
  // Matched by .gitignore and not tracked; always false outside a repo.
  ignored: boolean;
  // A symlink's target: inside the root, a dir or a file to open; 'outside'
  // leads out of the root and 'broken' to nothing — neither opens.
  linkTarget?: 'dir' | 'file' | 'broken' | 'outside';
  // Likely holds secrets (fs-guard isSensitivePath: .env, keys, credentials, a
  // .ssh or .aws folder…): listed, never opened — repo/file and repo/diff
  // answer path_sensitive. Absent when not.
  sensitive?: true;
};

/** GET /projects/:id/repo/tree?root=&dir=&ignored= */
export type RepoTreeListing = {
  root: string;
  // The folder listed, relative to the root ('' for the root itself).
  dir: string;
  // Whether the root is in a git work tree; the tree works either way.
  isRepo: boolean;
  // Folders first, then by name; at most 3000, truncated says there were more.
  entries: RepoTreeEntry[];
  truncated: boolean;
};

/** GET /projects/:id/repo/file?root=&path=&rev= */
export type RepoFileContent = {
  path: string;
  // The commit it was read from (rev=HEAD or a sha, e.g. for a deleted
  // file); null for the file as it is in the work tree.
  rev: string | null;
  size: number;
  // A NUL byte in its first 8000 bytes: not shown.
  binary: boolean;
  // Over 1 MiB: not sent.
  tooLarge: boolean;
  // null when binary or tooLarge.
  text: string | null;
};

/** A local branch, as the history marks it. */
export type RepoBranchRef = {
  name: string;
  tip: string;
  // Short, e.g. 'origin/main'; null when it tracks nothing.
  upstream: string | null;
  // Where the upstream is, as of the last fetch; null without one, or when
  // it's gone from the remote.
  upstreamTip: string | null;
  ahead: number | null;
  behind: number | null;
  // Tracks a branch the remote no longer has.
  upstreamGone: boolean;
};

/** The local branches and HEAD, for drawing the history. */
export type RepoRefs = {
  // branch null: detached (oid set) or no commit yet (oid null too).
  head: { branch: string | null; oid: string | null };
  // Always the leftmost lane; null when none can be told (no main/master…).
  defaultBranch: string | null;
  branches: RepoBranchRef[];
  // Commits a local branch (or a detached HEAD) has that no remote does,
  // at most 1000.
  unpushed: string[];
  unpushedBase: 'remotes' | 'none';
  // Changes whenever a local branch or HEAD moves.
  fingerprint: string;
  lastFetchAt: string | null;
};

/**
 * GET /projects/:id/repo/log?root=&cursor=&limit= — the local branches'
 * history (plus a detached HEAD's), newest first in topological order, a
 * page at a time (default 200, at most 500). `refs` comes with the first
 * page only; a cursor from before a branch moved answers 409 repo_changed.
 */
export type RepoLogPage = {
  commits: RepoCommitSummary[];
  nextCursor: string | null;
  refs: RepoRefs | null;
};
