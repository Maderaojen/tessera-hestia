import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../../src/providers/codex.js';
import { codexLimitHit, parseCodexRetryTime } from '../../src/providers/codex-limit.js';

const FIXTURES = path.join(import.meta.dirname, '../fixtures/limit-hits');
const records = (name: string): unknown[] => readFileSync(path.join(FIXTURES, name), 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('codexLimitHit — real rollouts', () => {
  it('0.156.1: the exhausted five-hour window and its reset', () => {
    const hit = codexLimitHit(records('codex.usage-limit.0.156.1.jsonl'));
    // "try again at 5:30 PM" (Asia/Taipei) = 09:30Z.
    expect(hit).toMatchObject({
      scope: 'session', limitType: 'five_hour', resetsAt: '2026-09-24T09:30:33.000Z', ruleId: 'codex-cli/rate-limits',
    });
    expect(hit?.message).toMatch(/hit your usage limit.*try again at 5:30 PM/);
  });

  it('0.153.4: a hit followed by a new turn is behind it', () => {
    expect(codexLimitHit(records('codex.usage-limit-then-new-turn.0.153.4.jsonl'))).toBeNull();
  });

  it('reads the file tail through the adapter', async () => {
    expect((await codexAdapter.readLimitHit!(path.join(FIXTURES, 'codex.usage-limit.0.156.1.jsonl')))?.scope).toBe('session');
  });
});

describe('codexLimitHit — rules', () => {
  const complete = (error: unknown, timestamp = '2026-09-24T06:32:34.226Z') => ({ timestamp, type: 'event_msg', payload: { type: 'task_complete', error } });
  const limit = { codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit. … try again at 5:30 PM." };

  it('a turn that completed normally is no hit', () => {
    expect(codexLimitHit([complete(null)])).toBeNull();
  });

  it('a weekly window at 100% is weekly', () => {
    const hit = codexLimitHit([
      { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1790461329 } } } },
      complete(limit),
    ]);
    expect(hit).toMatchObject({ scope: 'weekly', limitType: 'seven_day', resetsAt: '2026-09-26T22:22:09.000Z' });
  });

  it('without a token_count, falls back to the wording', () => {
    const hit = codexLimitHit([complete(limit)]);
    expect(hit).toMatchObject({ scope: 'unknown', ruleId: 'codex-cli/message-text' });
    expect(hit?.resetsAt).not.toBeNull();
  });

  it('a user message after it means the user carried on', () => {
    expect(codexLimitHit([complete(limit), { type: 'event_msg', payload: { type: 'user_message', message: 'go on' } }])).toBeNull();
  });
});

describe('parseCodexRetryTime', () => {
  const written = new Date('2026-09-24T06:32:34Z'); // 14:32 in Taipei
  it('a time of day later today', () => {
    expect(parseCodexRetryTime('try again at 5:30 PM.', written, 'Asia/Taipei')).toBe('2026-09-24T09:30:00.000Z');
  });
  it('a time of day already past is tomorrow', () => {
    expect(parseCodexRetryTime('try again at 10:02 AM.', written, 'Asia/Taipei')).toBe('2026-09-25T02:02:00.000Z');
  });
  it('a full date', () => {
    expect(parseCodexRetryTime('try again at Aug 28th, 2026 10:06 AM.', written, 'Asia/Taipei')).toBe('2026-08-28T02:06:00.000Z');
  });
  it('anything else', () => {
    expect(parseCodexRetryTime('please wait', written, 'Asia/Taipei')).toBeNull();
  });
});
