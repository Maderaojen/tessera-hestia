import { describe, expect, it } from 'vitest';
import { awaitedTurnLanded, type TurnChanges } from '../../src/sync/turns.js';
import type { Turn } from '../../src/types.js';

function turn(index: number, userAt: string, followUpAts: string[] = []): Turn {
  return {
    index,
    user: { text: `q${index}`, at: userAt },
    ...(followUpAts.length > 0 ? { followUps: followUpAts.map((at) => ({ text: 'more', at })) } : {}),
    assistant: { text: `a${index}`, at: userAt },
  };
}

const NONE: TurnChanges = { newTurns: [], grownLast: null };

describe('awaitedTurnLanded', () => {
  const earlier = turn(1, '2026-10-05T02:00:00.000Z');

  it('counts a new turn as the awaited one arriving', () => {
    expect(awaitedTurnLanded({ turns: [earlier], lastUserMessageAt: '2026-10-05T02:10:00.000Z' }, { newTurns: [turn(2, '2026-10-05T02:10:01.000Z')], grownLast: null })).toBe(true);
  });

  it('counts the last stored turn when it holds the send — it was stored while still being written', () => {
    const stored = turn(2, '2026-10-05T02:09:59.500Z'); // recorded a moment before the send was
    expect(awaitedTurnLanded({ turns: [earlier, stored], lastUserMessageAt: '2026-10-05T02:10:00.000Z' }, NONE)).toBe(true);
  });

  it('does not count an earlier turn growing while a later send waits', () => {
    const grown = { ...earlier, assistant: { text: 'a1 and more', at: earlier.assistant.at } };
    expect(awaitedTurnLanded({ turns: [earlier], lastUserMessageAt: '2026-10-05T02:10:00.000Z' }, { newTurns: [], grownLast: grown })).toBe(false);
  });

  it('counts a send that joined the last turn as a follow-up', () => {
    const joined = turn(1, '2026-10-05T02:00:00.000Z', ['2026-10-05T02:10:02.000Z']);
    expect(awaitedTurnLanded({ turns: [earlier], lastUserMessageAt: '2026-10-05T02:10:00.000Z' }, { newTurns: [], grownLast: joined })).toBe(true);
  });

  it('does not hold a reply open on a transcript without usable times', () => {
    expect(awaitedTurnLanded({ turns: [{ ...earlier, user: { text: 'q', at: null } }], lastUserMessageAt: '2026-10-05T02:10:00.000Z' }, NONE)).toBe(true);
  });

  it('does not hold a reply open with no send time to compare against', () => {
    expect(awaitedTurnLanded({ turns: [earlier], lastUserMessageAt: null }, NONE)).toBe(true);
  });

  it('is false with nothing stored', () => {
    expect(awaitedTurnLanded({ turns: [], lastUserMessageAt: '2026-10-05T02:10:00.000Z' }, NONE)).toBe(false);
  });
});
