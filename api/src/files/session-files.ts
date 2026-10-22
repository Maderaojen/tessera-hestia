import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileRefKind, FileRefResult, SessionFileContent } from '../contract/session-files.js';
import { RAW_IMAGE_MAX_BYTES } from '../contract/session-files.js';
import { FileGuardError, isSensitivePath, isWithin, MAX_FILE_BYTES, parseFileReference, readBoundedFile, type ResolvedPath } from '@maderaojen/fs-guard';
import { isDeniedPath } from './denied-paths.js';
import * as projectStore from '../project-store.js';
import { resolveInsideRoot } from './repo-paths.js';
import { spawned, spawnRoots } from '../spawn/roots.js';
import type { ManagedSession } from '../types.js';

// Local files a session's chat mentions:
// which folders it may read (allowedRoots), what a path written in the chat
// names there (resolveFileRef), and reading one (readSessionFile,
// openSessionImage). Every read goes through the project files view's fence
// (repo-paths.ts resolveInsideRoot: realpath, symlinks out, .git, the
// backend's own state, sensitive files) and is checked again when the file
// is actually opened.

export type AllowedRoot = {
  // As registered (the project path, the session's cwd, …).
  path: string;
  real: string;
  // The project files and git view opens it (a project path or a spawn root).
  repoRoot: boolean;
  kind: 'cwd' | 'project' | 'spawn' | 'worktree';
  primary: boolean;
};

async function realOf(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * The folders a session's file links may read: its cwd, its project's
 * paths, the project's delegation and branch line worktrees, and the top of
 * its own worktree when it is a delegate or a branch line. One per
 * realpath; a folder that is also a project path or spawn root keeps that
 * root (repoRoot). The backend's own state and denied folders never count.
 */
export async function allowedRoots(session: Pick<ManagedSession, 'id' | 'cwd' | 'projectId'>): Promise<AllowedRoot[]> {
  const project = await projectStore.getProject(session.projectId);
  const candidates: Omit<AllowedRoot, 'real'>[] = [];
  for (const entry of project && !project.deletedAt ? [...project.paths].sort((a, b) => Number(b.primary) - Number(a.primary)) : []) {
    candidates.push({ path: entry.path, repoRoot: true, kind: 'project', primary: entry.primary });
  }
  for (const entry of await spawnRoots(session.projectId)) candidates.push({ path: entry.path, repoRoot: true, kind: 'spawn', primary: false });
  candidates.push({ path: session.cwd, repoRoot: false, kind: 'cwd', primary: false });
  for (const entry of await spawned()) {
    if (entry.removed || entry.sessionId !== session.id || !entry.workspace.worktree) continue;
    candidates.push({ path: entry.workspace.worktree, repoRoot: false, kind: 'worktree', primary: false });
  }
  const roots: AllowedRoot[] = [];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate.path) || isDeniedPath(candidate.path)) continue;
    const real = await realOf(candidate.path);
    if (!real || isDeniedPath(real)) continue;
    const same = roots.find((root) => root.real === real);
    if (same) {
      // The session's cwd that is a project path: the cwd stays first to
      // try for relative paths, the root is the project's.
      if (candidate.kind === 'cwd') same.kind = 'cwd';
      continue;
    }
    roots.push({ ...candidate, real });
  }
  return roots;
}

// The images a file link shows as images: what a browser draws by itself.
// Not the uploads' table (attachments.ts IMAGE_TYPES), which takes what a
// phone's camera writes, HEIC included, for the CLI to read.
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};

// Extensions whose files are never text worth showing.
const BINARY_EXTENSIONS = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'pdf', 'exe', 'dll', 'so', 'dylib', 'o', 'a',
  'class', 'pyc', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wav',
  'flac', 'ogg', 'm4a', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'psd', 'heic', 'tif', 'tiff', 'iso', 'dmg', 'apk', 'ipa',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'node',
]);

function extensionOf(target: string): string {
  const name = path.basename(target).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

export function imageTypeOf(target: string): string | null {
  return IMAGE_TYPES[extensionOf(target)] ?? null;
}

function kindOf(target: string, size: number): FileRefKind {
  if (imageTypeOf(target) && size <= RAW_IMAGE_MAX_BYTES) return 'image';
  if (BINARY_EXTENSIONS.has(extensionOf(target)) || imageTypeOf(target) || size > MAX_FILE_BYTES) return 'binary_or_large';
  return 'text';
}

type Located = { root: AllowedRoot; resolved: ResolvedPath };
type LocateResult =
  | { status: 'found'; located: Located }
  | { status: 'outside' }
  | { status: 'blocked' }
  | { status: 'missing'; root: AllowedRoot; resolved: ResolvedPath };

// Under one root: the fence, or why not.
async function inside(root: AllowedRoot, relative: string): Promise<ResolvedPath | 'outside' | 'blocked'> {
  try {
    return await resolveInsideRoot(root.real, relative);
  } catch (error) {
    if (error instanceof FileGuardError) return error.code === 'outside' ? 'outside' : 'blocked';
    throw error;
  }
}

function under(absolute: string, base: string): string | null {
  return isWithin(absolute, base) ? path.relative(base, absolute) : null;
}

/** Which root a path names a file under: an absolute one by the deepest root holding it, a relative one tried from the cwd, the primary path, then the rest. */
async function locate(target: string, roots: AllowedRoot[]): Promise<LocateResult> {
  if (isSensitivePath(target)) return { status: 'blocked' };
  if (path.isAbsolute(target)) {
    const absolute = path.resolve(target);
    if (isDeniedPath(absolute)) return { status: 'blocked' };
    const holding = roots
      .map((root) => {
        const viaPath = under(absolute, path.resolve(root.path));
        const viaReal = under(absolute, root.real);
        const relative = viaPath ?? viaReal;
        return relative === null ? null : { root, relative, depth: (viaPath !== null ? path.resolve(root.path) : root.real).length };
      })
      .filter((entry): entry is { root: AllowedRoot; relative: string; depth: number } => entry !== null)
      .sort((a, b) => b.depth - a.depth);
    let missing: LocateResult | null = null;
    for (const { root, relative } of holding) {
      const resolved = await inside(root, relative);
      if (resolved === 'blocked') return { status: 'blocked' };
      if (resolved === 'outside') continue;
      if (resolved.exists) return { status: 'found', located: { root, resolved } };
      missing ??= { status: 'missing', root, resolved };
    }
    return missing ?? { status: 'outside' };
  }
  const order = [...roots.filter((root) => root.kind === 'cwd'), ...roots.filter((root) => root.kind !== 'cwd' && root.primary), ...roots.filter((root) => root.kind !== 'cwd' && !root.primary)];
  let missing: LocateResult | null = null;
  for (const root of order) {
    const resolved = await inside(root, target);
    if (resolved === 'blocked') return { status: 'blocked' };
    if (resolved === 'outside') continue;
    if (resolved.exists) return { status: 'found', located: { root, resolved } };
    missing ??= { status: 'missing', root, resolved };
  }
  return missing ?? { status: 'outside' };
}

function absoluteOf(root: AllowedRoot, relative: string): string {
  return relative ? path.join(root.path, relative) : root.path;
}

/** What one input names: stat only, never contents. */
export async function resolveFileRef(input: string, roots: AllowedRoot[]): Promise<FileRefResult> {
  const parsed = parseFileReference(input);
  if (!parsed) return { input, status: 'outside' };
  const where = { ...(parsed.line ? { line: parsed.line } : {}), ...(parsed.col ? { col: parsed.col } : {}) };
  const found = await locate(parsed.path, roots);
  if (found.status === 'outside' || found.status === 'blocked') return { input, status: found.status };
  const { root, resolved } = found.status === 'found' ? found.located : { root: found.root, resolved: found.resolved };
  const base = { input, root: root.path, path: absoluteOf(root, resolved.relative), relative: resolved.relative, repoRoot: root.repoRoot, ...where };
  if (found.status === 'missing') return { ...base, status: 'missing' };
  let info;
  try {
    info = await stat(resolved.absolute);
  } catch {
    return { ...base, status: 'missing' };
  }
  if (!info.isFile()) return { ...base, status: 'not_file' };
  return { ...base, status: 'file', size: info.size, kind: kindOf(resolved.absolute, info.size) };
}

export class SessionFileError extends Error {
  constructor(public readonly code: 'outside' | 'blocked' | 'missing' | 'not_file' | 'unsupported_media' | 'too_large', message: string) {
    super(message);
  }
}

async function locateFile(input: string, roots: AllowedRoot[]): Promise<Located> {
  const parsed = parseFileReference(input);
  if (!parsed) throw new SessionFileError('outside', 'not a path this session can read');
  const found = await locate(parsed.path, roots);
  if (found.status === 'outside') throw new SessionFileError('outside', 'path outside the session\'s folders');
  if (found.status === 'blocked') throw new SessionFileError('blocked', 'path may hold secrets');
  if (found.status === 'missing') throw new SessionFileError('missing', `no such file: ${found.resolved.relative}`);
  return found.located;
}

// Opened, then checked again: what was opened is still the file the fence
// passed (a symlink swapped in between would differ by realpath or inode).
async function openChecked(located: Located) {
  const handle = await open(located.resolved.absolute, 'r').catch(() => {
    throw new SessionFileError('missing', `no such file: ${located.resolved.relative}`);
  });
  try {
    const real = await realpath(located.resolved.absolute);
    const relativeReal = path.relative(located.root.real, real);
    if (!isWithin(real, located.root.real) || relativeReal.split(path.sep).some((segment) => segment.toLowerCase() === '.git')) {
      throw new SessionFileError('outside', 'path outside the session\'s folders');
    }
    if (isSensitivePath(relativeReal) || isDeniedPath(real)) throw new SessionFileError('blocked', 'path may hold secrets');
    const [opened, current] = await Promise.all([handle.stat(), stat(real)]);
    if (opened.ino !== current.ino || opened.dev !== current.dev) throw new SessionFileError('outside', 'the file changed while it was opened');
    if (!opened.isFile()) throw new SessionFileError('not_file', `not a file: ${located.resolved.relative}`);
    return { handle, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** GET /sessions/:id/files: a file's text as the project files view sends it, checked again now. */
export async function readSessionFile(input: string, roots: AllowedRoot[]): Promise<SessionFileContent> {
  const located = await locateFile(input, roots);
  const { handle } = await openChecked(located);
  try {
    const content = await readBoundedFile(handle, located.resolved.relative);
    return {
      path: located.resolved.relative,
      rev: null,
      ...content,
      root: located.root.path,
      relative: located.resolved.relative,
      absolute: absoluteOf(located.root, located.resolved.relative),
      repoRoot: located.root.repoRoot,
    };
  } finally {
    await handle.close();
  }
}

/** GET /sessions/:id/files/raw: an image's bytes and type; anything else is unsupported_media. */
export async function readSessionImage(input: string, roots: AllowedRoot[]): Promise<{ type: string; bytes: Buffer }> {
  const located = await locateFile(input, roots);
  const type = imageTypeOf(located.resolved.absolute);
  if (!type) throw new SessionFileError('unsupported_media', 'only images are served raw');
  const { handle, size } = await openChecked(located);
  try {
    if (size > RAW_IMAGE_MAX_BYTES) throw new SessionFileError('too_large', 'image over 10 MB');
    return { type, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}
