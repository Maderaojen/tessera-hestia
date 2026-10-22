import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContinuity, decodeContinuityState, emptyContinuityState } from '../../src/continuity/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { fakePorts, hit, newWorld, sessionView, type World } from './fake-ports.js';

let dir: string;
let file: string;
let world: World;

// Carrying on after a reset is off by default (the user turns it on);
// these tests are about it, so it's on.
function carryingOn() {
  const state = emptyContinuityState();
  state.defaults.mode = 'wait_resume';
  return state;
}

function makeStore() {
  return jsonFileStore({ path: file, empty: carryingOn, decode: decodeContinuityState });
}

function makeEngine() {
  return createContinuity(fakePorts(world), makeStore());
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'continuity-'));
  file = path.join(dir, 'continuity.json');
  world = newWorld();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('continuity engine', () => {
  it('schedules a new hit, tells the user when, and writes it down', async () => {
    const engine = makeEngine();
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.pending).toMatchObject({ conversationId: 'c1', wakeAt: '2026-10-03T15:32:00.000Z', postponed: 0 });
    expect(view.history.map((event) => event.kind)).toEqual(['scheduled']);
    await flush();
    expect(world.notices).toEqual([{ sessionId: 's1', body: expect.stringMatching(/^已達額度上限，將在 .+ 自動繼續$/) }]);
    const saved = JSON.parse(await readFile(file, 'utf-8'));
    expect(saved.sessions.s1.pending.wakeAt).toBe('2026-10-03T15:32:00.000Z');
  });

  it('tells which account is over its limit until that limit resets', async () => {
    const engine = makeEngine();
    await engine.scan();
    expect(await engine.accountLimitedUntil('janus:claude:work')).toBe(hit.resetsAt);
    expect(await engine.accountLimitedUntil('janus:claude:personal')).toBeNull();
    world.now = new Date(Date.parse(hit.resetsAt!) + 1);
    expect(await engine.accountLimitedUntil('janus:claude:work')).toBeNull();
  });

  it('handles the same hit once', async () => {
    const engine = makeEngine();
    await engine.scan();
    await engine.scan();
    expect((await engine.getSession('s1')).history).toHaveLength(1);
  });

  it('leaves a conversation that has sat on an old limit for days alone', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, at: '2026-09-26T00:00:03.612Z', resetsAt: '2026-09-26T03:30:00.000Z' } });
    const engine = makeEngine();
    await engine.scan();
    world.now = new Date('2026-10-03T14:00:00.000Z');
    await engine.runDue();
    const view = await engine.getSession('s1');
    expect(view.pending).toBeNull();
    expect(view.history).toEqual([expect.objectContaining({ kind: 'detected', detail: expect.stringMatching(/^stale: /) })]);
    await flush();
    expect(world.notices).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  it('looks only at idle, running sessions', async () => {
    world.sessions.set('s1', sessionView({ phase: 'replying' }));
    const engine = makeEngine();
    await engine.scan();
    expect((await engine.getSession('s1')).pending).toBeNull();
  });

  it('after a restart, carries on when due with the configured prompt', async () => {
    await makeEngine().scan();
    // A new process: a fresh engine and store over the same file.
    const engine = makeEngine();
    world.now = new Date('2026-10-03T15:31:00.000Z');
    await engine.runDue();
    expect(world.sent).toEqual([]);
    world.now = new Date('2026-10-03T15:32:00.000Z');
    await engine.runDue();
    expect(world.sent).toEqual([{ sessionId: 's1', text: '額度已重置，請從剛才中斷的地方繼續。' }]);
    const view = await engine.getSession('s1');
    expect(view.pending).toBeNull();
    expect(view.history.map((event) => event.kind)).toEqual(['scheduled', 'resumed']);
  });

  it('sends nothing when the user already carried on', async () => {
    const engine = makeEngine();
    await engine.scan();
    world.hits.set('s1', null);
    world.now = new Date('2026-10-03T15:32:00.000Z');
    await engine.runDue();
    expect(world.sent).toEqual([]);
    expect((await engine.getSession('s1')).history.at(-1)).toMatchObject({ kind: 'dropped', detail: 'already_continued' });
  });

  it('puts it off while the CLI waits on a prompt', async () => {
    const engine = makeEngine();
    await engine.scan();
    world.sendOutcome = { status: 'blocked', reason: 'interaction_pending' };
    world.now = new Date('2026-10-03T15:32:00.000Z');
    await engine.runDue();
    expect((await engine.getSession('s1')).pending).toMatchObject({ wakeAt: '2026-10-03T15:37:00.000Z', postponed: 1 });
  });

  it('a failed send is reported and not retried', async () => {
    const engine = makeEngine();
    await engine.scan();
    world.sendOutcome = { status: 'failed', reason: 'session is dead' };
    world.now = new Date('2026-10-03T15:32:00.000Z');
    await engine.runDue();
    await flush();
    expect((await engine.getSession('s1')).pending).toBeNull();
    expect(world.notices.at(-1)?.body).toBe('額度已重置，但自動繼續失敗：session is dead');
  });

  it('stops carrying on after the daily cap', async () => {
    const engine = makeEngine();
    await engine.setDefaults({ maxAutoResumesPerDay: 1 });
    await engine.scan();
    world.now = new Date('2026-10-03T15:32:00.000Z');
    await engine.runDue();
    // Hit again right after carrying on.
    world.sessions.set('s1', sessionView());
    world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, at: '2026-10-03T15:33:00.000Z', resetsAt: '2026-10-03T20:30:00.000Z' } });
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.pending).toBeNull();
    expect(view.history.at(-1)).toMatchObject({ kind: 'daily_cap', detail: '1' });
  });

  it('a session set to off only records the hit', async () => {
    const engine = makeEngine();
    await engine.setSession('s1', { mode: 'off' });
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.effective.mode).toBe('off');
    expect(view.pending).toBeNull();
    expect(view.history.map((event) => event.kind)).toEqual(['detected']);
    await flush();
    expect(world.notices).toEqual([]);
  });

  describe('a CLI that carries on by itself', () => {
    const selfResuming = { conversationId: 'c1', hit: { ...hit, cliResumesAt: hit.resetsAt! } };

    it('shows when it will, in any mode, and sends nothing', async () => {
      world.hits.set('s1', selfResuming);
      const engine = makeEngine();
      await engine.setSession('s1', { mode: 'off' });
      await engine.scan();
      const view = await engine.getSession('s1');
      expect(view.pending).toMatchObject({ by: 'cli', wakeAt: '2026-10-03T15:32:00.000Z' });
      expect(view.history).toEqual([expect.objectContaining({ kind: 'cli_will_resume', detail: hit.resetsAt })]);
      await flush();
      expect(world.notices).toEqual([{ sessionId: 's1', body: expect.stringMatching(/^已達額度上限，CLI 會在 .+ 自行繼續$/) }]);
      world.hits.set('s1', null);
      world.now = new Date('2026-10-03T15:32:00.000Z');
      await engine.runDue();
      expect(world.sent).toEqual([]);
      expect((await engine.getSession('s1')).pending).toBeNull();
      expect((await engine.getSession('s1')).history.at(-1)).toMatchObject({ kind: 'resumed', detail: 'cli' });
    });

    it('still on the hit after: says so and sends nothing (it was cancelled in the terminal)', async () => {
      world.hits.set('s1', selfResuming);
      const engine = makeEngine();
      await engine.scan();
      world.now = new Date('2026-10-03T15:32:00.000Z');
      await engine.runDue();
      expect(world.sent).toEqual([]);
      expect((await engine.getSession('s1')).history.at(-1)).toMatchObject({ kind: 'dropped', detail: 'cli_did_not_resume' });
      await flush();
      expect(world.notices.at(-1)?.body).toMatch(/CLI 沒有自行繼續/);
    });

    it('does not count toward the daily cap', async () => {
      world.hits.set('s1', selfResuming);
      const engine = makeEngine();
      await engine.setDefaults({ maxAutoResumesPerDay: 0 });
      await engine.scan();
      expect((await engine.getSession('s1')).pending).toMatchObject({ by: 'cli' });
    });
  });

  it('null puts a session back on the defaults', async () => {
    const engine = makeEngine();
    await engine.setSession('s1', { mode: 'off', resumePrompt: 'go on' });
    const view = await engine.setSession('s1', { mode: null });
    expect(view.override).toEqual({ resumePrompt: 'go on' });
    expect(view.effective).toMatchObject({ mode: 'wait_resume', resumePrompt: 'go on' });
  });

  it('cancels a pending carry-on', async () => {
    const engine = makeEngine();
    await engine.scan();
    const view = await engine.cancelPending('s1');
    expect(view.pending).toBeNull();
    expect(view.history.at(-1)?.kind).toBe('cancelled');
    world.now = new Date('2026-10-03T15:32:00.000Z');
    await engine.runDue();
    expect(world.sent).toEqual([]);
  });

  it('forgets sessions that no longer exist', async () => {
    const engine = makeEngine();
    await engine.scan();
    world.sessions.delete('s1');
    await engine.scan();
    expect(JSON.parse(await readFile(file, 'utf-8')).sessions).toEqual({});
  });

  it('the timer started from the saved schedule fires the carry-on', async () => {
    await makeEngine().scan();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const engine = makeEngine();
    await engine.start();
    world.now = new Date('2026-10-03T15:32:00.000Z');
    // Due in 1h52m: the timer re-arms at least hourly, so two hops.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    engine.stop();
    expect(world.sent).toHaveLength(1);
  });
});
