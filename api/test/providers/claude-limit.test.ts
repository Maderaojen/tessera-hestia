import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { claudeLimitHit } from '../../src/providers/claude-limit.js';

const FIXTURES = path.join(import.meta.dirname, '../fixtures/limit-hits');

function records(name: string): unknown[] {
  return readFileSync(path.join(FIXTURES, name), 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('claudeLimitHit — real transcripts', () => {
  it.each([
    ['2.1.259', '2026-09-03T09:10:00.000Z'],
    ['2.1.282', '2026-09-25T22:30:00.000Z'],
    ['2.1.288', '2026-10-03T15:30:00.000Z'],
  ])('reads %s quotaLimits as a five-hour (session) hit', (version, resetsAt) => {
    const hit = claudeLimitHit(records(`claude.session-limit.${version}.jsonl`));
    expect(hit).toMatchObject({
      scope: 'session', limitType: 'five_hour', model: null, resetsAt, ruleId: 'claude-code/quota-limits',
    });
    expect(hit?.message).toMatch(/^You've hit your session limit · resets /);
  });

  it('the reset in quotaLimits agrees with the shown wording', () => {
    // "resets 6:30am (Asia/Taipei)" = 22:30Z the day before.
    const hit = claudeLimitHit(records('claude.session-limit.2.1.282.jsonl'));
    expect(hit?.message).toContain('6:30am (Asia/Taipei)');
    expect(hit?.resetsAt).toBe('2026-09-25T22:30:00.000Z');
  });

  it('2.1.296: background agents failing on the same limit after it do not count as carrying on', () => {
    const hit = claudeLimitHit(records('claude.session-limit.2.1.296.jsonl'));
    expect(hit).toMatchObject({ scope: 'session', resetsAt: '2026-10-11T13:30:00.000Z', ruleId: 'claude-code/quota-limits' });
  });

  it('2.1.296: reads that the CLI carries on by itself at the reset', () => {
    const hit = claudeLimitHit(records('claude.session-limit.2.1.296.jsonl'));
    expect(hit?.cliResumesAt).toBe('2026-10-11T13:30:00.000Z');
    expect(claudeLimitHit(records('claude.session-limit.2.1.288.jsonl'))?.cliResumesAt).toBeUndefined();
  });

  it('2.1.296: gone once the CLI carries on by itself', () => {
    const resumed = [
      ...records('claude.session-limit.2.1.296.jsonl'),
      { type: 'system', subtype: 'informational', content: 'Usage limit reset · continuing automatically', timestamp: '2026-10-11T13:31:15.488Z' },
      { type: 'user', origin: { kind: 'auto-continuation' }, message: { role: 'user', content: 'continue' }, timestamp: '2026-10-11T13:31:15.537Z' },
    ];
    expect(claudeLimitHit(resumed)).toBeNull();
  });

  it('is gone once anything is said after it', () => {
    const base = records('claude.session-limit.2.1.282.jsonl');
    const carriedOn = [...base, { type: 'user', message: { role: 'user', content: '繼續' }, timestamp: '2026-09-25T22:33:00.000Z' }];
    expect(claudeLimitHit(carriedOn)).toBeNull();
  });

  it('a later hit is the one reported', () => {
    const base = records('claude.session-limit.2.1.282.jsonl');
    const first = base.find((rec) => (rec as { isApiErrorMessage?: boolean }).isApiErrorMessage) as Record<string, unknown>;
    const again = { ...first, timestamp: '2026-09-25T22:33:00.000Z', quotaLimits: { ...(first.quotaLimits as object), resetsAt: 1790393400 } };
    const hit = claudeLimitHit([...base, { type: 'user', message: { role: 'user', content: '繼續' } }, again]);
    expect(hit?.at).toBe('2026-09-25T22:33:00.000Z');
    expect(hit?.resetsAt).toBe('2026-09-26T03:30:00.000Z');
  });
});

describe('claudeLimitHit — rules', () => {
  const error = (extra: Record<string, unknown>) => ({
    type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, isSidechain: false,
    timestamp: '2026-09-25T21:09:08.162Z',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6:30am (Asia/Taipei)" }] },
    ...extra,
  });

  it('keeps an unverified limit type as unknown, with its reset', () => {
    const hit = claudeLimitHit([error({ quotaLimits: { rateLimitType: 'seven_day', resetsAt: 1790375400 } })]);
    expect(hit).toMatchObject({ scope: 'unknown', limitType: 'seven_day', resetsAt: '2026-09-25T22:30:00.000Z' });
  });

  it('falls back to the wording, read from when it was written', () => {
    const hit = claudeLimitHit([error({})], new Date('2026-10-30T00:00:00Z'));
    expect(hit).toMatchObject({ scope: 'unknown', limitType: null, resetsAt: '2026-09-25T22:30:00.000Z', ruleId: 'claude-code/message-text' });
  });

  it('other API errors are not limit hits', () => {
    expect(claudeLimitHit([error({ error: 'authentication_failed' })])).toBeNull();
  });

  it('ignores records outside the main conversation after it', () => {
    const hit = claudeLimitHit([
      error({ quotaLimits: { rateLimitType: 'five_hour', resetsAt: 1790375400 } }),
      { type: 'system', content: 'x' },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'sub' } },
    ]);
    expect(hit?.scope).toBe('session');
  });

  it('a subagent hitting the limit does not stop the main conversation', () => {
    expect(claudeLimitHit([error({ isSidechain: true })])).toBeNull();
  });
});

describe('claudeAdapter.readLimitHit', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('reads the hit off the file tail, even behind a long transcript', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'limit-'));
    const file = path.join(dir, 't.jsonl');
    const filler = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `m${i} ${'x'.repeat(80)}` } })).join('\n');
    await writeFile(file, `${filler}\n${await readFile(path.join(FIXTURES, 'claude.session-limit.2.1.282.jsonl'), 'utf-8')}`);
    expect((await claudeAdapter.readLimitHit!(file))?.scope).toBe('session');
  });

  it('is null for a missing file', async () => {
    expect(await claudeAdapter.readLimitHit!('/nonexistent/x.jsonl')).toBeNull();
  });

});
