import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFingerprint, sameFingerprint } from '../src/sync/tracker.js';

describe('SQLite transcript fingerprint', () => {
  it('detects new WAL content while the main DB stays unchanged', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-wal-fingerprint-'));
    try {
      const file = path.join(dir, 'conversation.db');
      await writeFile(file, 'db');
      const before = await readFingerprint(file);
      await writeFile(`${file}-wal`, 'first step');
      const after = await readFingerprint(file);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(sameFingerprint(before ?? undefined, after!)).toBe(false);
      await appendFile(`${file}-wal`, 'second step');
      expect(sameFingerprint(after ?? undefined, (await readFingerprint(file))!)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
