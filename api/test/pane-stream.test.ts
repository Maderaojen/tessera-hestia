import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capturePane = vi.fn();
const getPaneSize = vi.fn();
vi.mock('../src/tmux.js', () => ({
  capturePane: (...args: unknown[]) => capturePane(...args),
  getPaneSize: (...args: unknown[]) => getPaneSize(...args),
}));

let paneStream: typeof import('../src/pane-stream.js');

beforeEach(async () => {
  vi.useFakeTimers();
  capturePane.mockReset();
  getPaneSize.mockReset();
  getPaneSize.mockResolvedValue({ cols: 133, rows: 40 });
  paneStream = await import('../src/pane-stream.js');
  paneStream.__resetForTests();
});

afterEach(() => {
  paneStream.__resetForTests();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  // Let the fire-and-forget `void tick()` promise chain settle.
  await vi.advanceTimersByTimeAsync(0);
}

describe('pane-stream subscribe', () => {
  it('delivers an immediate snapshot to a new subscriber, including current pane size', async () => {
    capturePane.mockResolvedValue('screen v1');
    getPaneSize.mockResolvedValue({ cols: 133, rows: 40 });
    const updates: unknown[] = [];
    paneStream.subscribe('hestia-x', { ansi: true }, (u) => updates.push(u));
    await flush();
    expect(updates).toEqual([{ content: 'screen v1', cols: 133, rows: 40, capturedAt: expect.any(String) }]);
  });

  it('notifies again when only the pane size changes, even if content text is identical', async () => {
    capturePane.mockResolvedValue('same text');
    getPaneSize.mockResolvedValue({ cols: 80, rows: 24 });
    const updates: unknown[] = [];
    paneStream.subscribe('hestia-x', { ansi: true }, (u) => updates.push(u));
    await flush();
    expect(updates).toHaveLength(1);

    // A real terminal attached and tmux resized the pane (window-size
    // latest) — the text capture happens to be unchanged, but the frontend
    // still needs to know to re-render xterm.js at the new dimensions.
    getPaneSize.mockResolvedValue({ cols: 133, rows: 40 });
    await vi.advanceTimersByTimeAsync(700);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({ content: 'same text', cols: 133, rows: 40, capturedAt: expect.any(String) });
  });

  it('only notifies again when content actually changes', async () => {
    capturePane.mockResolvedValue('same');
    const updates: unknown[] = [];
    paneStream.subscribe('hestia-x', { ansi: true }, (u) => updates.push(u));
    await flush();
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(700);
    expect(updates).toHaveLength(1); // still "same" every tick — no duplicate events

    capturePane.mockResolvedValue('changed');
    await vi.advanceTimersByTimeAsync(700);
    expect(updates).toHaveLength(2);
  });

  it('shares one underlying poll loop across multiple subscribers to the same view', async () => {
    capturePane.mockResolvedValue('shared');
    paneStream.subscribe('hestia-x', { ansi: true }, () => {});
    paneStream.subscribe('hestia-x', { ansi: true }, () => {});
    await flush();
    const callsAfterSubscribe = capturePane.mock.calls.length;
    await vi.advanceTimersByTimeAsync(700);
    // one more capture-pane call total for the tick, not one per subscriber
    expect(capturePane.mock.calls.length).toBe(callsAfterSubscribe + 1);
  });

  it('stops polling once the last subscriber unsubscribes', async () => {
    capturePane.mockResolvedValue('x');
    const unsubscribe = paneStream.subscribe('hestia-x', { ansi: true }, () => {});
    await flush();
    unsubscribe();
    capturePane.mockClear();
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(700);
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('different history/ansi options for the same tmux session get separate loops', async () => {
    capturePane.mockResolvedValue('x');
    paneStream.subscribe('hestia-x', { ansi: true }, () => {});
    paneStream.subscribe('hestia-x', { ansi: true, history: 100 }, () => {});
    await flush();
    // two distinct capture-pane calls (different opts), not deduped together
    expect(capturePane.mock.calls.length).toBe(2);
  });

  it('notifies listeners with an error and stops polling if the pane disappears', async () => {
    capturePane.mockRejectedValue(new Error('no such pane'));
    const updates: unknown[] = [];
    paneStream.subscribe('hestia-x', { ansi: true }, (u) => updates.push(u));
    await flush();
    expect(updates).toEqual([{ error: 'pane is no longer available' }]);

    capturePane.mockClear();
    await vi.advanceTimersByTimeAsync(700);
    expect(capturePane).not.toHaveBeenCalled(); // loop already stopped itself
  });
});

describe('recentAnsiCapture', () => {
  it("hands out a running attribute loop's capture while it is fresh, never a plain one", async () => {
    capturePane.mockResolvedValue('\x1b[2mghost\x1b[0m');
    const stopPlain = paneStream.subscribe('hestia-y', {}, () => undefined);
    await flush();
    expect(paneStream.recentAnsiCapture('hestia-y', 1_500)).toBeNull();
    stopPlain();

    const stop = paneStream.subscribe('hestia-y', { ansi: true, history: 300 }, () => undefined);
    await flush();
    expect(paneStream.recentAnsiCapture('hestia-y', 1_500)).toBe('\x1b[2mghost\x1b[0m');
    expect(paneStream.recentAnsiCapture('hestia-y', 1_500, Date.now() + 5_000)).toBeNull();
    expect(paneStream.recentAnsiCapture('hestia-other', 1_500)).toBeNull();
    stop();
    expect(paneStream.recentAnsiCapture('hestia-y', 1_500)).toBeNull();
  });
});
