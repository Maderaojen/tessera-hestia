import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import type { ErrorCode } from './contract/errors.js';
import type { StorageEngine } from 'multer';
import { UPLOADS_DIR } from './config.js';

function positiveEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
export const UPLOAD_CONCURRENCY = positiveEnv('HESTIA_UPLOAD_CONCURRENCY', 2);
export const UPLOAD_TIMEOUT_MS = positiveEnv('HESTIA_UPLOAD_TIMEOUT_MS', 120_000);
const QUOTA = positiveEnv('HESTIA_UPLOAD_TOTAL_BYTES', 1024 * 1024 * 1024);
let active = 0;
let used: number | undefined;
let initialization: Promise<void> | undefined;

export class UploadResourceError extends Error {
  constructor(public status: number, public code: Extract<ErrorCode, 'upload_busy' | 'upload_quota_exceeded'>) { super(code); }
}

async function directoryBytes(dir: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    // Never follow links when counting or clearing app-owned temporary files.
    if (entry.isDirectory()) size += await directoryBytes(file);
    else if (entry.isFile()) size += (await lstat(file)).size;
  }
  return size;
}
async function initialize(): Promise<void> {
  await mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  const staging = path.join(UPLOADS_DIR, '.incoming');
  if ((await lstat(UPLOADS_DIR)).isSymbolicLink()) throw new Error('upload root cannot be a symbolic link');
  await chmod(UPLOADS_DIR, 0o700);
  // No upload runs before this finishes; leftovers belong to an interrupted prior process.
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  used = await directoryBytes(UPLOADS_DIR);
}
export async function acquireUpload(): Promise<() => void> {
  if (active >= UPLOAD_CONCURRENCY) throw new UploadResourceError(429, 'upload_busy');
  active++;
  try { await (initialization ??= initialize()); } catch (error) { active--; initialization = undefined; throw error; }
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}
export async function privateUploadDirectory(dir: string): Promise<void> {
  const relative = path.relative(UPLOADS_DIR, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid upload destination');
  let current = UPLOADS_DIR;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(current)).isDirectory()) throw new Error('upload destination must be a directory');
    await chmod(current, 0o700);
  }
}
const discarded = new WeakSet<Express.Multer.File>();
export async function discardUpload(file: Express.Multer.File): Promise<void> {
  if (discarded.has(file)) return;
  await rm(file.path, { force: true });
  discarded.add(file);
  used = Math.max(0, (used ?? 0) - file.size);
}

const commits = new WeakMap<Request, Promise<void>>();
const cancelled = new WeakSet<Request>();
const operations = new WeakMap<Request, { stream: NodeJS.ReadableStream & { destroy(error?: Error): void }; done: Promise<void> }>();
export async function cancelUpload(req: Request): Promise<void> {
  cancelled.add(req);
  const commit = commits.get(req);
  if (commit) { await commit.catch(() => {}); return; }
  const operation = operations.get(req);
  if (operation) {
    operation.stream.destroy(new Error('upload aborted'));
    await operation.done;
  } else if (req.file) {
    await discardUpload(req.file);
    delete req.file;
  }
}

export async function commitUpload(req: Request, file: Express.Multer.File, target: string): Promise<void> {
  const commit = (async () => {
    try {
      await privateUploadDirectory(path.dirname(target));
      if (cancelled.has(req)) throw new Error('upload aborted');
      await rename(file.path, target);
      file.path = target;
      if (cancelled.has(req)) throw new Error('upload aborted');
    } catch (error) { await discardUpload(file); throw error; }
  })();
  commits.set(req, commit);
  try { await commit; } finally { commits.delete(req); }
}

// Reserve bytes before passing each chunk to disk. A single process owns the
// state folder; both note and session routes use this same shared budget.
export const uploadStorage: StorageEngine = {
  _handleFile(req, file, callback) {
    if (cancelled.has(req) || req.aborted) { callback(new Error('upload aborted')); return; }
    const destination = path.join(UPLOADS_DIR, '.incoming');
    const filename = randomUUID();
    const target = path.join(destination, filename);
    let size = 0;
    const budget = new Transform({ transform(chunk: Buffer, _encoding, done) {
      if ((used ?? 0) + chunk.length > QUOTA) { done(new UploadResourceError(507, 'upload_quota_exceeded')); return; }
      used = (used ?? 0) + chunk.length;
      size += chunk.length;
      done(null, chunk);
    } });
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const done = pipeline(file.stream, budget, output).then(() => {
      callback(null, { destination, filename, path: target, size });
    }, async (error: Error) => {
      let failure = error;
      try {
        await rm(target, { force: true });
        used = Math.max(0, (used ?? 0) - size);
      } catch (cleanupError) { failure = cleanupError as Error; }
      // A failed removal leaves the bytes reserved. Always settle Multer.
      callback(failure);
    }).finally(() => { operations.delete(req); });
    operations.set(req, { stream: file.stream, done });
  },
  _removeFile(_req, file, callback) { void discardUpload(file).then(() => callback(null), callback); },
};
