import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeClaudeRetention } from '../../src/retention/claude.js';

// Only a throwaway folder: this writes Claude settings files.
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-retention-file-'));
  file = path.join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeClaudeRetention', () => {
  it('gives up when the file changes between writing the new one and putting it in place', async () => {
    await writeFile(file, '{\n  "theme": "dark"\n}\n');
    const changedMeanwhile = '{\n  "theme": "light"\n}\n';
    const result = await writeClaudeRetention(file, 180, null, { beforeRename: () => writeFile(file, changedMeanwhile) });
    expect(result).toBe('changed');
    expect(await readFile(file, 'utf8')).toBe(changedMeanwhile);
    // No leftover temporary file beside it.
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it.each([
    ['two spaces', '{\n  "theme": "dark"\n}\n', '{\n  "theme": "dark",\n  "cleanupPeriodDays": 90\n}\n'],
    ['four spaces', '{\n    "theme": "dark"\n}\n', '{\n    "theme": "dark",\n    "cleanupPeriodDays": 90\n}\n'],
    ['a tab', '{\n\t"theme": "dark"\n}\n', '{\n\t"theme": "dark",\n\t"cleanupPeriodDays": 90\n}\n'],
    ['no final line break', '{\n  "theme": "dark"\n}', '{\n  "theme": "dark",\n  "cleanupPeriodDays": 90\n}'],
    ['one line', '{"theme":"dark"}', '{"theme":"dark","cleanupPeriodDays":90}'],
  ])('keeps the file laid out as it was (%s)', async (_name, before, after) => {
    await writeFile(file, before);
    expect(await writeClaudeRetention(file, 90, null)).toBe('written');
    expect(await readFile(file, 'utf8')).toBe(after);
  });

  it('starts a missing file with two spaces and a final line break', async () => {
    expect(await writeClaudeRetention(file, 90, null)).toBe('written');
    expect(await readFile(file, 'utf8')).toBe('{\n  "cleanupPeriodDays": 90\n}\n');
  });
});
