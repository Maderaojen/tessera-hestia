import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { UsageQuery, UsageTotals, UsageGroup, UsageScanStatus, UsageCoverage, UsageSummary, UsageFacets, UsageDayDetail } from '../contract/usage-analytics.js';
import { estimateCost, PRICING_VERSION } from './pricing.js';
import { scanSource } from './scanner.js';
import { openLedger, type Source, type Binding, type StoredEvent } from './storage.js';
import { t } from '../i18n/index.js';

export type UsageAnalyticsOptions = { dbPath: string; discoverSources: () => Promise<{ sources: Source[]; warnings: string[] }>; readBindings?: () => Promise<Binding[]>; now?: () => Date };
export function validateUsageQuery(query: UsageQuery): void {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(query.from) || !validDate(query.to)) throw new Error('invalid_date');
  const span = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
  if (span < 1 || span > 400) throw new Error('invalid_range');
  try { new Intl.DateTimeFormat('en', { timeZone: query.timezone }).format(); } catch { throw new Error('invalid_timezone'); }
  for (const value of [query.accountId, query.provider, query.projectId, query.tmuxId]) if (value !== undefined && (typeof value !== 'string' || value.length < 1 || value.length > 200)) throw new Error('invalid_filter');
}
export function createUsageAnalytics(options: UsageAnalyticsOptions) {
  // The subsystem opens its own store only when used; importing routes must
  // never prevent unrelated chat routes from starting if this file fails.
  let ledger: ReturnType<typeof openLedger> | null = null;
  const store = () => ledger ??= openLedger(options.dbPath);
  const now = options.now ?? (() => new Date());
  let running: Promise<void> | null = null;
  let warnings = new Set<string>();
  let available: Set<string> | null = null;
  let status: UsageScanStatus | null = null;
  function state(): UsageScanStatus {
    if (!status) status = store().metadata<UsageScanStatus>('status') ?? { state: 'idle', revision: 0, updatedAt: null, lastError: null, filesScanned: 0 };
    return { ...status, state: running ? 'scanning' : status.state };
  }
  async function refresh(): Promise<void> {
    if (running) return running;
    const task = (async () => {
      const db = store();
      const before = state();
      status = { ...before, state: 'scanning', lastError: null, filesScanned: 0 };
      const currentWarnings = new Set<string>(['local_logs_only', 'source_profiles_not_verified_login_identity', `pricing:${PRICING_VERSION}`, 'quota_not_collected']);
      try {
        const discovery = await options.discoverSources();
        discovery.warnings.forEach((w) => currentWarnings.add(w));
        available = new Set();
        const seenRoots = new Set<string>();
        const sources: Source[] = [];
        for (const candidate of discovery.sources) {
          try {
            const canonical = await realpath(candidate.root);
            const rootKey = `${candidate.provider}:${canonical}`;
            if (seenRoots.has(rootKey)) { currentWarnings.add('duplicate_source_alias'); continue; }
            seenRoots.add(rootKey);
            // Root identity stays fixed when a profile is renamed. Do not
            // rewrite old account attribution using today's label or email.
            const id = createHash('sha256').update(rootKey).digest('hex');
            const historical = db.sources().find((s) => s.id === id);
            const source = historical ? { ...historical, root: canonical } : { ...candidate, id, root: canonical };
            db.saveSource(source); sources.push(source); available!.add(source.id);
          } catch { currentWarnings.add('source_unavailable'); }
        }
        const bindings = await options.readBindings?.() ?? [];
        db.saveBindings(bindings.filter((binding) => binding.accountId !== null));
        const savedBindings = db.bindings();
        let completedSources = 0;
        for (const source of sources) {
          try { status.filesScanned += await scanSource(source, db, savedBindings, currentWarnings); completedSources++; }
          catch { currentWarnings.add('source_scan_failed'); }
          await setImmediate();
        }
        if (sources.length === 0 && currentWarnings.has('source_unavailable') || sources.length > 0 && completedSources === 0 && currentWarnings.has('source_scan_failed')) throw new Error('all_sources_failed');
        warnings = currentWarnings;
        status = { ...status, state: 'idle', revision: before.revision + 1, updatedAt: now().toISOString(), lastError: null };
        db.saveMetadata('available', [...available!]); db.saveMetadata('warnings', [...warnings]); db.saveMetadata('status', status);
      } catch {
        warnings = currentWarnings; warnings.add('collection_failed');
        if (available) db.saveMetadata('available', [...available]);
        status = { ...before, state: 'error', lastError: t('usage.scan.failed') };
        db.saveMetadata('warnings', [...warnings]); db.saveMetadata('status', status);
      }
    })();
    running = task;
    try { await task; } finally { running = null; }
  }
  function coverage(events: StoredEvent[]): UsageCoverage {
    const persisted = store().metadata<string[]>('warnings') ?? [];
    return { firstEventAt: events[0]?.timestamp ?? null, lastEventAt: events.at(-1)?.timestamp ?? null,
      unattributedRequests: events.filter((e) => !e.tmuxId).length, warnings: [...new Set([...persisted, ...warnings])] };
  }
  function totals(events: StoredEvent[]): UsageTotals {
    const result: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, requestCount: events.length, sessionCount: new Set(events.map((e) => `${e.provider}:${e.sessionId}`)).size, costUsd: 0, unpricedRequests: 0 };
    for (const event of events) {
      result.inputTokens += event.input; result.outputTokens += event.output; result.cacheReadTokens += event.cached; result.cacheWriteTokens += event.cacheWrite; result.reasoningTokens += event.reasoning;
      const cost = estimateCost(event);
      if (cost === null) { result.unpricedRequests++; result.costUsd = null; }
      else if (result.costUsd !== null) result.costUsd += cost;
    }
    result.totalTokens = result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens;
    return result;
  }
  function groups(events: StoredEvent[], dimension: 'model' | 'accountId' | 'sessionId'): UsageGroup[] {
    const buckets = new Map<string, StoredEvent[]>();
    for (const event of events) { const id = dimension === 'sessionId' ? `${event.provider}:${event.sessionId}:${event.accountId}` : event[dimension] ?? 'unknown'; const rows = buckets.get(id) ?? []; rows.push(event); buckets.set(id, rows); }
    const sources = store().sources();
    return [...buckets].map(([id, rows]) => ({ id, label: dimension === 'accountId' ? sources.find((s) => s.accountId === id)?.label ?? id : dimension === 'sessionId' ? rows[0]!.sessionId : id, provider: rows[0]!.provider, ...totals(rows) })).sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id));
  }
  async function selected(query: UsageQuery): Promise<{ events: StoredEvent[]; dates: Map<string, StoredEvent[]> }> {
    validateUsageQuery(query);
    const db = store();
    if (query.accountId && !db.sources().some((s) => s.accountId === query.accountId) || query.provider && !db.sources().some((s) => s.provider === query.provider) || query.projectId && !db.bindings().some((b) => b.projectId === query.projectId) || query.tmuxId && !db.bindings().some((b) => b.tmuxId === query.tmuxId)) throw new Error('unknown_filter');
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: query.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const rows = store().eventsBetween(new Date(Date.parse(query.from) - 86_400_000).toISOString(), new Date(Date.parse(query.to) + 86_400_000).toISOString());
    const bindings = store().bindings();
    const events: StoredEvent[] = [];
    const dates = new Map<string, StoredEvent[]>();
    for (let i = 0; i < rows.length; i++) {
      let event = rows[i]!;
      const matches = bindings.filter((b) => b.provider === event.provider && b.sessionId === event.sessionId && b.accountId === event.accountId && Date.parse(event.timestamp) >= Date.parse(b.startedAt) && (!b.endedAt || Date.parse(event.timestamp) < Date.parse(b.endedAt)));
      if (matches.length === 1) { const b = matches[0]!; event = { ...event, projectId: b.projectId, projectLabel: b.projectLabel, tmuxId: b.tmuxId, tmuxLabel: b.tmuxLabel }; }
      // Persisted bindings are authoritative, including corrected end times.
      // A previous scan's attribution is invalid when no interval matches.
      else event = { ...event, projectId: null, projectLabel: null, tmuxId: null, tmuxLabel: null };
      if (query.accountId && query.accountId !== event.accountId || query.provider && query.provider !== event.provider || query.projectId && query.projectId !== event.projectId || query.tmuxId && query.tmuxId !== event.tmuxId) continue;
      const parts = formatter.formatToParts(new Date(event.timestamp));
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      const date = `${part('year')}-${part('month')}-${part('day')}`;
      if (date < query.from || date >= query.to) continue;
      events.push(event); const bucket = dates.get(date) ?? []; bucket.push(event); dates.set(date, bucket);
      if (i % 1000 === 0) await setImmediate();
    }
    return { events, dates };
  }
  return {
    refresh, state,
    close() { if (running) throw new Error('scan_in_progress'); ledger?.close(); ledger = null; },
    async facets(): Promise<UsageFacets> {
      const db = store(); const sources = db.sources();
      const present = available ?? new Set(db.metadata<string[]>('available') ?? []);
      const bindings = db.bindings();
      const projects = new Map(bindings.map((b) => [b.projectId, { id: b.projectId, label: b.projectLabel }]));
      const tmux = new Map(bindings.map((b) => [b.tmuxId, { id: b.tmuxId, label: b.tmuxLabel, projectId: b.projectId }]));
      return { accounts: [...new Map(sources.map((s) => [s.accountId, ({ id: s.accountId, label: s.label, provider: s.provider, source: s.accountId.startsWith('janus:') ? 'janus' as const : 'native' as const, available: sources.some((other) => other.accountId === s.accountId && present.has(other.id)) })])).values()], providers: [...new Set(sources.map((s) => s.provider))], projects: [...projects.values()], tmuxSessions: [...tmux.values()], capabilities: { costs: true, projectFilter: bindings.length > 0, tmuxFilter: bindings.length > 0, quota: false }, status: state() };
    },
    async summary(query: UsageQuery): Promise<UsageSummary> {
      const { events, dates } = await selected(query);
      const days = [];
      for (let time = Date.parse(query.from); time < Date.parse(query.to); time += 86_400_000) { const date = new Date(time).toISOString().slice(0, 10); days.push({ date, ...totals(dates.get(date) ?? []) }); }
      return { ...query, from: query.from, to: query.to, timezone: query.timezone, totals: totals(events), days, models: groups(events, 'model'), accounts: groups(events, 'accountId'), coverage: coverage(events), status: state() };
    },
    async day(date: string, query: UsageQuery): Promise<UsageDayDetail> {
      validateUsageQuery(query);
      if (date < query.from || date >= query.to) throw new Error('date_outside_range');
      const { dates } = await selected(query); const events = dates.get(date) ?? [];
      const sessionGroups = groups(events, 'sessionId');
      return { date, timezone: query.timezone, totals: totals(events), models: groups(events, 'model'), accounts: groups(events, 'accountId'), sessions: sessionGroups.slice(0, 100).map((group) => { const event = events.find((e) => `${e.provider}:${e.sessionId}:${e.accountId}` === group.id)!; const rows = events.filter((e) => `${e.provider}:${e.sessionId}:${e.accountId}` === group.id); return { ...group, accountId: event.accountId, projectId: new Set(rows.map((r) => r.projectId)).size === 1 ? event.projectId : null, tmuxId: new Set(rows.map((r) => r.tmuxId)).size === 1 ? event.tmuxId : null }; }), sessionsTruncated: sessionGroups.length > 100, coverage: coverage(events), status: state() };
    },
  };
}
export type UsageAnalyticsService = ReturnType<typeof createUsageAnalytics>;
