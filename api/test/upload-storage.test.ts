import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ removal: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (failure.removal && String(args[0]).includes(`${path.sep}.incoming${path.sep}`)) throw new Error('cleanup blocked');
    return actual.rm(...args);
  } };
});

function incomingFile(stream: PassThrough): Express.Multer.File {
  return { stream, fieldname: 'file', originalname: 'x.txt', encoding: '7bit', mimetype: 'text/plain', size: 0, destination: '', filename: '', path: '', buffer: Buffer.alloc(0) };
}
let root: string;
let storage: typeof import('../src/upload-storage.js');
beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(path.join(os.tmpdir(), 'hestia-storage-'));
  vi.stubEnv('HESTIA_STATE_DIR', root);
  vi.stubEnv('HESTIA_UPLOAD_TOTAL_BYTES', '16');
  vi.stubEnv('HESTIA_UPLOAD_CONCURRENCY', '1');
  storage = await import('../src/upload-storage.js');
});
afterEach(async () => { failure.removal = false; vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

function upload(bytes: string) {
  const req = new EventEmitter() as Request;
  const stream = new PassThrough();
  const result = new Promise<Partial<Express.Multer.File>>((resolve, reject) => {
    storage.uploadStorage._handleFile(req, incomingFile(stream), (error, info) => error ? reject(error) : resolve(info!));
  });
  stream.end(bytes);
  return result;
}

describe('shared upload storage budget', () => {
  it('counts existing files at startup and rolls back a rejected partial file', async () => {
    const uploads = path.join(root, 'uploads');
    await mkdir(uploads);
    await writeFile(path.join(uploads, 'existing'), '12345678');
    const release = await storage.acquireUpload();
    await expect(upload('123456789')).rejects.toMatchObject({ status: 507, code: 'upload_quota_exceeded' });
    expect(await readdir(path.join(uploads, '.incoming'))).toEqual([]);
    const accepted = await upload('12345678');
    expect(await readFile(accepted.path!, 'utf8')).toBe('12345678');
    release();
  });
  it('settles the parser and conservatively retains quota if partial-file removal fails', async () => {
    const release = await storage.acquireUpload();
    const req = new EventEmitter() as Request;
    const stream = new PassThrough();
    const result = new Promise((resolve) => storage.uploadStorage._handleFile(req, incomingFile(stream), (error) => resolve(error)));
    failure.removal = true;
    stream.write('12345678');
    stream.end('123456789');
    expect(await result).toMatchObject({ message: 'cleanup blocked' });
    failure.removal = false;
    await expect(upload('123456789')).rejects.toMatchObject({ code: 'upload_quota_exceeded' });
    expect((await upload('12345678')).size).toBe(8);
    release();
  });
  it('shares admission and makes release idempotent', async () => {
    const release = await storage.acquireUpload();
    await expect(storage.acquireUpload()).rejects.toMatchObject({ status: 429 });
    release(); release();
    const next = await storage.acquireUpload();
    await expect(storage.acquireUpload()).rejects.toMatchObject({ status: 429 });
    next();
  });
  it('cancels an active write and returns its reserved quota after cleanup', async () => {
    const release = await storage.acquireUpload();
    const req = new EventEmitter() as Request;
    const stream = new PassThrough();
    const result = new Promise((resolve) => storage.uploadStorage._handleFile(req, incomingFile(stream), (error) => resolve(error)));
    stream.write('12345678');
    await storage.cancelUpload(req);
    expect(await result).toBeInstanceOf(Error);
    expect(await readdir(path.join(root, 'uploads', '.incoming'))).toEqual([]);
    expect((await upload('1234567890123456')).size).toBe(16);
    release();
  });
  it('refuses storage after cancellation before a file arrived', async () => {
    const req = new EventEmitter() as Request;
    await storage.cancelUpload(req);
    const result = new Promise((resolve) => storage.uploadStorage._handleFile(req, incomingFile(new PassThrough()), (error) => resolve(error)));
    expect(await result).toBeInstanceOf(Error);
  });
  it('never follows symbolic-link destinations', async () => {
    const release = await storage.acquireUpload();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'uploads', 'notes'));
    await expect(storage.privateUploadDirectory(path.join(root, 'uploads', 'notes'))).rejects.toThrow('directory');
    expect(await readdir(outside)).toEqual([]);
    release();
  });
});
