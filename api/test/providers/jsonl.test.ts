import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonlLines } from '../../src/providers/jsonl.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'jsonl-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonlLines', () => {
  it('parses each non-empty line as JSON', async () => {
    const file = path.join(dir, 'x.jsonl');
    await writeFile(file, '{"a":1}\n{"a":2}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips blank lines', async () => {
    const file = path.join(dir, 'x.jsonl');
    await writeFile(file, '{"a":1}\n\n\n{"a":2}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips a malformed line instead of throwing', async () => {
    const file = path.join(dir, 'x.jsonl');
    await writeFile(file, '{"a":1}\nnot json at all\n{"a":2}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('tolerates a truncated trailing line from a mid-write poll', async () => {
    const file = path.join(dir, 'x.jsonl');
    await writeFile(file, '{"a":1}\n{"a":2,"b":"unterm', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }]);
  });

  it('returns an empty array when the file does not exist', async () => {
    expect(await readJsonlLines(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });
});

describe('readJsonlLines across reads of a growing file', () => {
  it('picks up appended lines, including a trailing line finished later', async () => {
    const file = path.join(dir, 'grow.jsonl');
    await writeFile(file, '{"a":1}\n{"a":2,"b":"unterm', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }]);
    await appendFile(file, 'inated"}\n{"a":3}', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }, { a: 2, b: 'unterminated' }, { a: 3 }]);
    await appendFile(file, '\n{"a":4}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }, { a: 2, b: 'unterminated' }, { a: 3 }, { a: 4 }]);
  });

  it('starts over when the file is rewritten rather than appended to', async () => {
    const file = path.join(dir, 'rewrite.jsonl');
    await writeFile(file, '{"a":1}\n{"a":2}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ a: 1 }, { a: 2 }]);
    await writeFile(file, '{"z":1}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ z: 1 }]);
    await writeFile(file, '{"y":1}\n{"y":2}\n{"y":3}\n', 'utf-8');
    expect(await readJsonlLines(file)).toEqual([{ y: 1 }, { y: 2 }, { y: 3 }]);
  });

  it('does not duplicate records when reads of one file overlap', async () => {
    const file = path.join(dir, 'concurrent.jsonl');
    await writeFile(file, '{"a":1}\n', 'utf-8');
    await readJsonlLines(file);
    await appendFile(file, '{"a":2}\n', 'utf-8');
    const [first, second] = await Promise.all([readJsonlLines(file), readJsonlLines(file)]);
    expect(first).toEqual([{ a: 1 }, { a: 2 }]);
    expect(second).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('returns empty once the file is gone', async () => {
    const file = path.join(dir, 'gone.jsonl');
    await writeFile(file, '{"a":1}\n', 'utf-8');
    await readJsonlLines(file);
    await rm(file);
    expect(await readJsonlLines(file)).toEqual([]);
  });
});
