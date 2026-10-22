import { realpath, readdir, stat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './config.js';

import type { DirEntry, DirListing, DirSearchEntry, DirSearch, SearchIncompleteReason } from './contract/fs.js';
export type { DirEntry, DirListing, DirSearchEntry, DirSearch, SearchIncompleteReason } from './contract/fs.js';

export class FsBrowserError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'NOT_A_DIRECTORY' | 'FORBIDDEN',
  ) {
    super(message);
  }
}

// Every caller is the single authenticated operator of this backend (see
// auth.ts), so the browsable root is intentionally the whole filesystem (the user's own
// workflow starts at $HOME and explicitly walks *up* past it). The only
// thing guarded against is `..`/symlink tricks producing a path outside of
// what `realpath` reports, and refusing to list a non-directory.
export async function listDirectory(requestedPath: string, basePath = '/'): Promise<DirListing> {
  const input = requestedPath && requestedPath.trim().length > 0 ? requestedPath : HOME;
  const expanded = input === '~' ? HOME : input.startsWith('~/') ? path.join(HOME, input.slice(2)) : input;
  const absolute = path.resolve(basePath, expanded);

  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FsBrowserError(`No such path: ${absolute}`, 'NOT_FOUND');
    }
    throw new FsBrowserError(`Cannot access: ${absolute}`, 'FORBIDDEN');
  }

  let dirents;
  try {
    dirents = await readdir(resolved, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') throw new FsBrowserError(`Not a directory: ${resolved}`, 'NOT_A_DIRECTORY');
    if (code === 'EACCES') throw new FsBrowserError(`Permission denied: ${resolved}`, 'FORBIDDEN');
    throw err;
  }

  const candidates = await Promise.all(
    dirents.map(async (d) => {
      const entryPath = path.join(resolved, d.name);
      if (d.isDirectory()) return { name: d.name, path: entryPath };
      if (!d.isSymbolicLink()) return null;
      // A symlink might point at a file, not a directory — only list it if
      // it resolves to a directory, and silently skip broken links.
      try {
        const target = await stat(entryPath);
        return target.isDirectory() ? { name: d.name, path: entryPath } : null;
      } catch {
        return null;
      }
    }),
  );

  const entries: DirEntry[] = candidates
    .filter((e): e is DirEntry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = resolved === path.parse(resolved).root ? null : path.dirname(resolved);

  return { path: resolved, parent, entries };
}

export type SearchOptions = { signal?: AbortSignal; maxDirectories?: number; maxEntries?: number; maxResults?: number; timeoutMs?: number };

/** Streams entries sequentially: a huge directory cannot fan out stat work. */
export async function searchDirectories(requestedPath: string, query: string, options: SearchOptions = {}): Promise<DirSearch> {
  const { signal, maxDirectories = 2000, maxEntries = 20000, maxResults = 100, timeoutMs = 1500 } = options;
  signal?.throwIfAborted();
  const expanded = requestedPath === '~' ? HOME : requestedPath.startsWith('~/') ? path.join(HOME, requestedPath.slice(2)) : requestedPath;
  let root: string;
  try { root = await realpath(path.resolve('/', expanded || HOME)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FsBrowserError(`No such path: ${requestedPath}`, 'NOT_FOUND');
    if (code === 'EACCES' || code === 'EPERM') throw new FsBrowserError(`Cannot access: ${requestedPath}`, 'FORBIDDEN');
    throw error;
  }
  const reasons = new Set<SearchIncompleteReason>();
  const entries: DirSearchEntry[] = [];
  const pending = [root];
  const deadline = Date.now() + timeoutMs;
  let directories = 0; let visitedEntries = 0;
  function bounded(): boolean {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) { reasons.add('timeout'); return true; }
    if (directories >= maxDirectories || visitedEntries >= maxEntries || entries.length >= maxResults) { reasons.add('limit'); return true; }
    return false;
  }
  while (pending.length && !bounded()) {
    const current = pending.shift()!;
    directories++;
    let handle;
    try { handle = await opendir(current); }
    catch (error) {
      if (current === root) throw new FsBrowserError(`Cannot read directory: ${root}`, (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'NOT_A_DIRECTORY' : 'FORBIDDEN');
      reasons.add('unreadable'); continue;
    }
    // opendir's iterator closes its handle even when limits break the loop.
    for await (const dirent of handle) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline || visitedEntries >= maxEntries || entries.length >= maxResults) { reasons.add(Date.now() >= deadline ? 'timeout' : 'limit'); break; }
      visitedEntries++;
      const entryPath = path.join(current, dirent.name);
      let isDirectory = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        try { isDirectory = (await stat(entryPath)).isDirectory(); }
        catch { reasons.add('unreadable'); continue; }
        if (isDirectory) reasons.add('symlink');
      }
      if (!isDirectory) continue;
      const relativePath = path.relative(root, entryPath).split(path.sep).join('/');
      if (relativePath.toLowerCase().includes(query.toLowerCase())) entries.push({ name: dirent.name, path: entryPath, relativePath });
      if (!dirent.isSymbolicLink()) pending.push(entryPath);
    }
  }
  signal?.throwIfAborted();
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { path: root, entries, complete: reasons.size === 0, incompleteReasons: [...reasons] };
}
