import { describe, expect, it } from 'vitest';
import { newLaunchGuard, type LaunchGuard } from '../../src/contract/launch-guard.js';
import {
  afterExit, beforeFirstMessage, confirmFirstDelivery, FIRST_DELIVERY_GIVE_UP_MS, FIRST_TURN_WATCH_MS, MISSING_GIVE_UP_MS,
  UNKNOWN_NOTICE_MS, UPDATE_SETTLE_MS, watchFirstTurn, type ScreenReading,
} from '../../src/launch-guard/decide.js';

// The launch guard's decisions (ADR 0030), shared by a handoff's briefing
// and a delegation's or branch line's: pure, from what one look saw.

const T0 = new Date('2026-10-16T11:17:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const screen = (kind: ScreenReading['screen']['kind'], extra: object = {}): ScreenReading => ({
  screen: { kind, ...extra } as ScreenReading['screen'], tail: `${kind} tail`,
});
const update = (selected: 'update' | 'skip' | null = 'update') => screen('update_prompt', { selected, options: ['update', 'skip', 'skip_version'] });

describe('beforeFirstMessage', () => {
  it('sends only into the input box (or for a runtime with no reading, as before)', () => {
    expect(beforeFirstMessage(screen('input_ready'), newLaunchGuard(), T0).decision).toEqual({ do: 'send' });
    expect(beforeFirstMessage(screen('unverified'), newLaunchGuard(), T0).decision).toEqual({ do: 'send' });
    for (const kind of ['unknown', 'startup_prompt', 'cli_updated'] as const) {
      expect(beforeFirstMessage(screen(kind), newLaunchGuard(), T0).decision, kind).toEqual({ do: 'wait' });
    }
    // A screen that couldn't be read is not a go-ahead either.
    expect(beforeFirstMessage(null, newLaunchGuard(), T0).decision).toEqual({ do: 'wait' });
  });

  it('the incident: Codex\'s update menu is never typed into; Skip is chosen once instead', () => {
    const first = beforeFirstMessage(update(), newLaunchGuard(), T0);
    expect(first.decision).toEqual({ do: 'skip_update' });
    expect(first.guard.updateSkippedAt).toBe(T0.toISOString());
    // Still there a moment later: wait for the redraw…
    const soon = beforeFirstMessage(update(), first.guard, at(UPDATE_SETTLE_MS - 1));
    expect(soon.decision).toEqual({ do: 'wait' });
    // …then hand it to the user, once.
    const late = beforeFirstMessage(update(), first.guard, at(UPDATE_SETTLE_MS + 1));
    expect(late.decision).toEqual({ do: 'notice', about: 'update_prompt', tail: 'update_prompt tail' });
    expect(beforeFirstMessage(update(), late.guard, at(UPDATE_SETTLE_MS + 5_000)).decision).toEqual({ do: 'wait' });
  });

  it('waits on an unknown screen, and tells the user once after a while, with the pane\'s tail', () => {
    let guard: LaunchGuard = newLaunchGuard();
    ({ guard } = beforeFirstMessage(screen('unknown'), guard, T0));
    expect(guard.unknownSince).toBe(T0.toISOString());
    expect(beforeFirstMessage(screen('unknown'), guard, at(UNKNOWN_NOTICE_MS - 1)).decision).toEqual({ do: 'wait' });
    const told = beforeFirstMessage(screen('unknown'), guard, at(UNKNOWN_NOTICE_MS + 1));
    expect(told.decision).toEqual({ do: 'notice', about: 'unknown_screen', tail: 'unknown tail' });
    expect(told.guard).toMatchObject({ noticeAt: at(UNKNOWN_NOTICE_MS + 1).toISOString(), tail: 'unknown tail' });
    expect(beforeFirstMessage(screen('unknown'), told.guard, at(UNKNOWN_NOTICE_MS * 3)).decision).toEqual({ do: 'wait' });
    // Cleared by hand: sent, and a later stretch would be told about again.
    const cleared = beforeFirstMessage(screen('input_ready'), told.guard, at(UNKNOWN_NOTICE_MS * 4));
    expect(cleared.decision).toEqual({ do: 'send' });
    expect(cleared.guard).toMatchObject({ unknownSince: null, noticeAt: null });
  });
});

describe('confirmFirstDelivery', () => {
  const sentAt = T0.toISOString();
  it('only the transcript showing it, whole, counts: \'unknown\' (no conversation bound yet) is not delivered', () => {
    expect(confirmFirstDelivery({ delivered: 'exact', sentAt, now: at(4_000), resent: 0 })).toBe('delivered');
    expect(confirmFirstDelivery({ delivered: 'unknown', sentAt, now: at(4_000), resent: 0 })).toBe('wait');
    expect(confirmFirstDelivery({ delivered: 'unknown', sentAt, now: at(FIRST_DELIVERY_GIVE_UP_MS + 1), resent: 0 })).toBe('resend');
    expect(confirmFirstDelivery({ delivered: 'unknown', sentAt, now: at(FIRST_DELIVERY_GIVE_UP_MS + 1), resent: 1 })).toBe('failed');
  });

  it('missing waits its own shorter while; partial is sent again at once', () => {
    expect(confirmFirstDelivery({ delivered: 'missing', sentAt, now: at(MISSING_GIVE_UP_MS - 1), resent: 0 })).toBe('wait');
    expect(confirmFirstDelivery({ delivered: 'missing', sentAt, now: at(MISSING_GIVE_UP_MS + 1), resent: 0 })).toBe('resend');
    expect(confirmFirstDelivery({ delivered: 'partial', sentAt, now: at(4_000), resent: 0 })).toBe('resend');
    expect(confirmFirstDelivery({ delivered: 'partial', sentAt, now: at(4_000), resent: 1 })).toBe('failed');
  });
});

describe('watchFirstTurn', () => {
  const deliveredAt = T0.toISOString();
  const view = { running: true, switching: false, phase: 'replying' as const };
  it('a CLI that quits before its first turn is over has not taken over', () => {
    expect(watchFirstTurn({ ...view, running: false, deliveredAt, now: at(2_000) })).toBe('exited');
    // A relaunch in progress isn't a quit.
    expect(watchFirstTurn({ ...view, running: false, switching: true, deliveredAt, now: at(2_000) })).toBe('watching');
  });

  it('is over once that turn ends, or the CLI is still at it after a while', () => {
    expect(watchFirstTurn({ ...view, deliveredAt, now: at(30_000) })).toBe('watching');
    expect(watchFirstTurn({ ...view, phase: 'idle', deliveredAt, now: at(30_000) })).toBe('over');
    expect(watchFirstTurn({ ...view, phase: 'awaiting_approval', deliveredAt, now: at(5_000) })).toBe('over');
    expect(watchFirstTurn({ ...view, deliveredAt, now: at(FIRST_TURN_WATCH_MS + 1) })).toBe('over');
  });
});

describe('afterExit', () => {
  it('starts the CLI again once when it quit to finish updating itself, never otherwise', () => {
    expect(afterExit(screen('cli_updated'), newLaunchGuard())).toEqual({ relaunch: true, why: 'cli_updated', tail: 'cli_updated tail' });
    expect(afterExit(screen('cli_updated'), { ...newLaunchGuard(), relaunches: 1 })).toEqual({ relaunch: false, tail: 'cli_updated tail' });
    expect(afterExit(screen('unknown'), newLaunchGuard())).toEqual({ relaunch: false, tail: 'unknown tail' });
    expect(afterExit(null, newLaunchGuard())).toEqual({ relaunch: false, tail: null });
  });
});
