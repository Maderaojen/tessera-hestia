import { readFile } from 'node:fs/promises';
import { REGISTRY_PATH } from '../config.js';
import * as projectStore from '../project-store.js';
import { writeFileAtomic } from '@maderaojen/json-file-store';
import * as sessionStream from '../session-stream.js';
import { isTrashed, type ManagedSession } from '../types.js';
import { toPublicManagedSession } from '../session-dto.js';
import { encodeSession, migrateLoadedRegistry } from './migrations.js';

// The registry's memory and its file (registry.json) move together: a change
// is visible to readers and published only once it is on disk. A failed
// write throws to its caller and leaves memory exactly as it was, so memory
// and disk never disagree.

let sessions: ReadonlyMap<string, ManagedSession> = new Map();
let loaded = false;
let loading: Promise<void> | null = null;
// Every change runs after the previous one has been written, each against
// the sessions that write left, so no change is computed from a state
// another one is about to replace (no lost updates), and the file receives
// the writes in order.
let changes: Promise<unknown> = Promise.resolve();

export async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  loading = load();
  try {
    await loading;
    loaded = true;
  } finally {
    loading = null;
  }
}

async function load(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(REGISTRY_PATH, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const migrated = await migrateLoadedRegistry(JSON.parse(raw) as unknown[]);
  const numberCounts = new Map<string, number>();
  for (const session of migrated.sessions) numberCounts.set(session.projectId, (numberCounts.get(session.projectId) ?? 0) + 1);
  await projectStore.seedSessionNumbers(numberCounts);
  const next = new Map(migrated.sessions.map((session) => [session.id, session]));
  // Written back before anyone sees it, so a failed write leaves the old
  // file and nothing half-migrated in memory; the next caller reloads.
  if (migrated.changed) await writeFileAtomic(REGISTRY_PATH, serialize(next));
  sessions = next;
}

function serialize(map: ReadonlyMap<string, ManagedSession>): string {
  return JSON.stringify([...map.values()].map(encodeSession), null, 2);
}

export async function get(id: string): Promise<ManagedSession | undefined> {
  await ensureLoaded();
  return sessions.get(id);
}

export async function list(): Promise<ManagedSession[]> {
  await ensureLoaded();
  return [...sessions.values()];
}

/** What one change decided: its caller's result, and the records to write or drop. */
export type Change<R> = { result: R; write?: ManagedSession[]; remove?: string[] };

/**
 * Runs `decide` against the latest committed sessions, then writes what it
 * returned. Only after the write succeeds does memory change and each
 * written session get published; on failure the error reaches the caller
 * and nothing changed. `decide` must be synchronous and must not call back
 * into the registry (it would wait on itself).
 */
export async function transact<R>(decide: (current: ReadonlyMap<string, ManagedSession>) => Change<R>): Promise<R> {
  await ensureLoaded();
  const run = changes.then(async () => {
    const { result, write = [], remove = [] } = decide(sessions);
    if (write.length === 0 && remove.length === 0) return result;
    const next = new Map(sessions);
    for (const session of write) next.set(session.id, session);
    for (const id of remove) next.delete(id);
    await writeFileAtomic(REGISTRY_PATH, serialize(next));
    const before = sessions;
    sessions = next;
    // A record in the trash is gone as far as any listener is concerned —
    // the write that trashed it, and any late one (an in-flight transition
    // finishing after the delete), reads as a delete. The write that takes
    // it back out says so (`restored`), so a list that has seen it deleted
    // knows to take it back, where a plain update must not revive it.
    for (const session of write) {
      const previous = before.get(session.id);
      sessionStream.publish(session.id, isTrashed(session)
        ? { type: 'deleted' }
        : { type: previous && isTrashed(previous) ? 'restored' : 'update', session: toPublicManagedSession(session) });
    }
    for (const id of remove) sessionStream.publish(id, { type: 'deleted' });
    return result;
  });
  // One failed change must not wedge the later, unrelated ones.
  changes = run.catch(() => {});
  return run;
}

/**
 * The common case of transact: one session, whose next state `decide`
 * computes from its current one. Returning no `next` writes nothing.
 */
export function commit<R>(
  id: string,
  decide: (current: ManagedSession | undefined) => { next?: ManagedSession; result: R },
): Promise<R> {
  return transact((current) => {
    const { next, result } = decide(current.get(id));
    return next ? { result, write: [next] } : { result };
  });
}

export function __resetStoreForTests(): void {
  sessions = new Map();
  loaded = false;
  loading = null;
  changes = Promise.resolve();
}
