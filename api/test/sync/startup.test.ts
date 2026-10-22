import { beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_DEAD_STABILITY_MS, RUNTIME_STARTUP_GRACE_MS } from '../../src/config.js';
import { forgetStartupObservation, judgeStartup } from '../../src/sync/startup.js';
import { trackerFor } from '../../src/sync/tracker.js';

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const dispatched = new Date(T0).toISOString();
let session = 0;
let id: string;

beforeEach(() => { id = `startup-${session += 1}`; });

describe('judgeStartup — the one post-dispatch rule for every CLI transition', () => {
  it('confirms on alive and waits on unknown, at any time', () => {
    expect(judgeStartup(id, 'a', 'alive', dispatched, T0)).toEqual({ verdict: 'confirmed' });
    expect(judgeStartup(id, 'a', 'unknown', dispatched, T0 + 10 * RUNTIME_STARTUP_GRACE_MS)).toEqual({ verdict: 'waiting', reason: 'unknown' });
  });

  it('never fails inside the startup grace, however long the pane stays a shell', () => {
    for (let t = T0; t < T0 + RUNTIME_STARTUP_GRACE_MS; t += 800) {
      expect(judgeStartup(id, 'a', 'dead', dispatched, t)).toEqual({ verdict: 'waiting', reason: 'grace' });
    }
  });

  it('after the grace, fails only once dead has persisted for the stability window', () => {
    const afterGrace = T0 + RUNTIME_STARTUP_GRACE_MS;
    expect(judgeStartup(id, 'a', 'dead', dispatched, afterGrace)).toEqual({ verdict: 'waiting', reason: 'stabilizing' });
    expect(judgeStartup(id, 'a', 'dead', dispatched, afterGrace + RUNTIME_DEAD_STABILITY_MS - 1)).toEqual({ verdict: 'waiting', reason: 'stabilizing' });
    expect(judgeStartup(id, 'a', 'dead', dispatched, afterGrace + RUNTIME_DEAD_STABILITY_MS)).toEqual({ verdict: 'failed' });
    expect(trackerFor(id).startupDead).toBeUndefined();
  });

  it('restarts the stability clock after any non-dead sample', () => {
    const afterGrace = T0 + RUNTIME_STARTUP_GRACE_MS;
    judgeStartup(id, 'a', 'dead', dispatched, afterGrace);
    judgeStartup(id, 'a', 'unknown', dispatched, afterGrace + 100);
    expect(judgeStartup(id, 'a', 'dead', dispatched, afterGrace + RUNTIME_DEAD_STABILITY_MS)).toEqual({ verdict: 'waiting', reason: 'stabilizing' });
  });

  it('never lets a new attempt inherit an earlier attempt\'s dead observation', () => {
    const afterGrace = T0 + RUNTIME_STARTUP_GRACE_MS;
    judgeStartup(id, 'first', 'dead', dispatched, afterGrace);
    expect(judgeStartup(id, 'second', 'dead', dispatched, afterGrace + RUNTIME_DEAD_STABILITY_MS)).toEqual({ verdict: 'waiting', reason: 'stabilizing' });
  });

  it('keeps waiting when the dispatch time is missing, invalid or in the future', () => {
    const late = T0 + 10 * RUNTIME_STARTUP_GRACE_MS;
    expect(judgeStartup(id, 'a', 'dead', null, late)).toEqual({ verdict: 'waiting', reason: 'grace' });
    expect(judgeStartup(id, 'a', 'dead', 'not-a-date', late)).toEqual({ verdict: 'waiting', reason: 'grace' });
    expect(judgeStartup(id, 'a', 'dead', new Date(late + 1).toISOString(), late)).toEqual({ verdict: 'waiting', reason: 'grace' });
  });

  it('forgetStartupObservation drops a pending dead observation', () => {
    judgeStartup(id, 'a', 'dead', dispatched, T0 + RUNTIME_STARTUP_GRACE_MS);
    forgetStartupObservation(id);
    expect(trackerFor(id).startupDead).toBeUndefined();
  });
});
