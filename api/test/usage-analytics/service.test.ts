import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUsageAnalytics } from '../../src/usage-analytics/service.js';

const row = (id: string, output = 5) => ({ type: 'assistant', sessionId: 's', requestId: id, timestamp: '2026-10-04T16:05:00Z', message: { id: `m-${id}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: output } } });
const query = { from: '2026-10-04', to: '2026-10-06', timezone: 'Asia/Taipei' };
describe('usage analytics service', () => {
  it.each([
    { from: '2026-03-07', to: '2026-03-09', stamps: ['2026-03-08T04:59:00Z', '2026-03-08T05:00:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z'] },
    { from: '2026-10-31', to: '2026-11-02', stamps: ['2026-11-01T03:59:00Z', '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'] },
  ])('buckets local midnight and DST transitions for $from', async ({ from, to, stamps }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-dst-'));
    await writeFile(path.join(dir, 's.jsonl'), stamps.map((timestamp, i) => JSON.stringify({ ...row(`dst-${i}`), timestamp })).join('\n') + '\n');
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [{ id: 'a', root: dir, accountId: 'a', label: 'A', provider: 'claude' as const }], warnings: [] }) });
    try {
      await service.refresh();
      const result = await service.summary({ from, to, timezone: 'America/New_York' });
      expect(result.days.map(day => day.requestCount)).toEqual([1, 3]);
      expect(result.days.map(day => day.totalTokens)).toEqual([15, 45]);
      expect(result.totals.sessionCount).toBe(1);
    } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('retains skipped-record warnings across unchanged scans and restarts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-warnings-'));
    const root = path.join(dir, 'source'); await mkdir(root);
    await writeFile(path.join(root, 's.jsonl'), '{broken json}\n' + JSON.stringify(row('valid')) + '\n');
    const options = { dbPath: path.join(dir, 'state', 'usage.sqlite'), discoverSources: async () => ({ sources: [{ id: 'a', root, accountId: 'a', label: 'A', provider: 'claude' as const }], warnings: [] }) };
    let service = createUsageAnalytics(options);
    try {
      await service.refresh();
      expect((await service.summary(query)).coverage.warnings).toContain('malformed_jsonl');
      await service.refresh();
      expect((await service.summary(query)).coverage.warnings).toContain('malformed_jsonl');
      service.close(); service = createUsageAnalytics(options);
      await service.refresh();
      expect((await service.summary(query)).coverage.warnings).toContain('malformed_jsonl');
      expect((await service.summary(query)).totals.requestCount).toBe(1);
    } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('removes a former binding when its confirmed end precedes the event', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-binding-ended-'));
    await writeFile(path.join(dir, 's.jsonl'), JSON.stringify(row('r1')) + '\n');
    let endedAt: string | null = null;
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [{ id: 'a', root: dir, accountId: 'native:claude:default', label: 'Default', provider: 'claude' as const }], warnings: [] }), readBindings: async () => [{ provider: 'claude' as const, sessionId: 's', accountId: 'native:claude:default', startedAt: '2026-10-04T00:00:00Z', endedAt, projectId: 'p', projectLabel: 'Project', tmuxId: 't', tmuxLabel: 'Tmux' }] });
    try {
      await service.refresh();
      expect((await service.summary({ ...query, tmuxId: 't' })).totals.requestCount).toBe(1);
      endedAt = '2026-10-04T16:00:00Z';
      await service.refresh();
      expect((await service.summary({ ...query, tmuxId: 't' })).totals.requestCount).toBe(0);
      expect((await service.summary({ ...query, projectId: 'p' })).totals.requestCount).toBe(0);
      const detail = await service.day('2026-10-05', query);
      expect(detail.totals.requestCount).toBe(1);
      expect(detail.coverage.unattributedRequests).toBe(1);
      expect(detail.sessions[0]).toMatchObject({ projectId: null, tmuxId: null });
    } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('durably imports, filters accounts, increments incomplete tails, retains deleted source history', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-service-'));
    await mkdir(path.join(dir, 'root'));
    const file = path.join(dir, 'root', 's.jsonl');
    await writeFile(file, JSON.stringify(row('r1')) + '\n' + JSON.stringify(row('r2')));
    const options = { dbPath: path.join(dir, 'state', 'usage.sqlite'), discoverSources: async () => ({ sources: [{ id: 'a', accountId: 'native:claude:default', label: 'Default', provider: 'claude' as const, root: path.join(dir, 'root') }], warnings: [] }), readBindings: async () => [] };
    let service = createUsageAnalytics(options);
    await service.refresh();
    expect((await service.summary(query)).totals).toMatchObject({ totalTokens: 15, requestCount: 1, sessionCount: 1 });
    expect((await service.summary(query)).days[1]?.requestCount).toBe(1);
    await expect(service.summary({ ...query, accountId: 'other' })).rejects.toThrow('unknown_filter');
    await appendFile(file, '\n');
    await service.refresh();
    expect((await service.summary(query)).totals.requestCount).toBe(2);
    service.close();
    await rm(file);
    service = createUsageAnalytics(options);
    await service.refresh();
    expect((await service.summary(query)).totals.requestCount).toBe(2);
    service.close(); await rm(dir, { recursive: true, force: true });
  });
  it('keeps unknown pricing null and validates date, timezone and bounded range', async () => {
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [], warnings: [] }) });
    await expect(service.summary({ ...query, from: '2026-02-30' })).rejects.toThrow();
    await expect(service.summary({ ...query, timezone: 'Invalid/Zone' })).rejects.toThrow();
    await expect(service.summary({ ...query, from: '2024-01-01' })).rejects.toThrow();
    expect((await service.summary(query)).totals.costUsd).toBe(0);
    service.close();
  });
  it('deduplicates same-account roots and keeps unknown bindings unattributed until verified', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-facets-'));
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    await mkdir(a); await mkdir(b);
    await writeFile(path.join(a, 's.jsonl'), JSON.stringify(row('r1')) + '\n');
    let accountId: string | null = null;
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [a, b].map((root) => ({ id: root, root, accountId: 'native:claude:default', label: 'Default', provider: 'claude' as const })), warnings: [] }), readBindings: async () => [{ provider: 'claude' as const, sessionId: 's', startedAt: '2026-10-04T00:00:00Z', endedAt: null, projectId: 'p', projectLabel: 'P', tmuxId: 't', tmuxLabel: 'T', accountId }] });
    await service.refresh();
    expect((await service.facets()).accounts).toHaveLength(1);
    expect((await service.summary(query)).coverage.unattributedRequests).toBe(1);
    accountId = 'native:claude:default';
    await service.refresh();
    expect((await service.summary({ ...query, tmuxId: 't' })).totals.requestCount).toBe(1);
    service.close(); await rm(dir, { recursive: true, force: true });
  });
  it('preserves last successful freshness on complete source failures', async () => {
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [{ id: 'a', root: '/nonexistent-usage-fixture-root', accountId: 'a', label: 'A', provider: 'claude' as const }], warnings: [] }) });
    await service.refresh();
    expect(service.state()).toMatchObject({ state: 'error', updatedAt: null });
    service.close();
  });
  it('does not open a corrupt store during factory creation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-corrupt-'));
    const file = path.join(dir, 'bad.sqlite'); await writeFile(file, 'not a database');
    const service = createUsageAnalytics({ dbPath: file, discoverSources: async () => ({ sources: [], warnings: [] }) });
    await expect(service.facets()).rejects.toThrow();
    service.close(); await rm(dir, { recursive: true, force: true });
  });

  it('scopes all summary and day totals to each account and retains unavailable facets', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-multi-'));
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    await mkdir(a); await mkdir(b);
    await writeFile(path.join(a, 's.jsonl'), JSON.stringify(row('a', 5)) + '\n');
    await writeFile(path.join(b, 's.jsonl'), JSON.stringify(row('b', 10)) + '\n');
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [a,b].map((root, i) => ({ id: root, root, accountId: i ? 'janus:claude:work' : 'janus:claude:personal', label: i ? 'Work' : 'Personal', provider: 'claude' as const })), warnings: [] }) });
    await service.refresh();
    expect((await service.summary(query)).totals.totalTokens).toBe(35);
    const personal = { ...query, accountId: 'janus:claude:personal' };
    const work = { ...query, accountId: 'janus:claude:work' };
    expect((await service.summary(personal)).totals.totalTokens).toBe(15);
    expect((await service.summary(work)).days[1]?.totalTokens).toBe(20);
    expect((await service.day('2026-10-05', personal)).totals.totalTokens).toBe(15);
    await rm(dir, { recursive: true, force: true }); await service.refresh();
    expect((await service.facets()).accounts.every((a) => !a.available)).toBe(true);
    expect((await service.summary(query)).totals.totalTokens).toBe(35);
    service.close();
  });

  it('does not label a mixed tmux session with its first binding', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-mixed-'));
    await writeFile(path.join(dir, 's.jsonl'), [row('r1'), { ...row('r2'), timestamp: '2026-10-04T17:05:00Z' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const base = { provider: 'claude' as const, sessionId: 's', projectId: 'p', projectLabel: 'P', tmuxLabel: 'Tmux', accountId: 'native:claude:default' };
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [{ id: 'a', root: dir, label: 'Default', accountId: base.accountId, provider: base.provider }], warnings: [] }), readBindings: async () => [{ ...base, tmuxId: 't1', startedAt: '2026-10-04T00:00:00Z', endedAt: '2026-10-04T17:00:00Z' }, { ...base, tmuxId: 't2', startedAt: '2026-10-04T17:00:00Z', endedAt: null }] });
    await service.refresh();
    const detail = await service.day('2026-10-05', query);
    expect(detail.totals.sessionCount).toBe(1);
    expect(detail.sessions[0]?.tmuxId).toBeNull();
    expect((await service.summary({ ...query, tmuxId: 't2' })).totals.requestCount).toBe(1);
    service.close(); await rm(dir, { recursive: true, force: true });
  });

  it('detects a rewritten growing file and keeps a partial scan usable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-rewrite-'));
    const root = path.join(dir, 'root'); await mkdir(root);
    const file = path.join(root, 's.jsonl'); await writeFile(file, JSON.stringify(row('r1')) + '\n');
    const blocked = path.join(dir, 'not-directory'); await writeFile(blocked, 'file');
    let includeBlocked = false;
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [root, ...(includeBlocked ? [blocked] : [])].map((root) => ({ id: root, root, accountId: 'a', label: 'A', provider: 'claude' as const })), warnings: [] }) });
    await service.refresh();
    await writeFile(file, JSON.stringify(row('rewritten-request-larger')) + '\n');
    await service.refresh();
    expect((await service.summary(query)).totals.requestCount).toBe(2);
    includeBlocked = true; await service.refresh();
    expect(service.state().state).toBe('idle');
    expect((await service.summary(query)).coverage.warnings).toContain('source_scan_failed');
    service.close(); await rm(dir, { recursive: true, force: true });
  });

});
