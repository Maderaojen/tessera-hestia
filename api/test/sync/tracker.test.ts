import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let tracker: typeof import('../../src/sync/tracker.js');

beforeEach(async () => {
  vi.resetModules();
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-tracker-'));
  tracker = await import('../../src/sync/tracker.js');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sync tracker', () => {
  it('keeps one tracker per session and creates it on first use', () => {
    const a = tracker.trackerFor('a');
    a.lastControlKeyAt = 5;
    expect(tracker.trackerFor('a').lastControlKeyAt).toBe(5);
    expect(tracker.trackerFor('b')).toEqual({});
  });

  it('resetTurnWatch clears only the current turn\'s clocks', () => {
    const t = tracker.trackerFor('s');
    t.waiting = { fingerprint: { mtimeMs: 1, size: 1 }, stableCount: 2, changedAt: 3 };
    t.paneIdleSince = 4;
    t.ready = { fingerprint: { mtimeMs: 1, size: 1 }, stableCount: 1, checked: true };
    t.lastControlKeyAt = 5;
    t.startupDead = { attemptKey: 'launch:x', since: 6 };

    tracker.resetTurnWatch('s');

    expect(t.waiting).toBeUndefined();
    expect(t.paneIdleSince).toBeUndefined();
    expect(t.ready).toEqual({ fingerprint: { mtimeMs: 1, size: 1 }, stableCount: 1, checked: true });
    expect(t.lastControlKeyAt).toBe(5);
    expect(t.startupDead).toEqual({ attemptKey: 'launch:x', since: 6 });
  });

  it('compares fingerprints by mtime and size, treating a missing one as different', () => {
    expect(tracker.sameFingerprint({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(true);
    expect(tracker.sameFingerprint({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 })).toBe(false);
    expect(tracker.sameFingerprint({ mtimeMs: 1, size: 2 }, { mtimeMs: 9, size: 2 })).toBe(false);
    expect(tracker.sameFingerprint(undefined, { mtimeMs: 1, size: 2 })).toBe(false);
  });

  it('reads a real file\'s fingerprint, and null when it is missing', async () => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, 'abc', 'utf-8');
    expect(await tracker.readFingerprint(file)).toMatchObject({ size: 3 });
    expect(await tracker.readFingerprint(path.join(dir, 'missing.jsonl'))).toBeNull();
  });
});
