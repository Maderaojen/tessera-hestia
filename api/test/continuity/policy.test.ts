import { describe, expect, it } from 'vitest';
import type { ContinuityPending, LimitHit } from '../../src/contract/continuity.js';
import {
  DEFAULT_CONTINUITY, MAX_POSTPONES, decideWake, effectivePolicy, monitorDecision, planForHit, resumesWithinDay, selectTarget,
  type WakeObservation,
} from '../../src/continuity/policy.js';

const now = new Date('2026-10-03T13:40:00.000Z');
const hit: LimitHit = {
  at: '2026-10-03T13:39:16.989Z', scope: 'session', limitType: 'five_hour', model: null,
  resetsAt: '2026-10-03T15:30:00.000Z', message: "You've hit your session limit · resets 11:30pm (Asia/Taipei)", ruleId: 'claude-code/quota-limits',
};

// Off by default: the user turns carrying on after a reset on. These tests
// are about what it does when on.
const POLICY = { ...DEFAULT_CONTINUITY, mode: 'wait_resume' as const };

describe('the defaults', () => {
  it('leave every automatic step off until the user turns it on', () => {
    expect(DEFAULT_CONTINUITY.mode).toBe('off');
    expect(DEFAULT_CONTINUITY.handoffConfirm).toBe('ask');
  });
});

describe('planForHit', () => {
  it('schedules the carry-on for the reset time plus the delay', () => {
    expect(planForHit(POLICY, hit, 0, now)).toEqual({ kind: 'schedule', wakeAt: '2026-10-03T15:32:00.000Z' });
  });

  it('a reset already past is retried ten minutes later, not right away', () => {
    expect(planForHit(POLICY, { ...hit, resetsAt: '2026-10-03T13:00:00.000Z' }, 0, now))
      .toEqual({ kind: 'schedule', wakeAt: '2026-10-03T13:50:00.000Z' });
  });

  it.each([
    ['mode off', { ...POLICY, mode: 'off' as const }, hit, 0, { kind: 'ignore' }],
    ['no reset time', POLICY, { ...hit, resetsAt: null }, 0, { kind: 'no_reset_time' }],
    ['a reset long past (an old conversation left on its limit)', POLICY, { ...hit, resetsAt: '2026-09-26T03:30:00.000Z' }, 0, { kind: 'stale' }],
    ['no reset time, hit long ago', POLICY, { ...hit, at: '2026-10-03T10:00:00.000Z', resetsAt: null }, 0, { kind: 'stale' }],
    ['stale wins over the cap', POLICY, { ...hit, resetsAt: '2026-09-26T03:30:00.000Z' }, 6, { kind: 'stale' }],
    ['daily cap reached', POLICY, hit, 6, { kind: 'daily_cap', count: 6 }],
    ['cap of zero', { ...POLICY, maxAutoResumesPerDay: 0 }, hit, 0, { kind: 'daily_cap', count: 0 }],
  ])('%s', (_name, policy, h, recent, expected) => {
    expect(planForHit(policy, h, recent, now)).toEqual(expected);
  });
});

describe('decideWake', () => {
  const pending: ContinuityPending = { conversationId: 'c1', hit, wakeAt: '2026-10-03T15:32:00.000Z', postponed: 0 };
  const due = new Date('2026-10-03T15:32:00.000Z');
  const ready: WakeObservation = {
    policy: POLICY,
    session: { conversationId: 'c1', running: true, phase: 'idle' },
    currentHit: hit,
    recentResumes: 0,
  };
  const later = (patch: Partial<WakeObservation> & { session?: WakeObservation['session'] }) => ({ ...ready, ...patch });

  it('sends into the same idle conversation still ending on that hit', () => {
    expect(decideWake(pending, ready, due)).toEqual({ kind: 'send' });
  });

  it.each([
    ['the mode was turned off', later({ policy: { ...POLICY, mode: 'off' } }), 'mode_off'],
    ['the session is gone', later({ session: null }), 'session_gone'],
    ['another conversation is active', later({ session: { conversationId: 'c2', running: true, phase: 'idle' } }), 'conversation_changed'],
    ['the CLI is not running', later({ session: { conversationId: 'c1', running: false, phase: null } }), 'cli_not_running'],
    ['a reply is in progress', later({ session: { conversationId: 'c1', running: true, phase: 'replying' } }), 'already_continued'],
    ['the user carried on already', later({ currentHit: null }), 'already_continued'],
    ['a newer hit replaced it', later({ currentHit: { ...hit, at: '2026-10-03T15:00:00.000Z' } }), 'already_continued'],
    ['the daily cap filled up meanwhile', later({ recentResumes: 6 }), 'daily_cap'],
  ])('drops it when %s', (_name, seen, reason) => {
    expect(decideWake(pending, seen, due)).toEqual({ kind: 'drop', reason });
  });

  it('puts it off while the CLI waits on a prompt, then gives up', () => {
    const waiting = later({ session: { conversationId: 'c1', running: true, phase: 'awaiting_approval' } });
    expect(decideWake(pending, waiting, due)).toEqual({ kind: 'postpone', wakeAt: '2026-10-03T15:37:00.000Z' });
    expect(decideWake({ ...pending, postponed: MAX_POSTPONES }, waiting, due)).toEqual({ kind: 'drop', reason: 'prompt_waiting' });
  });
});

describe('helpers', () => {
  it('a session override wins over the defaults, field by field', () => {
    expect(effectivePolicy(POLICY, { mode: 'off' })).toEqual({ ...POLICY, mode: 'off' });
  });

  it('counts only carry-ons within the last 24 hours', () => {
    expect(resumesWithinDay(['2026-10-02T13:39:00.000Z', '2026-10-02T13:41:00.000Z', '2026-10-03T13:00:00.000Z'], now))
      .toEqual(['2026-10-02T13:41:00.000Z', '2026-10-03T13:00:00.000Z']);
  });
});

describe('selectTarget', () => {
  const c = (id: string, accountId: string | null, remainingPercent: number | null, limitedUntil: string | null = null) => ({ id, accountId, remainingPercent, limitedUntil });
  const candidates = [c('a', 'acct-a', 50), c('b', 'acct-b', 50), c('c', 'acct-c', 50)];
  const select = (patch: Partial<Parameters<typeof selectTarget>[0]>) => selectTarget({
    chain: ['a', 'b', 'c'], currentProfileId: 'b', currentAccountId: 'acct-b', candidates, softRemainingPercent: 15, now, ...patch,
  });

  it('takes the next one after the current, wrapping around', () => {
    expect(select({})).toBe('c');
    expect(select({ currentProfileId: 'c', currentAccountId: 'acct-c' })).toBe('a');
  });

  it('starts from the top when the current profile is not in the chain', () => {
    expect(select({ currentProfileId: 'z', currentAccountId: 'acct-z' })).toBe('a');
  });

  it('skips the same account under another profile, low ones, limited ones and ones no longer offered', () => {
    expect(select({ candidates: [c('c', 'acct-b', 90), c('a', 'acct-a', 50)] })).toBe('a');
    expect(select({ candidates: [c('c', 'acct-c', 15), c('a', 'acct-a', 50)] })).toBe('a');
    expect(select({ candidates: [c('c', 'acct-c', 90, '2026-10-03T15:00:00.000Z'), c('a', 'acct-a', 50)] })).toBe('a');
    expect(select({ candidates: [c('a', 'acct-a', 50)] })).toBe('a');
  });

  it('a limit that has reset no longer counts; unknown quota counts as available', () => {
    expect(select({ candidates: [c('c', 'acct-c', null, '2026-10-03T13:00:00.000Z')] })).toBe('c');
  });

  it('nobody', () => {
    expect(select({ chain: ['b'] })).toBeNull();
  });
});

describe('monitorDecision', () => {
  const policy = { ...POLICY, mode: 'handoff' as const };
  const decide = (remainingPercent: number | null, phase: 'idle' | 'replying' | null, lastTurnAt: string | null = '2026-10-03T13:38:00.000Z') =>
    monitorDecision({ policy, phase, remainingPercent, lastTurnAt, now });

  it.each([
    [50, 'idle', 'none'],
    [24, 'idle', 'refresh'],
    [24, 'replying', 'refresh'],
    [15, 'idle', 'soft'],
    [15, 'replying', 'refresh'],
    [5, 'replying', 'hard'],
    [5, 'idle', 'soft'],
    [null, 'idle', 'none'],
    [5, null, 'none'],
  ] as const)('%s%% while %s: %s', (remaining, phase, expected) => {
    expect(decide(remaining, phase)).toBe(expected);
  });

  it('a long idle session is left alone', () => {
    expect(decide(10, 'idle', '2026-10-03T12:00:00.000Z')).toBe('none');
  });

  it('only in handoff mode', () => {
    expect(monitorDecision({ policy: POLICY, phase: 'replying', remainingPercent: 1, lastTurnAt: null, now })).toBe('none');
  });
});
