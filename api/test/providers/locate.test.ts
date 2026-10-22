import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileExists, newestFileSince, walkFiles } from '../../src/providers/locate.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'locate-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fileExists', () => {
  it('true for a file that exists', async () => {
    const file = path.join(dir, 'x.txt');
    await writeFile(file, 'hi', 'utf-8');
    expect(await fileExists(file)).toBe(true);
  });

  it('false for a missing path', async () => {
    expect(await fileExists(path.join(dir, 'missing.txt'))).toBe(false);
  });
});

describe('walkFiles', () => {
  it('recursively finds files matching the predicate, ignoring others', async () => {
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'rollout-a.jsonl'), '', 'utf-8');
    await writeFile(path.join(dir, 'other.txt'), '', 'utf-8');
    await writeFile(path.join(dir, 'sub', 'rollout-b.jsonl'), '', 'utf-8');

    const found = await walkFiles(dir, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
    const names = found.map((f) => path.basename(f)).sort();
    expect(names).toEqual(['rollout-a.jsonl', 'rollout-b.jsonl']);
  });

  it('returns an empty array when the root does not exist', async () => {
    expect(await walkFiles(path.join(dir, 'nope'), () => true)).toEqual([]);
  });
});

describe('newestFileSince', () => {
  it('picks the file with the largest mtime at or after the cutoff', async () => {
    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    await writeFile(older, '', 'utf-8');
    await writeFile(newer, '', 'utf-8');
    const now = Date.now() / 1000;
    await utimes(older, now, now - 100);
    await utimes(newer, now, now - 10);

    const result = await newestFileSince([older, newer], Date.now() - 200_000);
    expect(result).toBe(newer);
  });

  it('excludes files older than the cutoff', async () => {
    const old = path.join(dir, 'old.jsonl');
    await writeFile(old, '', 'utf-8');
    const now = Date.now() / 1000;
    await utimes(old, now, now - 1000);

    const result = await newestFileSince([old], Date.now());
    expect(result).toBeNull();
  });

  it('returns null for an empty file list', async () => {
    expect(await newestFileSince([], 0)).toBeNull();
  });

  it('skips a file that disappears mid-scan rather than throwing', async () => {
    const result = await newestFileSince([path.join(dir, 'gone.jsonl')], 0);
    expect(result).toBeNull();
  });
});
