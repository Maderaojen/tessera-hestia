import { describe, expect, it } from 'vitest';
import { estimateCost } from '../../src/usage-analytics/pricing.js';
import type { UsageEvent } from '../../src/usage-analytics/parsers.js';
const event: UsageEvent = { id: 'e', sessionId: 's', provider: 'claude', timestamp: '2026-10-05T00:00:00Z', model: 'claude-sonnet-4-6', input: 1_000_000, output: 1_000_000, cached: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 500_000, reasoning: 0, cwd: null };
describe('verified standard pricing', () => {
  it('prices nonoverlapping buckets with separate 1h writes', () => {
    expect(estimateCost(event)).toBeCloseTo(23.175);
    expect(estimateCost({ ...event, model: 'claude-opus-4-6' })).toBeCloseTo(38.625);
    expect(estimateCost({ ...event, model: 'gpt-5.3-codex', cacheWrite: 0, cacheWrite1h: 0 })).toBeCloseTo(15.925);
  });
  it('returns unknown instead of guessing nearby models or special pricing modes', () => {
    expect(estimateCost({ ...event, model: 'unknown' })).toBeNull();
    expect(estimateCost({ ...event, serviceTier: 'priority' })).toBeNull();
    expect(estimateCost({ ...event, inferenceGeo: 'us' })).toBeNull();
    expect(estimateCost({ ...event, model: 'gpt-5.4', cacheWrite: 0 })).toBeNull();
  });
});
