import { stat } from 'node:fs/promises';
import { readJsonlLines } from '../providers/jsonl.js';
import { claudeProcessTurns } from './claude.js';
import { codexProcessTurns } from './codex.js';
import type { ProcessTurn } from './types.js';

export type ProcessProvider = 'claude' | 'codex';

export type TranscriptProcess =
  | { status: 'ok'; records: readonly unknown[]; turns: ProcessTurn[] }
  // The transcript file isn't there (any more).
  | { status: 'missing' };

// A conversation's detail is re-read every time its reply grows, which
// would re-read every turn's tools each time. So each transcript's turns
// are kept, and when the file has only grown, the turns that ended before
// the last one are kept as they are: only the last turn onwards is read
// again (from its user message's record). The records come from
// providers/jsonl.ts's cache, which itself only parses appended bytes; a
// file that was rewritten comes back as a new array, which starts over.
type Entry = {
  // The first record object: the same object while jsonl.ts still holds
  // the file as an append-only continuation.
  first: unknown;
  count: number;
  size: number;
  mtimeMs: number;
  turns: ProcessTurn[];
};

const MAX_CACHED = 8;
const cache = new Map<string, Entry>();

function parse(provider: ProcessProvider, records: readonly unknown[], offset: number): ProcessTurn[] {
  return provider === 'claude' ? claudeProcessTurns(records, offset) : codexProcessTurns(records, offset);
}

// `offset`: the first record that belongs to this conversation (a Codex
// subagent's rollout starts with a copy of its parent's history).
export async function readTranscriptProcess(file: string, provider: ProcessProvider, offset = 0): Promise<TranscriptProcess> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache.delete(key(file, provider, offset));
      return { status: 'missing' };
    }
    throw error;
  }
  const records = await readJsonlLines(file);
  const k = key(file, provider, offset);
  const entry = cache.get(k);
  let turns: ProcessTurn[];
  if (entry && entry.first === records[0] && entry.count === records.length && entry.size === info.size && entry.mtimeMs === info.mtimeMs) {
    turns = entry.turns;
  } else if (entry && entry.first === records[0] && entry.count <= records.length && entry.turns.length > 0) {
    const last = entry.turns.at(-1)!;
    turns = [...entry.turns.slice(0, -1), ...parse(provider, records, last.userSrc)];
  } else {
    turns = parse(provider, records, offset);
  }
  cache.delete(k);
  cache.set(k, { first: records[0], count: records.length, size: info.size, mtimeMs: info.mtimeMs, turns });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return { status: 'ok', records, turns };
}

function key(file: string, provider: ProcessProvider, offset: number): string {
  return `${provider}:${offset}:${file}`;
}

/** For tests. */
export function clearProcessCache(): void {
  cache.clear();
}
