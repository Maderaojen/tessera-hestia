import type { RepoFileContent } from './repo.js';

// Local files a session's chat mentions, opened from the chat
// (docs/specs/chat-file-links.md; capability session_files). Only the
// user's login may call these, never the local tool token. A path is read
// only inside the session's allowed roots — its cwd, its project's paths,
// the project's delegation and branch line worktrees, and its own worktree —
// never through `..`, a symlink out, a `.git` folder, the backend's own
// state, or a file that likely holds secrets (fs-guard isSensitivePath).

export const FILE_REFS_MAX_PATHS = 50;
export const FILE_REF_MAX_LENGTH = 1024;
export const RAW_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** POST /sessions/:id/file-refs */
export type FileRefsRequest = {
  // As written in the chat: absolute or relative, with an optional :12,
  // :12:3, #L12 or #L12-L20 suffix, or a file:// URL. At most 50, each at
  // most 1024 characters.
  paths: string[];
};

/**
 * - file: a regular file inside an allowed root (the only one a client links);
 * - outside: not inside any allowed root (or leads out of one);
 * - missing: inside, but nothing there;
 * - not_file: a folder or something else;
 * - blocked: likely holds secrets, or the backend's own state — decided
 *   before anything is looked at on disk.
 */
export type FileRefStatus = 'file' | 'outside' | 'missing' | 'not_file' | 'blocked';

export type FileRefKind = 'text' | 'image' | 'binary_or_large';

export type FileRefResult = {
  input: string;
  status: FileRefStatus;
  // With status 'file' (root also with 'missing' and 'not_file'):
  // the allowed root it is under, as registered;
  root?: string;
  // the absolute path (the root's own spelling, then the path under it);
  path?: string;
  // relative to the root, POSIX-style;
  relative?: string;
  line?: number;
  col?: number;
  size?: number;
  // image: one GET /files/raw serves (png, jpeg, gif, webp, avif, bmp, ico,
  // up to 10 MB); binary_or_large: a known binary extension or over 1 MiB
  // (its metadata only); text: anything else (GET /files says if it turns
  // out binary).
  kind?: FileRefKind;
  // The root is one the project files and git view opens (a project path,
  // or a delegation's or branch line's worktree): the client can hand the
  // file over to it with `root` and `relative`.
  repoRoot?: boolean;
};

/** POST /sessions/:id/file-refs: one result per distinct input, in order. Never any contents. */
export type FileRefsResponse = { refs: FileRefResult[] };

/** GET /sessions/:id/files?path= — RepoFileContent (path is relative to root), plus where it is. */
export type SessionFileContent = RepoFileContent & {
  root: string;
  relative: string;
  // The absolute path, as in FileRefResult.
  absolute: string;
  repoRoot: boolean;
};
