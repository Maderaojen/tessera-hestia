import { open } from 'node:fs/promises';

// Transcripts are append-only and re-read every poll, several times per
// tick, and a long one runs to tens of MB — a full read + parse each time
// held the event loop for ~100ms per call. So each file's parsed records
// are cached, and a later read parses only the bytes appended since.
// Anything that doesn't look like a pure append (different inode, shorter
// file, changed head, no line break where the last read stopped) starts
// over from scratch.
type Entry = {
  dev: number;
  ino: number;
  head: Buffer;
  // Bytes consumed so far: always just past a '\n', so every record in
  // `records` came from a complete line.
  offset: number;
  records: unknown[];
};

const HEAD_BYTES = 64;
const MAX_CACHED_FILES = 8;
const cache = new Map<string, Entry>();
// Concurrent reads of one file (e.g. parseMessages + parseFollowUps under
// Promise.all) must not both append the same new bytes to one entry.
const inflight = new Map<string, Promise<readonly unknown[]>>();

function parseLines(text: string, out: unknown[]): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
}

async function readFrom(filePath: string): Promise<readonly unknown[]> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    cache.delete(filePath);
    return [];
  }
  try {
    const st = await handle.stat();
    const headLen = Math.min(HEAD_BYTES, st.size);
    const head = Buffer.alloc(headLen);
    await handle.read(head, 0, headLen, 0);

    let entry = cache.get(filePath);
    if (entry) {
      let appendOnly = entry.dev === st.dev && entry.ino === st.ino && st.size >= entry.offset
        && head.subarray(0, entry.head.length).equals(entry.head);
      if (appendOnly && entry.offset > 0) {
        const prev = Buffer.alloc(1);
        await handle.read(prev, 0, 1, entry.offset - 1);
        appendOnly = prev[0] === 0x0a;
      }
      if (!appendOnly) entry = undefined;
    }
    if (!entry) entry = { dev: st.dev, ino: st.ino, head, offset: 0, records: [] };
    if (entry.head.length < headLen) entry.head = head;

    const buf = Buffer.alloc(st.size - entry.offset);
    const { bytesRead } = buf.length > 0 ? await handle.read(buf, 0, buf.length, entry.offset) : { bytesRead: 0 };
    const chunk = buf.subarray(0, bytesRead);
    // Only whole lines go into the cache; splitting on the '\n' byte never
    // cuts a UTF-8 sequence. A trailing unterminated line may still be
    // mid-write, so it is parsed for this read only (a malformed or
    // truncated one is skipped, as always) and re-read next time.
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      parseLines(chunk.toString('utf-8', 0, lastNewline + 1), entry.records);
      entry.offset += lastNewline + 1;
    }
    cache.delete(filePath);
    cache.set(filePath, entry);
    while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);

    const tail: unknown[] = [];
    parseLines(chunk.toString('utf-8', lastNewline + 1), tail);
    return tail.length ? [...entry.records, ...tail] : entry.records;
  } finally {
    await handle.close();
  }
}

// Tolerant JSONL reader: a transcript can be mid-write while we poll it, so
// a malformed or truncated trailing line is skipped rather than failing
// the whole read. The returned array may be shared with later calls; never
// mutate it.
export function readJsonlLines(filePath: string): Promise<readonly unknown[]> {
  const run = (inflight.get(filePath) ?? Promise.resolve([]))
    .catch(() => [])
    .then(() => readFrom(filePath));
  inflight.set(filePath, run);
  void run.finally(() => {
    if (inflight.get(filePath) === run) inflight.delete(filePath);
  }).catch(() => undefined);
  return run;
}

// Just the records in the last `bytes` of a file, for a check that only
// needs where a transcript ends (e.g. a usage-limit hit) and runs on every
// session often. The first line may be cut and is then skipped. null when
// the file can't be read.
export async function readTailRecords(filePath: string, bytes = 64 * 1024): Promise<unknown[] | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const records: unknown[] = [];
    parseLines(buffer.toString('utf-8'), records);
    return records;
  } finally {
    await handle.close();
  }
}

// Just a file's first record (its first line, read up to `maxBytes`), for a
// check that only needs a transcript's header. null when the file can't be
// read or its first line isn't a whole JSON record within that.
export async function readFirstRecord(filePath: string, maxBytes = 256 * 1024): Promise<unknown> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    return JSON.parse(buffer.toString('utf-8', 0, end < 0 ? bytesRead : end)) as unknown;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
