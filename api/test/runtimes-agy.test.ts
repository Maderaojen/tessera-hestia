import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { agyRuntime, observeAgySession } from '../src/runtimes/agy.js';
import { verifyAgyDatabase } from '../src/providers/agy-sqlite.js';

const ID = 'f4ce1dff-6f84-46af-b4ac-b11c631d69cd';
const OTHER = '6811bfb5-405a-48ff-a883-5f9a22e563a5';
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function varint(value: number): number[] {
  const bytes: number[] = [];
  do { bytes.push((value & 127) | (value >= 128 ? 128 : 0)); value >>>= 7; } while (value);
  return bytes;
}
function bytes(field: number, value: Uint8Array | string): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return Buffer.from([...varint(field * 8 + 2), ...varint(payload.length), ...payload]);
}
function number(field: number, value: number): Buffer { return Buffer.from([...varint(field * 8), ...varint(value)]); }
const timestamp = bytes(5, bytes(1, Buffer.concat([number(1, 1000), number(2, 0)])));
function fixture(cascadeId: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-reader-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, `${ID}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('trajectory', cascadeId);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(0, 14, 3, Buffer.concat([timestamp, bytes(19, bytes(2, 'hello'))]));
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.concat([timestamp, bytes(20, bytes(1, 'world'))]));
  db.close();
  return { dir, file };
}

describe('Agy 1.2.9 transcript identity', () => {
  it('accepts only an ID-matched SQLite transcript and reads its prose', async () => {
    const { dir, file } = fixture(ID);
    expect(verifyAgyDatabase(file, ID)).toBe('verified');
    expect(await agyRuntime.locateSessionFile({ cwd: '/unrelated', providerSessionId: ID, launchedAfter: new Date(0).toISOString(), conversationRoot: dir }))
      .toEqual({ status: 'resolved', file, identity: 'verified_metadata' });
    expect(await agyRuntime.parseTurns(file)).toEqual([{ index: 1, user: { text: 'hello', at: '1970-01-01T00:16:40.000Z' }, assistant: { text: 'world', at: '1970-01-01T00:16:40.000Z' } }]);
  });

  it('rejects a DB whose internal cascade ID conflicts with its filename', async () => {
    const { dir, file } = fixture(OTHER);
    expect(verifyAgyDatabase(file, ID)).toBe('ambiguous');
    expect(await agyRuntime.locateSessionFile({ cwd: dir, providerSessionId: ID, launchedAfter: new Date(0).toISOString(), conversationRoot: dir }))
      .toEqual({ status: 'ambiguous' });
    await expect(agyRuntime.parseMessages(file)).rejects.toThrow('identity is not verified');
  });

  it('does not infer an active ID from a same-cwd DB when the process has no matching fd', async () => {
    const { dir } = fixture(ID);
    // This test process is not agy; point it at the fixture root anyway.
    expect((await observeAgySession({ pid: process.pid, conversationRoot: dir })).status).toBe('pending');
  });
});

// Agy 1.2.17 stopping on its quota: an error step, no reply.
describe('Agy quota stop', () => {
  const at = (seconds: number) => bytes(5, bytes(1, Buffer.concat([number(1, seconds), number(2, 0)])));
  const shown = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h14m16s.';
  const quota = (seconds: number) => Buffer.concat([at(seconds), bytes(24, bytes(3, Buffer.concat([bytes(1, shown), bytes(2, `RESOURCE_EXHAUSTED (code 429): ${shown}`)])))]);
  const otherError = Buffer.concat([at(1100), bytes(24, bytes(3, Buffer.concat([bytes(1, 'Something else'), bytes(2, 'INTERNAL (code 500): Something else')])))]);
  function quotaFixture(steps: [type: number, payload: Buffer][]): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-quota-test-'));
    tempDirs.push(dir);
    const file = path.join(dir, `${ID}.db`);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('trajectory', ID);
    steps.forEach(([type, payload], idx) => db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(idx, type, 3, payload));
    db.close();
    return file;
  }
  const user = (text: string, seconds: number) => Buffer.concat([at(seconds), bytes(19, bytes(2, text))]);
  const reply = (text: string, seconds: number) => Buffer.concat([at(seconds), bytes(20, bytes(1, text))]);

  it('ends the turn with what Agy showed, and reads the hit and its reset', async () => {
    const file = quotaFixture([[14, user('write the brief', 1000)], [17, quota(1001)]]);
    expect(await agyRuntime.parseTurns(file)).toEqual([{ index: 1, user: { text: 'write the brief', at: '1970-01-01T00:16:40.000Z' }, assistant: { text: shown, at: '1970-01-01T00:16:41.000Z' } }]);
    expect(await agyRuntime.isTurnComplete(file)).toEqual({ status: 'supported', value: true });
    expect(await agyRuntime.readLimitHit!(file)).toEqual({
      at: '1970-01-01T00:16:41.000Z', scope: 'unknown', limitType: 'individual_quota', model: null,
      resetsAt: new Date((1001 + 3600 + 14 * 60 + 16) * 1000).toISOString(), message: shown, ruleId: 'agy/individual-quota',
    });
  });

  it('says nothing once a later message is sent or answered, nor of other errors', async () => {
    const answered = quotaFixture([[14, user('a', 1000)], [17, quota(1001)], [14, user('b', 1002)], [15, reply('done', 1003)]]);
    expect(await agyRuntime.readLimitHit!(answered)).toBeNull();
    expect(await agyRuntime.isTurnComplete(answered)).toEqual({ status: 'unknown' });
    const waiting = quotaFixture([[14, user('a', 1000)], [17, quota(1001)], [14, user('b', 1002)]]);
    expect(await agyRuntime.readLimitHit!(waiting)).toBeNull();
    const other = quotaFixture([[14, user('a', 1000)], [17, otherError]]);
    expect(await agyRuntime.readLimitHit!(other)).toBeNull();
    expect(await agyRuntime.isTurnComplete(other)).toEqual({ status: 'unknown' });
  });
});
