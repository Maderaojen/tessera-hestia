import { describe, expect, it } from 'vitest';
import { DELIVERY_ECHO_TIMEOUT_MS } from '../../src/config.js';
import { dismissSend, reconcileSends, recordSend, sendTransitions } from '../../src/sync/delivery.js';

const T0 = Date.parse('2026-09-25T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const user = (text: string, offsetMs: number) => ({ role: 'user' as const, text, ts: at(offsetMs) });

describe('recordSend', () => {
  it('tracks real sends and never slash commands or blank text', () => {
    let sends = recordSend(undefined, 'hello', at(0));
    sends = recordSend(sends, '/clear', at(1));
    sends = recordSend(sends, '   ', at(2));
    expect(sends).toEqual([{ text: 'hello', at: at(0), flagged: false }]);
  });

  it('keeps earlier sends when a new one arrives, up to a bounded list', () => {
    let sends = recordSend(undefined, 'first', at(0));
    sends = recordSend(sends, 'second', at(1));
    expect(sends.map((send) => send.text)).toEqual(['first', 'second']);
    for (let index = 0; index < 20; index += 1) sends = recordSend(sends, `m${index}`, at(10 + index));
    expect(sends).toHaveLength(10);
    expect(sends.at(-1)?.text).toBe('m19');
  });
});

describe('reconcileSends', () => {
  it('confirms a send by a matching user message at or after it', () => {
    const sends = recordSend(undefined, 'hello there', at(0));
    expect(reconcileSends(sends, [user('hello there', 500)], T0 + 1_000)).toEqual([]);
  });

  it('ignores a matching message from before the send (an earlier identical prompt)', () => {
    const sends = recordSend(undefined, 'yes', at(60_000));
    expect(reconcileSends(sends, [user('yes', 0)], T0 + 61_000)).toBeNull();
  });

  it('flags an unconfirmed send only once the timeout has passed, and only once', () => {
    const sends = recordSend(undefined, 'hello', at(0));
    expect(reconcileSends(sends, [], T0 + DELIVERY_ECHO_TIMEOUT_MS - 1)).toBeNull();
    const flagged = reconcileSends(sends, [], T0 + DELIVERY_ECHO_TIMEOUT_MS);
    expect(flagged).toEqual([{ text: 'hello', at: at(0), flagged: true }]);
    expect(reconcileSends(flagged!, [], T0 + 10 * DELIVERY_ECHO_TIMEOUT_MS)).toBeNull();
  });

  it('flags without any transcript at all (no evidence is itself the signal)', () => {
    const sends = recordSend(undefined, 'hello', at(0));
    expect(reconcileSends(sends, null, T0 + DELIVERY_ECHO_TIMEOUT_MS)).toEqual([{ text: 'hello', at: at(0), flagged: true }]);
  });

  it('matches each echo to one send, so a repeated prompt needs a repeated echo', () => {
    let sends = recordSend(undefined, 'again', at(0));
    sends = recordSend(sends, 'again', at(1_000));
    const next = reconcileSends(sends, [user('again', 1_500)], T0 + DELIVERY_ECHO_TIMEOUT_MS + 2_000);
    expect(next).toEqual([{ text: 'again', at: at(1_000), flagged: true }]);
  });

  it('tolerates whitespace reformatting, and containment only for long texts', () => {
    const long = recordSend(undefined, 'please review\n\nthe launch flow carefully', at(0));
    expect(reconcileSends(long, [user('please review the launch flow carefully', 100)], T0 + 200)).toEqual([]);
    const wrapped = recordSend(undefined, 'please review the launch flow', at(0));
    expect(reconcileSends(wrapped, [user('[context] please review the launch flow', 100)], T0 + 200)).toEqual([]);
    const short = recordSend(undefined, 'hi', at(0));
    expect(reconcileSends(short, [user('hi there', 100)], T0 + 200)).toBeNull();
  });

  it('never lets assistant text confirm a send', () => {
    const sends = recordSend(undefined, 'hello', at(0));
    expect(reconcileSends(sends, [{ role: 'assistant', text: 'hello', ts: at(100) }], T0 + 200)).toBeNull();
  });
});

describe('mid-reply sends', () => {
  it('marks a send made while a reply was in progress', () => {
    expect(recordSend(undefined, 'more context', at(0), true)).toEqual([{ text: 'more context', at: at(0), flagged: false, midReply: true }]);
  });

  it('is confirmed by a follow-up the CLI took in mid-turn', () => {
    const sends = recordSend(undefined, 'more context please', at(0), true);
    const followUp = { ...user('more context please', 200), followUp: true };
    expect(reconcileSends(sends, [followUp], T0 + 1_000)).toEqual([]);
  });

  it('holds back the timeout while the reply it waited on is still in progress', () => {
    const sends = recordSend(undefined, 'queued', at(0), true);
    const later = T0 + 3 * DELIVERY_ECHO_TIMEOUT_MS;
    // Reply seen just now: not overdue however long ago the send was.
    expect(reconcileSends(sends, [], later, later - 1_000)).toBeNull();
    // Reply over for the whole timeout: now it is.
    expect(reconcileSends(sends, [], later, later - DELIVERY_ECHO_TIMEOUT_MS)?.[0]?.flagged).toBe(true);
  });

  it('keeps the plain clock for a send made from idle, even while its own reply runs', () => {
    const sends = recordSend(undefined, 'hello', at(0));
    const now = T0 + DELIVERY_ECHO_TIMEOUT_MS;
    expect(reconcileSends(sends, [], now, now)?.[0]?.flagged).toBe(true);
  });
});

describe('received before its text shows up', () => {
  const late = T0 + 3 * DELIVERY_ECHO_TIMEOUT_MS;

  it('takes a turn started right after an idle send as received, and holds the timeout', () => {
    const sends = recordSend(undefined, '完成了嗎？', at(0));
    const received = reconcileSends(sends, [], T0 + 1_000, undefined, [at(316)]);
    expect(received).toEqual([{ text: '完成了嗎？', at: at(0), flagged: false, receivedAt: at(316) }]);
    expect(reconcileSends(received!, [], late, undefined, [at(316)])).toBeNull();
    expect(reconcileSends(received!, [user('完成了嗎？', 101_728)], late, undefined, [at(316)])).toEqual([]);
  });

  it('clears a flag already raised once the turn start is seen', () => {
    const flagged = [{ text: 'hello', at: at(0), flagged: true }];
    expect(reconcileSends(flagged, [], late, undefined, [at(500)])).toEqual([{ text: 'hello', at: at(0), flagged: false, receivedAt: at(500) }]);
  });

  it('ignores turns that start long before or after the send', () => {
    const sends = recordSend(undefined, 'hello', at(60_000));
    const now = T0 + 60_000 + DELIVERY_ECHO_TIMEOUT_MS;
    expect(reconcileSends(sends, [], now, undefined, [at(0), at(60_000 + 20_000)])?.[0]).toEqual({ text: 'hello', at: at(60_000), flagged: true });
  });

  it('lets one turn start count for one send only', () => {
    let sends = recordSend(undefined, 'first', at(0));
    sends = recordSend(sends, 'second', at(1_000));
    const next = reconcileSends(sends, [], T0 + DELIVERY_ECHO_TIMEOUT_MS + 1_000, undefined, [at(1_200)]);
    expect(next?.map((send) => [send.text, send.receivedAt ?? null, send.flagged])).toEqual([['first', at(1_200), false], ['second', null, true]]);
  });

  it('never counts a turn start for a mid-reply send', () => {
    const sends = recordSend(undefined, 'queued', at(0), true);
    expect(reconcileSends(sends, [], T0 + 1_000, T0 + 1_000, [at(300)])).toBeNull();
  });

  it('falls back to the plain clock once the turn wrote a message that is not this one', () => {
    const received = [{ text: 'please review the launch flow', at: at(0), flagged: false, receivedAt: at(300) }];
    const other = [user('something else entirely', 90_000)];
    expect(reconcileSends(received, other, late, undefined, [at(300)])?.[0]?.flagged).toBe(true);
  });
});

describe('sendTransitions', () => {
  it('reports receipts, flags and late confirmations, not a plain timely one', () => {
    const plain = { text: 'a', at: at(0), flagged: false };
    const flagged = { text: 'b', at: at(1), flagged: true };
    const fresh = { text: 'c', at: at(2), flagged: false };
    const toReceive = { text: 'd', at: at(3), flagged: true };
    const after = [{ ...fresh, flagged: true }, { ...toReceive, flagged: false, receivedAt: at(300) }];
    expect(sendTransitions([plain, flagged, fresh, toReceive], after)).toEqual([
      { kind: 'confirmed', send: flagged },
      { kind: 'flagged', send: { ...fresh, flagged: true } },
      { kind: 'received', send: { ...toReceive, flagged: false, receivedAt: at(300) }, wasFlagged: true },
    ]);
  });
});

describe('dismissSend', () => {
  it('drops exactly the named send and reports no change for an unknown one', () => {
    let sends = recordSend(undefined, 'a', at(0));
    sends = recordSend(sends, 'b', at(1));
    expect(dismissSend(sends, at(0))).toEqual([{ text: 'b', at: at(1), flagged: false }]);
    expect(dismissSend(sends, at(99))).toBeNull();
  });
});
