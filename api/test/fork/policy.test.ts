import { describe, expect, it } from 'vitest';
import { chooseMemory, forkStatus, forkTitle, gateForkQuota, openForkOf } from '../../src/fork/policy.js';
import { FORK_MESSAGES, forkMessageKind } from '../../src/contract/fork.js';

describe('fork policy', () => {
  it('forks natively only for the same profile and a conversation that can be forked', () => {
    expect(chooseMemory({ parentProfileId: 'native:claude', profileId: 'native:claude', forkBlocked: null })).toEqual({ memory: 'native', reason: null });
    expect(chooseMemory({ parentProfileId: 'native:claude', profileId: 'janus:claude-mad', forkBlocked: null })).toEqual({ memory: 'brief', reason: 'other_profile' });
    expect(chooseMemory({ parentProfileId: null, profileId: 'native:claude', forkBlocked: null })).toEqual({ memory: 'brief', reason: 'other_profile' });
    expect(chooseMemory({ parentProfileId: 'native:agy', profileId: 'native:agy', forkBlocked: 'runtime_unsupported' })).toEqual({ memory: 'brief', reason: 'runtime_unsupported' });
    expect(chooseMemory({ parentProfileId: 'native:codex', profileId: 'native:codex', forkBlocked: 'conversation_unforkable' })).toEqual({ memory: 'brief', reason: 'conversation_unforkable' });
  });

  it('reads its status from its fields', () => {
    const startup = { stage: 'launch' as const, stageSince: 't', launchedAt: null, trustAnsweredAt: null, sentAt: null, resent: 0 };
    expect(forkStatus({ closedAt: null, failedAt: null, startup })).toBe('starting');
    expect(forkStatus({ closedAt: null, failedAt: null, startup: null })).toBe('open');
    expect(forkStatus({ closedAt: null, failedAt: 't', startup: null })).toBe('failed');
    expect(forkStatus({ closedAt: 't', failedAt: 't', startup })).toBe('closed');
  });

  it('titles it as given, else from the instruction, else after the main line', () => {
    expect(forkTitle({ title: ' Mine ', instruction: 'x', parentTitle: 'main' })).toBe('Mine');
    expect(forkTitle({ instruction: 'Try a two-column page\nmore', parentTitle: 'main' })).toBe('Try a two-column page');
    expect(forkTitle({ instruction: null, parentTitle: 'hestia-3' })).toBe('hestia-3 的支線');
    expect(forkTitle({ instruction: '  ', parentTitle: '一個名字非常非常長的主線對話標題會被截短' })).toBe('一個名字非常非常長的主線對話標…的支線'.replace('…的', '… 的'));
  });

  it('asks to confirm a low or limited quota, lets unknown through', () => {
    const now = new Date('2026-10-08T10:00:00Z');
    expect(gateForkQuota({ remainingPercent: null, limitedUntil: null }, now, false)).toBeNull();
    expect(gateForkQuota({ remainingPercent: 50, limitedUntil: null }, now, false)).toBeNull();
    expect(gateForkQuota({ remainingPercent: 5, limitedUntil: null }, now, false)).toMatchObject({ code: 'quota_low_confirm', params: { remaining: '5', min: '20' } });
    expect(gateForkQuota({ remainingPercent: 50, limitedUntil: '2026-10-08T12:00:00Z' }, now, false)).toMatchObject({ code: 'quota_low_confirm', params: { until: '2026-10-08T12:00:00Z' } });
    expect(gateForkQuota({ remainingPercent: 5, limitedUntil: null }, now, true)).toBeNull();
  });

  it('finds the open branch line a session is', () => {
    const forks = [
      { id: 'old', childSessionId: 's1', closedAt: 't', createdAt: '2026-10-08T08:00:00Z' },
      { id: 'now', childSessionId: 's1', closedAt: null, createdAt: '2026-10-08T09:00:00Z' },
      { id: 'theirs', childSessionId: 's2', closedAt: null, createdAt: '2026-10-08T10:00:00Z' },
    ];
    expect(openForkOf(forks, 's1')?.id).toBe('now');
    expect(openForkOf([forks[0]!], 's1')).toBeNull();
  });

  it('labels its own line and nothing else', () => {
    expect(forkMessageKind(FORK_MESSAGES.brief('/w/.hestia/forks/f1/brief.md', true))).toBe('brief');
    expect(forkMessageKind(FORK_MESSAGES.brief('/w/.hestia/forks/f1/brief.md', false))).toBe('brief');
    expect(forkMessageKind('[Hestia 支線] 隨便說說')).toBeNull();
    expect(forkMessageKind('請讀 /w/.hestia/delegations/d1/brief.md，先用一段話回報你的理解，然後開始。')).toBeNull();
    expect(FORK_MESSAGES.brief('/f', true)).not.toContain('\n');
  });
});
