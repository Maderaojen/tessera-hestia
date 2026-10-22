import { describe, expect, it } from 'vitest';
import {
  allows, branchName, checkWorking, defaultTitle, DEFAULT_PREFERENCES, isTerminal, llmSendBacks, resumedWork, reviewEnds, routeDelivery, slugify,
  worktreeFolderName,
} from '../../src/delegation/policy.js';
import { childView } from './fake-ports.js';

const now = new Date('2026-10-06T10:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe('delegation policy', () => {
  it('defaults to a worktree and 20 idle minutes', () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({ isolation: 'worktree', idleAttentionMinutes: 20, llmInitiated: 'ask', targets: [] });
  });

  it('knows which states are over', () => {
    expect(['accepted', 'rejected', 'stopped'].every((state) => isTerminal(state as never))).toBe(true);
    expect(['proposed', 'starting', 'working', 'needs_attention', 'reviewing', 'delivered'].some((state) => isTerminal(state as never))).toBe(false);
  });

  it.each([
    ['working', 'deliver', true], ['needs_attention', 'deliver', true], ['starting', 'deliver', false], ['delivered', 'deliver', false],
    ['delivered', 'accept', true], ['reviewing', 'accept', true], ['working', 'accept', false], ['accepted', 'reject', false],
    ['delivered', 'reject', true], ['starting', 'stop', true], ['delivered', 'stop', true], ['stopped', 'stop', false], ['accepted', 'stop', false],
    ['reviewing', 'review', true], ['delivered', 'review', false], ['working', 'review', false],
    ['reviewing', 'send_back', true], ['delivered', 'send_back', true], ['working', 'send_back', false], ['accepted', 'send_back', false],
    ['accepted', 'cleanup', true], ['rejected', 'cleanup', true], ['stopped', 'cleanup', true], ['delivered', 'cleanup', false],
  ] as const)('%s allows %s: %s', (state, action, expected) => {
    expect(allows(state, action)).toBe(expected);
  });

  it('counts only the delegating LLM\'s send-backs', () => {
    expect(llmSendBacks([
      { kind: 'review', by: 'parent', verdict: 'send_back' }, { kind: 'review', by: 'user', verdict: 'send_back' },
      { kind: 'review', by: 'parent', verdict: 'pass' }, { kind: 'delivery', by: 'child' }, { kind: 'review', by: 'parent', verdict: 'send_back' },
    ])).toBe(2);
  });

  it('routes a delivery to the LLM\'s review while it may still send it back', () => {
    const base = { parentReview: true, parentAlive: true, sendBacks: 0, maxReviewRounds: 3 };
    expect(routeDelivery(base)).toEqual({ state: 'reviewing' });
    expect(routeDelivery({ ...base, sendBacks: 2 })).toEqual({ state: 'reviewing' });
    expect(routeDelivery({ ...base, sendBacks: 3 })).toEqual({ state: 'delivered', reason: 'review_rounds' });
    expect(routeDelivery({ ...base, maxReviewRounds: 0 })).toEqual({ state: 'delivered', reason: 'review_rounds' });
    expect(routeDelivery({ ...base, parentAlive: false })).toEqual({ state: 'delivered', reason: 'parent_gone' });
    expect(routeDelivery({ ...base, parentReview: false, parentAlive: false })).toEqual({ state: 'delivered', reason: null });
  });

  it('ends a review nobody can do', () => {
    expect(reviewEnds({ parentAlive: true, sameWork: true })).toBeNull();
    expect(reviewEnds({ parentAlive: true, sameWork: false })).toBe('parent_switched');
    expect(reviewEnds({ parentAlive: false, sameWork: false })).toBe('parent_gone');
  });

  it('titles from the first line, cut short', () => {
    expect(defaultTitle('  Fix the login\nand more')).toBe('Fix the login');
    expect(defaultTitle('x'.repeat(70))).toBe(`${'x'.repeat(31)}…`);
  });

  it('names the branch and folder from the id and the title\'s ASCII words', () => {
    expect(slugify('Add --json flag to Status!')).toBe('add-json-flag-to-status');
    expect(slugify('修正登入')).toBe('');
    expect(slugify('a'.repeat(40) + ' b')).toHaveLength(32);
    expect(branchName('ab12cd34', 'Fix login')).toBe('delegate/ab12cd34-fix-login');
    expect(branchName('ab12cd34', '修正登入')).toBe('delegate/ab12cd34');
    expect(worktreeFolderName('hestia', 'ab12cd34')).toBe('hestia-delegate-ab12cd34');
  });

  describe('checkWorking', () => {
    const base = { lastActivityAt: minutesAgo(30), continuityBusy: false, idleAttentionMinutes: 20, now };

    it('needs attention after the idle minutes without a turn', () => {
      expect(checkWorking({ ...base, child: childView() })).toBe('idle');
      expect(checkWorking({ ...base, child: childView({ lastTurnAt: minutesAgo(5) }) })).toBe('none');
      expect(checkWorking({ ...base, child: childView({ lastSentAt: minutesAgo(19) }) })).toBe('none');
    });

    it('a reply in progress is work', () => {
      expect(checkWorking({ ...base, child: childView({ phase: 'replying' }) })).toBe('none');
    });

    it('a CLI waiting on a permission counts as idle', () => {
      expect(checkWorking({ ...base, child: childView({ phase: 'awaiting_approval' }) })).toBe('idle');
    });

    it('a CLI that ended needs attention, unless it is being relaunched or continuity holds it', () => {
      expect(checkWorking({ ...base, child: childView({ running: false, phase: null }) })).toBe('cli_exited');
      expect(checkWorking({ ...base, child: childView({ running: false, switching: true, phase: null }) })).toBe('none');
      expect(checkWorking({ ...base, continuityBusy: true, child: childView({ running: false, phase: null }) })).toBe('none');
      expect(checkWorking({ ...base, continuityBusy: true, child: childView() })).toBe('none');
    });
  });

  it('back to work only on a turn the user started after it asked', () => {
    const since = minutesAgo(10);
    expect(resumedWork(childView({ phase: 'replying', lastSentAt: minutesAgo(11) }), since)).toBe(false);
    expect(resumedWork(childView({ phase: 'replying', lastSentAt: minutesAgo(1) }), since)).toBe(true);
    expect(resumedWork(childView({ phase: 'idle', lastSentAt: minutesAgo(1) }), since)).toBe(false);
  });
});
