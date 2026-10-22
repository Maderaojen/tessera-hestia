import { describe, expect, it } from 'vitest';
import { createUsageParser } from '../../src/usage-analytics/parsers.js';

const claude = (output: number) => ({ type: 'assistant', sessionId: 's1', timestamp: '2026-10-04T16:05:00Z', requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: output } } });
const count = (input: number, output: number, timestamp = '2026-10-04T16:05:00Z') => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 20, output_tokens: output, reasoning_output_tokens: 5 } } } });

describe('provider usage normalization', () => {
  it('identifies Claude stream snapshots by request and excludes prose', () => {
    const parser = createUsageParser('claude', 'fallback');
    const first = parser.parse(claude(2));
    const final = parser.parse(claude(8));
    expect(first?.id).toBe(final?.id);
    expect(final).toMatchObject({ input: 10, cached: 30, cacheWrite: 20, output: 8, reasoning: 0 });
    expect(JSON.stringify(final)).not.toContain('message');
  });
  it('does not count Codex duplicate cumulative totals or overlapping token categories', () => {
    const parser = createUsageParser('codex', 'fallback');
    parser.parse({ type: 'session_meta', payload: { id: 's1' }, timestamp: '2026-10-04T16:00:00Z' });
    parser.parse({ type: 'turn_context', payload: { model: 'gpt-5' } });
    expect(parser.parse(count(100, 10))).toMatchObject({ input: 80, cached: 20, output: 10, reasoning: 5 });
    expect(parser.parse(count(100, 10))).toBeNull();
    expect(parser.parse(count(140, 20, '2026-10-04T16:06:00Z'))).toMatchObject({ input: 40, cached: 0, output: 10, reasoning: 0 });
  });
  it('skips inherited fork baseline and ignores decreasing counters', () => {
    const parser = createUsageParser('codex', 'fallback');
    parser.parse({ type: 'session_meta', payload: { id: 'child', forked_from_id: 'parent' }, timestamp: '2026-10-04T16:00:00Z' });
    expect(parser.parse(count(100, 10))).toBeNull();
    expect(parser.parse(count(140, 20))).toMatchObject({ input: 40, output: 10 });
    expect(parser.parse(count(80, 8))).toBeNull();
    expect(parser.warnings).toContain('codex_counter_reset');
  });
  it('deduplicates copied Claude replies across session ids but keeps distinct message ids', () => {
    const parser = createUsageParser('claude', 'fallback');
    expect(parser.parse(claude(2))?.id).toBe(parser.parse({ ...claude(2), sessionId: 'copy' })?.id);
    expect(parser.parse(claude(2))?.id).not.toBe(parser.parse({ ...claude(2), message: { ...claude(2).message, id: 'm2' } })?.id);
  });
  it('uses only the last usage on an unmarked resumed cumulative baseline', () => {
    const parser = createUsageParser('codex', 'fallback');
    const raw = count(1000, 100);
    const modified = { ...raw, payload: { ...raw.payload, info: { ...raw.payload.info, last_token_usage: { input_tokens: 20, output_tokens: 5 } } } };
    expect(parser.parse(modified)).toMatchObject({ input: 20, output: 5 });
  });
  it('rejects invalid token counters and missing stable Claude identities', () => {
    const parser = createUsageParser('claude', 'fallback');
    expect(parser.parse({ ...claude(8), requestId: undefined, message: { model: 'x', usage: { input_tokens: 1 } } })).toBeNull();
    expect(parser.parse(claude(-1))).toBeNull();
    expect(parser.warnings.length).toBeGreaterThan(0);
  });
  it('does not count decreasing counters again when replay recovers', () => {
    const parser = createUsageParser('codex', 's');
    expect(parser.parse(count(100, 10))?.input).toBe(80);
    expect(parser.parse(count(80, 8))).toBeNull();
    expect(parser.parse(count(100, 10))).toBeNull();
  });
  it('skips all inherited snapshots at the child creation boundary', () => {
    const parser = createUsageParser('codex', 's');
    parser.parse({ type: 'session_meta', timestamp: '2026-10-04T16:05:00Z', payload: { id: 'child', forked_from_id: 'parent' } });
    expect(parser.parse(count(100, 10))).toBeNull();
    expect(parser.parse(count(200, 20))).toBeNull();
    expect(parser.parse(count(220, 22, '2026-10-04T16:06:00Z'))).toMatchObject({ input: 20, output: 2 });
  });
  it('rejects delta cached/reasoning exceeding their containing token buckets', () => {
    const parser = createUsageParser('codex', 's');
    parser.parse(count(100, 10));
    const raw = count(110, 11);
    raw.payload.info.total_token_usage.cached_input_tokens = 40;
    raw.payload.info.total_token_usage.reasoning_output_tokens = 8;
    expect(parser.parse(raw)).toBeNull();
    expect(parser.warnings).toContain('invalid_usage_delta');
  });

});
