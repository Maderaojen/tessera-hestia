import { describe, expect, it } from 'vitest';
import {
  applyOverridePatch, checkConcurrent, checkDepth, checkInitiation, checkQuota, DEFAULT_LIMITS, DEFAULT_PREFERENCES, depthOf,
  effectiveLimits, effectivePreferences, gateQuota, looserLimit, lowQuotaDecision, parentReady, pickIsolation, pickProfile, proposalExpired,
  shouldNotify, type CheckRefusal,
} from '../../src/delegation/policy.js';
import { childView } from './fake-ports.js';

// The phase 2 checks (ADR 0015 決策 7, 10, 14), as pure functions.

const now = new Date('2026-10-06T10:00:00.000Z');

describe('settings layers', () => {
  it('takes a tmux\'s own preferences over the global ones, in any direction', () => {
    const global = { ...DEFAULT_PREFERENCES, targets: ['a', 'b'], llmInitiated: 'ask' as const };
    expect(effectivePreferences(global, undefined)).toEqual(global);
    expect(effectivePreferences(global, { llmInitiated: 'allow', targets: ['c'] })).toMatchObject({ llmInitiated: 'allow', targets: ['c'], isolation: 'worktree' });
  });

  it('takes per limit the stricter of the global one and the tmux\'s own', () => {
    expect(effectiveLimits(DEFAULT_LIMITS, { maxConcurrent: 1, minRemainingPercent: 40 })).toEqual({
      maxConcurrent: 1, maxDepth: 1, maxReviewRounds: 3, minRemainingPercent: 40,
    });
    // A looser one (saved before the global one was tightened) never wins.
    expect(effectiveLimits({ ...DEFAULT_LIMITS, maxConcurrent: 2, minRemainingPercent: 30 }, { maxConcurrent: 3, minRemainingPercent: 10 }))
      .toMatchObject({ maxConcurrent: 2, minRemainingPercent: 30 });
  });

  it('names the first limit a tmux would loosen', () => {
    expect(looserLimit(DEFAULT_LIMITS, {})).toBeNull();
    expect(looserLimit(DEFAULT_LIMITS, { maxConcurrent: 3, maxDepth: 0, maxReviewRounds: 1, minRemainingPercent: 50 })).toBeNull();
    expect(looserLimit(DEFAULT_LIMITS, { maxConcurrent: 4 })).toBe('maxConcurrent');
    expect(looserLimit(DEFAULT_LIMITS, { maxDepth: 2 })).toBe('maxDepth');
    expect(looserLimit(DEFAULT_LIMITS, { maxReviewRounds: 5 })).toBe('maxReviewRounds');
    // Stricter is higher for the quota floor.
    expect(looserLimit(DEFAULT_LIMITS, { minRemainingPercent: 10 })).toBe('minRemainingPercent');
  });

  it('applies a patch, null putting a field back on the global value', () => {
    expect(applyOverridePatch<{ a: number; b: string }>({ a: 1 }, { b: 'x' })).toEqual({ a: 1, b: 'x' });
    expect(applyOverridePatch<{ a: number; b: string }>({ a: 1, b: 'x' }, { a: null })).toEqual({ b: 'x' });
    expect(applyOverridePatch<{ a: number }>({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe('who may start one', () => {
  it('lets the user always, and an LLM as llmInitiated says', () => {
    expect(checkInitiation('user', { ...DEFAULT_PREFERENCES, llmInitiated: 'off' })).toEqual({ ok: true, propose: false });
    expect(checkInitiation('llm', { ...DEFAULT_PREFERENCES, llmInitiated: 'allow' })).toEqual({ ok: true, propose: false });
    expect(checkInitiation('llm', { ...DEFAULT_PREFERENCES, llmInitiated: 'ask' })).toEqual({ ok: true, propose: true });
    expect(checkInitiation('llm', { ...DEFAULT_PREFERENCES, llmInitiated: 'off' })).toMatchObject({ ok: false, code: 'delegation_disabled' });
  });

  it('lets an LLM pick only a target, the first by default, and nothing without targets', () => {
    const available = ['a', 'b', 'c'];
    expect(pickProfile({ initiator: 'llm', requested: undefined, targets: ['b', 'a'], available })).toEqual({ ok: true, profileId: 'b' });
    expect(pickProfile({ initiator: 'llm', requested: 'a', targets: ['b', 'a'], available })).toEqual({ ok: true, profileId: 'a' });
    expect(pickProfile({ initiator: 'llm', requested: 'c', targets: ['b', 'a'], available })).toMatchObject({ ok: false, code: 'profile_not_allowed', params: { profile: 'c' } });
    expect(pickProfile({ initiator: 'llm', requested: undefined, targets: [], available })).toMatchObject({ ok: false, code: 'profile_not_allowed' });
    expect(pickProfile({ initiator: 'llm', requested: 'gone', targets: ['gone'], available })).toMatchObject({ ok: false, code: 'launch_profile_unavailable' });
  });

  it('lets the user pick any available profile, the first target when they don\'t say', () => {
    expect(pickProfile({ initiator: 'user', requested: 'c', targets: ['b'], available: ['a', 'b', 'c'] })).toEqual({ ok: true, profileId: 'c' });
    expect(pickProfile({ initiator: 'user', requested: undefined, targets: ['b'], available: ['a', 'b'] })).toEqual({ ok: true, profileId: 'b' });
    expect(pickProfile({ initiator: 'user', requested: undefined, targets: [], available: ['a'] })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(pickProfile({ initiator: 'user', requested: 'x', targets: [], available: ['a'] })).toMatchObject({ ok: false, code: 'launch_profile_unavailable' });
  });

  it('lets an LLM only make isolation stricter', () => {
    expect(pickIsolation('llm', undefined, 'worktree')).toEqual({ ok: true, isolation: 'worktree' });
    expect(pickIsolation('llm', 'worktree', 'shared')).toEqual({ ok: true, isolation: 'worktree' });
    expect(pickIsolation('llm', 'shared', 'worktree')).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(pickIsolation('llm', 'shared', 'shared')).toEqual({ ok: true, isolation: 'shared' });
    expect(pickIsolation('user', 'shared', 'worktree')).toEqual({ ok: true, isolation: 'shared' });
  });
});

describe('limits', () => {
  it('goes one deeper for a delegate delegating, refused past maxDepth', () => {
    expect(depthOf(null)).toBe(1);
    expect(depthOf(1)).toBe(2);
    expect(checkDepth(1, DEFAULT_LIMITS)).toBeNull();
    expect(checkDepth(2, DEFAULT_LIMITS)).toMatchObject({ code: 'limit_reached', params: { limit: 'depth', max: '1' } });
    expect(checkDepth(1, { ...DEFAULT_LIMITS, maxDepth: 0 })).toMatchObject({ code: 'limit_reached' });
  });

  it('counts host-wide against the global limit, and the tmux\'s own against its override', () => {
    expect(checkConcurrent({ activeOnHost: 2, activeFromParent: 2, globalMax: 3, parentMax: undefined })).toBeNull();
    expect(checkConcurrent({ activeOnHost: 3, activeFromParent: 0, globalMax: 3, parentMax: undefined }))
      .toMatchObject({ code: 'limit_reached', params: { limit: 'concurrent', max: '3' } });
    expect(checkConcurrent({ activeOnHost: 2, activeFromParent: 1, globalMax: 3, parentMax: 1 }))
      .toMatchObject({ code: 'limit_reached', params: { limit: 'concurrent', max: '1' } });
    expect(checkConcurrent({ activeOnHost: 2, activeFromParent: 0, globalMax: 3, parentMax: 1 })).toBeNull();
  });

  it('refuses a target account under the quota floor or over its limit, and allows unknown quota', () => {
    expect(checkQuota({ remainingPercent: 50, limitedUntil: null }, DEFAULT_LIMITS, now)).toEqual({ ok: true, quotaAtStart: 50 });
    expect(checkQuota({ remainingPercent: 20, limitedUntil: null }, DEFAULT_LIMITS, now)).toEqual({ ok: true, quotaAtStart: 20 });
    expect(checkQuota({ remainingPercent: 19, limitedUntil: null }, DEFAULT_LIMITS, now))
      .toMatchObject({ ok: false, code: 'quota_too_low', params: { remaining: '19', min: '20' } });
    expect(checkQuota({ remainingPercent: 80, limitedUntil: '2026-10-06T11:00:00.000Z' }, DEFAULT_LIMITS, now))
      .toMatchObject({ ok: false, code: 'quota_too_low', params: { until: '2026-10-06T11:00:00.000Z' } });
    // A reset already past doesn't count.
    expect(checkQuota({ remainingPercent: null, limitedUntil: '2026-10-06T09:00:00.000Z' }, DEFAULT_LIMITS, now)).toEqual({ ok: true, quotaAtStart: null });
  });

  it('asks the user to confirm a low quota, lets them past once confirmed, and never an LLM', () => {
    const quota = { remainingPercent: 7, limitedUntil: null };
    const check = checkQuota(quota, DEFAULT_LIMITS, now);
    expect(gateQuota({ check, quota, initiator: 'llm', confirmed: true })).toMatchObject({ ok: false, code: 'quota_too_low' });
    expect(gateQuota({ check, quota, initiator: 'organizer', confirmed: true })).toMatchObject({ ok: false, code: 'quota_too_low' });
    expect(gateQuota({ check, quota, initiator: 'user', confirmed: false }))
      .toMatchObject({ ok: false, status: 409, code: 'quota_low_confirm', params: { remaining: '7', min: '20' } });
    const confirmed = gateQuota({ check, quota, initiator: 'user', confirmed: true });
    expect(confirmed).toMatchObject({ ok: true, quotaAtStart: 7, overridden: { code: 'quota_too_low' } });
    expect(lowQuotaDecision((confirmed as { overridden: CheckRefusal }).overridden)).toContain('剩 7%，低於門檻 20%');
    const fine = { remainingPercent: 70, limitedUntil: null };
    expect(gateQuota({ check: checkQuota(fine, DEFAULT_LIMITS, now), quota: fine, initiator: 'llm', confirmed: false }))
      .toEqual({ ok: true, quotaAtStart: 70, overridden: null });
  });

  it('expires a proposal after 24 hours', () => {
    expect(proposalExpired('2026-10-05T10:00:01.000Z', now)).toBe(false);
    expect(proposalExpired('2026-10-05T10:00:00.000Z', now)).toBe(true);
  });
});

describe('the delegating CLI is ready to be told', () => {
  const quiet = { lastTurnAt: '2026-10-06T09:59:00.000Z' };
  it('only when up, idle, nothing on screen, not switching or handed off, and quiet for a while', () => {
    expect(parentReady(childView(quiet), false, now)).toBe(true);
    expect(parentReady(childView(), false, now)).toBe(true);
    expect(parentReady(childView({ ...quiet, phase: 'replying' }), false, now)).toBe(false);
    expect(parentReady(childView({ ...quiet, phase: 'awaiting_approval' }), false, now)).toBe(false);
    expect(parentReady(childView({ ...quiet, running: false }), false, now)).toBe(false);
    expect(parentReady(childView({ ...quiet, switching: true }), false, now)).toBe(false);
    expect(parentReady(childView({ ...quiet, interaction: true }), false, now)).toBe(false);
    expect(parentReady(childView({ ...quiet, startupPrompt: 'workspace_trust' }), false, now)).toBe(false);
    expect(parentReady(childView(quiet), true, now)).toBe(false);
    expect(parentReady(childView({ lastTurnAt: '2026-10-06T09:59:45.000Z' }), false, now)).toBe(false);
    expect(parentReady(childView({ ...quiet, lastSentAt: '2026-10-06T09:59:50.000Z' }), false, now)).toBe(false);
  });
});

describe('notify', () => {
  it('pushes key events always, the rest only with notify all', () => {
    expect(shouldNotify('key', 'key')).toBe(true);
    expect(shouldNotify('all', 'key')).toBe(false);
    expect(shouldNotify('all', 'all')).toBe(true);
  });
});

describe('the default preferences', () => {
  it('wait for the user: an LLM only proposes, and nothing reviews a delivery before the user', () => {
    expect(DEFAULT_PREFERENCES.llmInitiated).toBe('ask');
    expect(DEFAULT_PREFERENCES.parentReview).toBe(false);
  });
});
