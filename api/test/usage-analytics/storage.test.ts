import { describe, expect, it } from 'vitest';
import { openLedger } from '../../src/usage-analytics/storage.js';
import type { StoredEvent } from '../../src/usage-analytics/storage.js';

describe('durable usage ledger', () => {
  it.each([
    { field: 'model', changed: 'claude-opus-4-5' },
    { field: 'serviceTier', changed: 'priority' },
    { field: 'inferenceGeo', changed: 'us' },
  ])('keeps original pricing metadata and warns when $field conflicts', ({ field, changed }) => {
    const ledger = openLedger(':memory:');
    const event: StoredEvent = { id: 'metadata-request', provider: 'claude', sessionId: 's', timestamp: '2026-10-04T16:05:00.000Z', model: 'claude-sonnet-4-5', serviceTier: 'standard', inferenceGeo: 'global', input: 10, output: 1, cached: 0, cacheWrite: 0, reasoning: 0, cwd: null, accountId: 'a', sourceId: 'a', projectId: null, projectLabel: null, tmuxId: null, tmuxLabel: null };
    try {
      ledger.upsert(event);
      expect(ledger.upsert({ ...event, [field]: changed })).toBe('conflicting_usage_snapshot');
      expect(ledger.allEvents()).toEqual([event]);
    } finally { ledger.close(); }
  });

  it.each([null, 'unknown'])('enriches %s model and absent pricing metadata without warning', (model) => {
    const ledger = openLedger(':memory:');
    const event: StoredEvent = { id: 'enriched-request', provider: 'claude', sessionId: 's', timestamp: '2026-10-04T16:05:00.000Z', model, serviceTier: null, inferenceGeo: null, input: 10, output: 1, cached: 0, cacheWrite: 0, reasoning: 0, cwd: null, accountId: 'a', sourceId: 'a', projectId: null, projectLabel: null, tmuxId: null, tmuxLabel: null };
    try {
      ledger.upsert(event);
      const enriched = { ...event, model: 'claude-sonnet-4-5', serviceTier: 'standard', inferenceGeo: 'global' };
      expect(ledger.upsert(enriched)).toBeNull();
      expect(ledger.allEvents()).toEqual([enriched]);
    } finally { ledger.close(); }
  });

  it('does not assign a replaying account binding to the original account', () => {
    const ledger = openLedger(':memory:');
    const event: StoredEvent = { id: 'copied-request', provider: 'claude', sessionId: 'original', timestamp: '2026-10-04T16:05:00.000Z', model: 'claude-sonnet-4-5', input: 10, output: 1, cached: 0, cacheWrite: 0, reasoning: 0, cwd: null, accountId: 'personal', sourceId: 'personal-root', projectId: null, projectLabel: null, tmuxId: null, tmuxLabel: null };
    try {
      ledger.upsert(event);
      expect(ledger.upsert({ ...event, accountId: 'work', sourceId: 'work-root', sessionId: 'copied', projectId: 'work-project', projectLabel: 'Work', tmuxId: 'work-tmux', tmuxLabel: 'Work tmux' })).toBe('conflicting_usage_source');
      expect(ledger.allEvents()).toEqual([event]);
    } finally { ledger.close(); }
  });

  it('keeps known pricing metadata when a later stream snapshot omits it', () => {
    const ledger = openLedger(':memory:');
    const event: StoredEvent = { id: 'missing-metadata-request', provider: 'claude', sessionId: 's', timestamp: '2026-10-04T16:05:00.000Z', model: 'claude-sonnet-4-5', serviceTier: 'standard', inferenceGeo: 'global', input: 10, output: 1, cached: 0, cacheWrite: 0, reasoning: 0, cwd: null, accountId: 'a', sourceId: 'a', projectId: null, projectLabel: null, tmuxId: null, tmuxLabel: null };
    try {
      ledger.upsert(event);
      expect(ledger.upsert({ ...event, model: null, serviceTier: undefined, inferenceGeo: null, output: 20 })).toBeNull();
      expect(ledger.allEvents()).toEqual([{ ...event, output: 20 }]);
    } finally { ledger.close(); }
  });

  it('merges Claude stream snapshots without moving activity to the next day', () => {
    const ledger = openLedger(':memory:');
    const event: StoredEvent = { id: 'r', provider: 'claude', sessionId: 's', timestamp: '2026-10-04T23:59:00.000Z', model: 'unknown', input: 10, output: 1, cached: 0, cacheWrite: 0, reasoning: 0, cwd: null, accountId: 'a', sourceId: 'a', projectId: null, projectLabel: null, tmuxId: null, tmuxLabel: null };
    ledger.upsert(event);
    ledger.upsert({ ...event, timestamp: '2026-10-05T00:01:00.000Z', output: 20 });
    expect(ledger.allEvents()).toEqual([{ ...event, output: 20 }]);
    expect(ledger.upsert({ ...event, accountId: 'copied-source', output: 20 })).toBe('conflicting_usage_source');
    expect(ledger.allEvents()[0]?.accountId).toBe('a');
    ledger.close();
  });
});
