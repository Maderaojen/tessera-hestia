import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RepoFileContent, RepoTreeEntry, RepoTreeListing } from './contract/repo.js';
import { resolveCommit, type RepoInfo } from './git/repo-reader.js';
import { git, gitBytes, GitError } from './git/run.js';
import { classifyContent, FileGuardError, isSensitivePath, isWithin, MAX_FILE_BYTES, readBoundedFile, type ResolvedPath } from '@maderaojen/fs-guard';

// The project's files, folder by folder, and one file's contents. Paths arrive already
// fenced by repo-paths.ts; this only reads. A root outside any git work
// tree still lists and opens — it just has nothing ignored.

export const MAX_TREE_ENTRIES = 3000;
function joinRelative(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

async function describe(rootReal: string, dirAbsolute: string, name: string, relative: string, dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Promise<RepoTreeEntry | null> {
  const absolute = path.join(dirAbsolute, name);
  if (dirent.isSymbolicLink()) {
    let linkTarget: RepoTreeEntry['linkTarget'];
    try {
      const real = await realpath(absolute);
      if (!isWithin(real, rootReal)) linkTarget = 'outside';
      else linkTarget = (await stat(real)).isDirectory() ? 'dir' : 'file';
    } catch {
      linkTarget = 'broken';
    }
    return { name, path: relative, type: 'symlink', size: null, ignored: false, linkTarget };
  }
  if (dirent.isDirectory()) {
    // A folder with a .git of its own (file or folder) is a nested repo.
    const nested = await lstat(path.join(absolute, '.git')).then(() => true, () => false);
    return { name, path: relative, type: nested ? 'submodule' : 'dir', size: null, ignored: false };
  }
  if (dirent.isFile()) {
    const size = await lstat(absolute).then((info) => info.size, () => null);
    return { name, path: relative, type: 'file', size, ignored: false };
  }
  // Sockets, fifos, devices: nothing to show.
  return null;
}

// Which of `paths` (relative to the root, folders ending in '/') .gitignore
// matches. Tracked files never count, as check-ignore without --no-index
// leaves them out. It reads its input as pathspecs and can't be told to
// take them literally, so a path starting with ':' (magic) isn't asked.
async function ignoredAmong(rootReal: string, paths: string[]): Promise<Set<string>> {
  const asked = paths.filter((entry) => !entry.startsWith(':'));
  if (asked.length === 0) return new Set();
  let out: string;
  try {
    out = await git(rootReal, ['check-ignore', '-z', '--stdin'], { okExitCodes: [1], input: `${asked.join('\0')}\0`, literalPathspecs: false });
  } catch (error) {
    // e.g. a path inside a nested repo or past a symlink, which
    // check-ignore refuses: then nothing is known to be ignored, rather
    // than no listing at all.
    if (error instanceof GitError && error.kind === 'failed') return new Set();
    throw error;
  }
  return new Set(out.split('\0').filter(Boolean));
}

/** One folder under the root. `dir` is fenced; `showIgnored` keeps ignored entries. */
export async function listRepoDirectory(rootReal: string, root: string, isRepo: boolean, dir: ResolvedPath, showIgnored: boolean): Promise<RepoTreeListing> {
  if (!dir.exists) throw new FileGuardError('not_found', `no such folder: ${dir.relative}`);
  if (!(await stat(dir.absolute)).isDirectory()) throw new FileGuardError('not_a_directory', `not a folder: ${dir.relative}`);

  const dirents = (await readdir(dir.absolute, { withFileTypes: true })).filter((dirent) => dirent.name !== '.git');
  const described = await Promise.all(dirents.map((dirent) => describe(rootReal, dir.absolute, dirent.name, joinRelative(dir.relative, dirent.name), dirent)));
  // Listed, never opened (repo-paths.ts refuses them).
  let entries = described.filter((entry): entry is RepoTreeEntry => entry !== null)
    .map((entry) => (isSensitivePath(entry.path) ? { ...entry, sensitive: true as const } : entry));

  if (isRepo) {
    // Not a nested repo: check-ignore refuses the whole batch over one
    // path inside another repo.
    const asked = entries.filter((entry) => entry.type !== 'submodule').map((entry) => (entry.type === 'dir' ? `${entry.path}/` : entry.path));
    // Everything inside an ignored folder is ignored too, which
    // check-ignore doesn't always say of each entry by itself.
    if (dir.relative) asked.push(`${dir.relative}/`);
    const ignored = await ignoredAmong(rootReal, asked);
    const insideIgnored = dir.relative !== '' && ignored.has(`${dir.relative}/`);
    entries = entries.map((entry) => ({
      ...entry,
      ignored: insideIgnored || ignored.has(entry.path) || ignored.has(`${entry.path}/`),
    }));
    if (!showIgnored) entries = entries.filter((entry) => !entry.ignored);
  }

  const isFolder = (entry: RepoTreeEntry) => entry.type === 'dir' || entry.type === 'submodule' || entry.linkTarget === 'dir';
  entries.sort((a, b) => (isFolder(a) === isFolder(b) ? a.name.localeCompare(b.name) : isFolder(a) ? -1 : 1));
  return {
    root,
    dir: dir.relative,
    isRepo,
    entries: entries.slice(0, MAX_TREE_ENTRIES),
    truncated: entries.length > MAX_TREE_ENTRIES,
  };
}

/** A file as it is in the work tree. */
export async function readWorkingFile(file: ResolvedPath): Promise<RepoFileContent> {
  if (!file.exists) throw new FileGuardError('not_found', `no such file: ${file.relative}`);
  const handle = await open(file.absolute, 'r');
  try {
    return { path: file.relative, rev: null, ...(await readBoundedFile(handle, file.relative)) };
  } finally {
    await handle.close();
  }
}

/**
 * A file as it was in a commit (`rev` = 'HEAD' or a hex sha, already
 * validated) — e.g. one deleted since. The path is relative to the root;
 * git wants it relative to the repo's top, hence the prefix.
 */
export async function readCommittedFile(rootReal: string, info: RepoInfo, rev: string, file: ResolvedPath): Promise<RepoFileContent> {
  const { sha } = await resolveCommit(rootReal, rev);
  const object = `${sha}:${info.prefix}${file.relative}`;
  let type: string;
  try {
    type = (await git(rootReal, ['cat-file', '-t', '--end-of-options', object])).trim();
  } catch (error) {
    if (error instanceof GitError && error.kind === 'failed') throw new FileGuardError('not_found', `no ${file.relative} in ${sha}`);
    throw error;
  }
  if (type !== 'blob') throw new FileGuardError('not_a_file', `not a file in ${sha}: ${file.relative}`);
  const size = Number((await git(rootReal, ['cat-file', '-s', '--end-of-options', object])).trim());
  if (size > MAX_FILE_BYTES) return { path: file.relative, rev: sha, size, binary: false, tooLarge: true, text: null };
  const bytes = await gitBytes(rootReal, ['cat-file', 'blob', '--end-of-options', object]);
  return { path: file.relative, rev: sha, ...classifyContent(bytes, size) };
}
