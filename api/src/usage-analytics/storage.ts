import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEvent, ParserState } from './parsers.js';

export type Source = { id: string; accountId: string; label: string; provider: 'claude' | 'codex'; root: string };
export type Binding = { provider: 'claude' | 'codex'; sessionId: string; startedAt: string; endedAt: string | null; projectId: string; projectLabel: string; tmuxId: string; tmuxLabel: string; accountId: string | null };
export type StoredEvent = UsageEvent & { accountId: string; sourceId: string; projectId: string | null; projectLabel: string | null; tmuxId: string | null; tmuxLabel: string | null };
export type Cursor = { offset: number; size: number; mtime: number; inode: string; state: ParserState; prefixLength?: number; prefixHash?: string; warnings?: string[] };

export function openLedger(file: string) {
  if (file !== ':memory:') { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); chmodSync(path.dirname(file), 0o700); }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') chmodSync(file, 0o600);
  try { db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, account_id TEXT NOT NULL, provider TEXT NOT NULL, project_id TEXT, tmux_id TEXT, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_time ON events(timestamp);
    CREATE INDEX IF NOT EXISTS events_account ON events(account_id,timestamp);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cursors (file TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, body TEXT NOT NULL);`); } catch (error) { db.close(); throw error; }
  db.prepare("INSERT OR IGNORE INTO metadata(id,body) VALUES('schemaVersion','1')").run();
  const get = (table: string, id: string): unknown => { const row = db.prepare(`SELECT body FROM ${table} WHERE ${table === 'cursors' ? 'file' : 'id'}=?`).get(id); return row ? JSON.parse(String(row.body)) : null; };
  const put = (table: string, id: string, body: unknown) => db.prepare(`INSERT INTO ${table} (${table === 'cursors' ? 'file' : 'id'},body) VALUES (?,?) ON CONFLICT (${table === 'cursors' ? 'file' : 'id'}) DO UPDATE SET body=excluded.body`).run(id, JSON.stringify(body));
  return {
    close() { db.close(); },
    transaction(work: () => void) { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    sources(): Source[] { return db.prepare('SELECT body FROM sources').all().map((r) => JSON.parse(String(r.body)) as Source); },
    saveSource(source: Source) { put('sources', source.id, source); },
    cursor(file: string): Cursor | null { return get('cursors', file) as Cursor | null; },
    saveCursor(file: string, cursor: Cursor) { put('cursors', file, cursor); },
    metadata<T>(id: string): T | null { return get('metadata', id) as T | null; },
    saveMetadata(id: string, data: unknown) { put('metadata', id, data); },
    bindings(): Binding[] { return db.prepare('SELECT body FROM bindings').all().map((r) => JSON.parse(String(r.body)) as Binding); },
    saveBindings(bindings: Binding[]) { for (const binding of bindings) put('bindings', JSON.stringify([binding.provider, binding.sessionId, binding.tmuxId, binding.startedAt]), binding); },
    upsert(event: StoredEvent) {
      const before = get('events', event.id) as StoredEvent | null;
      const known = (value: string | null | undefined): value is string => Boolean(value && value !== 'unknown');
      const pricingFields = ['model', 'serviceTier', 'inferenceGeo'] as const;
      if (before && pricingFields.some((field) => known(before[field]) && known(event[field]) && before[field] !== event[field])) return 'conflicting_usage_snapshot';
      const isMonotonic = !before || ['input', 'output', 'cached', 'cacheWrite', 'reasoning'].every((field) => event[field as 'input'] >= before[field as 'input']);
      const counters = isMonotonic ? event : before!;
      // A copied reply can improve counters without proving the original
      // account/session has the copying source's project or tmux binding.
      const attribution = before && (before.accountId !== event.accountId || before.sessionId !== event.sessionId) ? before : event;
      const merged = before ? { ...counters, sessionId: before.sessionId, timestamp: before.timestamp < event.timestamp ? before.timestamp : event.timestamp,
        input: counters.input, cached: counters.cached, cacheWrite: counters.cacheWrite, output: counters.output, reasoning: counters.reasoning, cacheWrite1h: counters.cacheWrite1h,
        accountId: before.accountId, sourceId: before.sourceId, projectId: before.projectId ?? attribution.projectId, projectLabel: before.projectLabel ?? attribution.projectLabel, tmuxId: before.tmuxId ?? attribution.tmuxId, tmuxLabel: before.tmuxLabel ?? attribution.tmuxLabel } : event;
      // Missing metadata in a streamed/replayed snapshot cannot erase a
      // known price dimension. Only unknown-to-known enrichment is safe.
      if (before) for (const field of pricingFields) {
        const oldValue = before[field], newValue = event[field];
        if (known(oldValue)) merged[field] = oldValue;
        else if (known(newValue)) merged[field] = newValue;
      }
      db.prepare('INSERT INTO events (id,timestamp,account_id,provider,project_id,tmux_id,body) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp,project_id=excluded.project_id,tmux_id=excluded.tmux_id,body=excluded.body')
        .run(merged.id, merged.timestamp, merged.accountId, merged.provider, merged.projectId, merged.tmuxId, JSON.stringify(merged));
      return before && before.accountId !== event.accountId ? 'conflicting_usage_source' : !isMonotonic ? 'conflicting_usage_snapshot' : null;
    },
    eventsBetween(from: string, to: string): StoredEvent[] { return db.prepare('SELECT body FROM events WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,id').all(from,to).map((r) => JSON.parse(String(r.body)) as StoredEvent); },
    allEvents(): StoredEvent[] { return db.prepare('SELECT body FROM events ORDER BY timestamp,id').all().map((r) => JSON.parse(String(r.body)) as StoredEvent); },
  };
}
