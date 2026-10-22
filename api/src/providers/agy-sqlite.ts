import { statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UUID_SHAPE } from '../ids.js';
import { isWrapper, type Msg } from './msg.js';

/** Verify filename and the single trajectory_meta.cascade_id row in read-only mode. */
export function verifyAgyDatabase(file: string, expectedId: string): 'verified' | 'not_found' | 'ambiguous' {
  if (!UUID_SHAPE.test(expectedId) || path.basename(file) !== `${expectedId}.db`) return 'ambiguous';
  let db: DatabaseSync | null = null;
  try {
    if (!statSync(file).isFile()) return 'ambiguous';
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT cascade_id FROM trajectory_meta').all();
    return rows.length === 1 && rows[0]?.cascade_id === expectedId ? 'verified' : 'ambiguous';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 'not_found';
    return 'ambiguous';
  } finally {
    db?.close();
  }
}

type WireField = { number: number; value: bigint | Buffer };

/** Minimal protobuf wire decoder for the two observed Agy 1.2.9 text fields. */
function fields(buffer: Buffer): WireField[] {
  let offset = 0;
  const readVarint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < buffer.length; shift += 7n) {
      const byte = buffer[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
    throw new Error('Invalid Agy protobuf varint');
  };
  const result: WireField[] = [];
  while (offset < buffer.length) {
    const key = Number(readVarint());
    const number = key >>> 3;
    const wireType = key & 7;
    if (number < 1) throw new Error('Invalid Agy protobuf field');
    if (wireType === 0) result.push({ number, value: readVarint() });
    else if (wireType === 1 || wireType === 5) {
      const size = wireType === 1 ? 8 : 4;
      if (offset + size > buffer.length) throw new Error('Truncated Agy protobuf field');
      offset += size;
    } else if (wireType === 2) {
      const size = Number(readVarint());
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) throw new Error('Truncated Agy protobuf field');
      result.push({ number, value: buffer.subarray(offset, offset + size) });
      offset += size;
    } else throw new Error('Unsupported Agy protobuf wire type');
  }
  return result;
}

function child(buffer: Buffer, field: number): Buffer | null {
  const value = fields(buffer).find((item) => item.number === field && Buffer.isBuffer(item.value))?.value;
  return Buffer.isBuffer(value) ? value : null;
}

function textAt(buffer: Buffer, outerField: number, innerField: number): string | null {
  const nested = child(buffer, outerField);
  const value = nested && child(nested, innerField);
  return value ? value.toString('utf8').trim() : null;
}

function timestampAt(payload: Buffer): string | null {
  // Step metadata field 5 contains create_time in field 1 (protobuf Timestamp).
  const metadata = child(payload, 5);
  const stamp = metadata && child(metadata, 1);
  if (!stamp) return null;
  const parts = fields(stamp);
  const seconds = parts.find((part) => part.number === 1)?.value;
  const nanos = parts.find((part) => part.number === 2)?.value;
  if (typeof seconds !== 'bigint' || typeof nanos !== 'bigint') return null;
  const millis = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1_000_000);
  if (!Number.isSafeInteger(millis)) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Read only prose rows from the observed Agy 1.2.9 steps schema. */
export function readAgyMessages(file: string): Msg[] {
  try { if (!statSync(file).isFile()) return []; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const id = path.basename(file).replace(/\.db$/, '');
  if (verifyAgyDatabase(file, id) !== 'verified') throw new Error('Agy transcript identity is not verified');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT step_type, status, step_payload FROM steps ORDER BY idx').all();
    const messages: Msg[] = [];
    for (const row of rows) {
      if (row.status !== 3 || !(row.step_payload instanceof Uint8Array)) continue;
      // Stopped on its quota: what Agy showed is the turn's reply, as a
      // Claude or Codex limit message is (readAgyQuotaStop below).
      const quota = row.step_type === AGY_ERROR_STEP ? quotaError(Buffer.from(row.step_payload)) : null;
      if (quota) {
        messages.push({ role: 'assistant', text: quota.message, ts: quota.at });
        continue;
      }
      const role = row.step_type === 14 ? 'user' : row.step_type === 15 ? 'assistant' : null;
      if (!role) continue;
      const payload = Buffer.from(row.step_payload);
      const value = textAt(payload, role === 'user' ? 19 : 20, role === 'user' ? 2 : 1);
      if (!value || isWrapper(value)) continue;
      messages.push({ role, text: value, ts: timestampAt(payload) });
    }
    return messages;
  } finally {
    db?.close();
  }
}

// Agy 1.2.17 stopping on its quota, as its database records it: no reply,
// but an error step (step_type 17) after the user's message, whose payload
// field 24.3 holds the shown message (1) and the API's own words (2):
//   1: "Individual quota reached. Please upgrade … Resets in 1h14m16s."
//   2: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. …"
// The reset is only said relative to the step's own time.
const AGY_ERROR_STEP = 17;
const AGY_USER_STEP = 14;
const AGY_REPLY_STEP = 15;
const QUOTA = /RESOURCE_EXHAUSTED \(code 429\)/;
const RESETS_IN = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;

export type AgyQuotaStop = { at: string | null; message: string; resetsAt: string | null };

function errorTexts(payload: Buffer): { shown: string | null; api: string | null } {
  const details = child(payload, 24);
  const error = details && child(details, 3);
  if (!error) return { shown: null, api: null };
  const text = (field: number) => child(error, field)?.toString('utf8').trim() || null;
  return { shown: text(1), api: text(2) };
}

function quotaError(payload: Buffer): AgyQuotaStop | null {
  const { shown, api } = errorTexts(payload);
  if (!api || !QUOTA.test(api)) return null;
  const at = timestampAt(payload);
  const message = shown ?? api;
  return { at, message, resetsAt: resetAfter(message, at) };
}

function resetAfter(message: string, at: string | null): string | null {
  const m = RESETS_IN.exec(message);
  if (!m || !at || !(m[1] || m[2] || m[3])) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return new Date(Date.parse(at) + seconds * 1000).toISOString();
}

/**
 * The last turn's end, when Agy stopped it on its quota: the error step
 * after the last user message, with no reply after it. null otherwise (a
 * turn still going, answered, or failed some other way).
 */
export function readAgyQuotaStop(file: string): AgyQuotaStop | null {
  try { if (!statSync(file).isFile()) return null; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const id = path.basename(file).replace(/\.db$/, '');
  if (verifyAgyDatabase(file, id) !== 'verified') return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT step_type, status, step_payload FROM steps ORDER BY idx').all();
    let stop: AgyQuotaStop | null = null;
    for (const row of rows) {
      if (row.step_type === AGY_USER_STEP || row.step_type === AGY_REPLY_STEP) stop = null;
      if (row.step_type !== AGY_ERROR_STEP || !(row.step_payload instanceof Uint8Array)) continue;
      stop = quotaError(Buffer.from(row.step_payload)) ?? stop;
    }
    return stop;
  } finally {
    db?.close();
  }
}
