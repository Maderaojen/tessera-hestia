import { describe, expect, it } from 'vitest';
import { publish, subscribe, type SessionEvent } from '../src/session-stream.js';

describe('session-stream', () => {
  it('delivers a published event to a subscriber', () => {
    const received: SessionEvent[] = [];
    subscribe('s1', (e) => received.push(e));
    publish('s1', { type: 'deleted' });
    expect(received).toEqual([{ type: 'deleted' }]);
  });

  it('never crosses sessions', () => {
    const receivedA: SessionEvent[] = [];
    const receivedB: SessionEvent[] = [];
    subscribe('a', (e) => receivedA.push(e));
    subscribe('b', (e) => receivedB.push(e));
    publish('a', { type: 'deleted' });
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  it('delivers to every subscriber of the same session', () => {
    const one: SessionEvent[] = [];
    const two: SessionEvent[] = [];
    subscribe('s2', (e) => one.push(e));
    subscribe('s2', (e) => two.push(e));
    publish('s2', { type: 'deleted' });
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const received: SessionEvent[] = [];
    const unsubscribe = subscribe('s3', (e) => received.push(e));
    unsubscribe();
    publish('s3', { type: 'deleted' });
    expect(received).toHaveLength(0);
  });

  it('publishing with no subscribers is a silent no-op', () => {
    expect(() => publish('nobody-listening', { type: 'deleted' })).not.toThrow();
  });
});
