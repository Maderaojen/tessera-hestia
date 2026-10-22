import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsBrowserError, listDirectory, searchDirectories } from '../src/fs-browser.js';

let root: string;

beforeEach(async () => {
  // Real path: listings resolve symlinks (macOS's tmpdir is behind /var -> /private/var).
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fs-browser-test-')));
  await mkdir(path.join(root, 'child-dir'));
  await writeFile(path.join(root, 'a-file.txt'), 'hi');
  await symlink(path.join(root, 'child-dir'), path.join(root, 'link-to-dir'));
  await symlink(path.join(root, 'a-file.txt'), path.join(root, 'link-to-file'));
  await symlink(path.join(root, 'does-not-exist'), path.join(root, 'broken-link'));
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true }));
});

describe('listDirectory', () => {
  it('lists real subdirectories, resolved symlinked dirs, and excludes files/broken links', async () => {
    const listing = await listDirectory(root);
    const names = listing.entries.map((e) => e.name).sort();
    expect(names).toEqual(['child-dir', 'link-to-dir']);
  });

  it('reports the parent directory', async () => {
    const listing = await listDirectory(root);
    expect(listing.parent).toBe(path.dirname(root));
  });

  it('throws NOT_FOUND for a missing path', async () => {
    await expect(listDirectory(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_A_DIRECTORY when pointed at a file', async () => {
    await expect(listDirectory(path.join(root, 'a-file.txt'))).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
  });

  it('is an instance of FsBrowserError on failure', async () => {
    try {
      await listDirectory(path.join(root, 'nope'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FsBrowserError);
    }
  });
});

 describe('searchDirectories', () => {
  it('matches deep contiguous relative paths and excludes files', async () => {
    await mkdir(path.join(root, 'dev-tools', 'hestia'), { recursive: true });
    const result = await searchDirectories(root, 'TOOLS/HEST');
    expect(result.entries.map((e) => e.relativePath)).toEqual(['dev-tools/hestia']);
    expect(result.complete).toBe(false); // fixture includes a skipped symlink subtree
    expect(result.incompleteReasons).toContain('symlink');
  });
  it('marks bounded searches incomplete instead of proving uniqueness', async () => {
    const result = await searchDirectories(root, 'child', { maxEntries: 1 });
    expect(result.complete).toBe(false);
    expect(result.incompleteReasons).toContain('limit');
  });
  it('honours an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(searchDirectories(root, 'x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('validates home and relative direct paths against an explicit base', async () => {
    expect((await listDirectory('../child-dir', path.join(root, 'child-dir'))).path).toBe(path.join(root, 'child-dir'));
  });
 });

describe('search completeness', () => {
  it('proves unique leaf only for an entirely read search scope', async () => {
    const clean = path.join(root, 'clean'); await mkdir(path.join(clean, 'deep', 'leaf'), { recursive: true });
    const result = await searchDirectories(clean, 'EAF');
    expect(result).toMatchObject({ complete: true, incompleteReasons: [] });
    expect(result.entries.map(e => e.relativePath)).toEqual(['deep/leaf']);
  });
  it.each([{ maxDirectories: 1 }, { maxResults: 1 }, { timeoutMs: 0 }])('reports incomplete for bound %j', async (options) => {
    const result = await searchDirectories(root, 'dir', options);
    expect(result.complete).toBe(false);
    expect(result.incompleteReasons.length).toBeGreaterThan(0);
  });
  it('includes a matching directory symlink without following a cycle', async () => {
    await symlink(root, path.join(root, 'loop'));
    const result = await searchDirectories(root, 'loop');
    expect(result.entries.map(e => e.relativePath)).toEqual(['loop']);
    expect(result.incompleteReasons).toContain('symlink');
  });
});
