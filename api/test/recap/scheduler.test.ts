import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECAP_IDLE_MS, RECAP_LIMIT_RECHECK_MS } from '../../src/recap/constants.js';
import { completedTurns, createRecapScheduler, planRecap, type RecapScheduler } from '../../src/recap/scheduler.js';
import { emptyRecapSettings, recapSettingsStore, type RecapSettingsState } from '../../src/recap/settings-store.js';
import { userTextHash } from '../../src/recap/store.js';
import {
  addConversation, answerFor, at, conversation, fakePorts, MIN, newWorld, readPrompt, recapOf, setRecap, T0, turn, turns, type World,
} from './fake-ports.js';

let dir: string;
let world: World;
let file: string;

const ON: RecapSettingsState = {
  ...emptyRecapSettings(), enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabledAt: at(T0 - 60 * MIN),
};

async function makeScheduler(settings: RecapSettingsState = ON): Promise<RecapScheduler> {
  const store = recapSettingsStore(file);
  await store.save(settings);
  return createRecapScheduler(fakePorts(world), store);
}

const batchesRun = () => world.runs.map((run) => {
  const indexes = readPrompt(run.prompt).turns.map((t) => t.index);
  return [indexes[0], indexes.at(-1)];
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'recap-scheduler-'));
  file = path.join(dir, 'conversation-recap.json');
  world = newWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('waiting for a conversation to go quiet', () => {
  it('three turns a minute apart are recapped once, three minutes after the last', async () => {
    const scheduler = await makeScheduler();
    const list = [turn(0, at(T0))];
    addConversation(world, conversation('s1', 'c1', list));
    for (let i = 1; i <= 2; i += 1) {
      await scheduler.conversationChanged('s1', 'c1');
      world.now = new Date(T0 + i * MIN);
      await scheduler.tick();
      list.push(turn(i, at(T0 + i * MIN)));
      addConversation(world, conversation('s1', 'c1', list));
    }
    await scheduler.conversationChanged('s1', 'c1');
    world.now = new Date(T0 + 2 * MIN + RECAP_IDLE_MS - 1);
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    expect((await scheduler.sessionRecaps('s1'))!.conversations[0]!.state).toBe('waiting');

    world.now = new Date(T0 + 2 * MIN + RECAP_IDLE_MS);
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 2]]);
    expect(recapOf(world, 's1', 'c1')).toMatchObject({ coveredTurns: 3, generator: { profileId: 'native:codex', profileLabel: 'Codex (原生)', runtimeId: 'codex-cli', model: 'gpt-6-luna', effort: 'low' } });
    expect(world.runs[0]).toMatchObject({ profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low' });
    world.now = new Date(T0 + 30 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
  });

  it('a conversation still being replied to waits, and its last turn doesn\'t count', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(3), { replying: true }));
    await scheduler.scan();
    world.now = new Date(T0 + 10 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    const [view] = (await scheduler.sessionRecaps('s1'))!.conversations;
    expect(view).toMatchObject({ totalTurns: 2, pendingTurns: 2, state: 'waiting' });

    // Asked for, it runs without the last turn.
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 1]]);
    expect(completedTurns({ turns: turns(3), replying: true })).toHaveLength(2);
  });

  it('while the turn being answered isn\'t imported yet, every stored turn is a finished one', () => {
    expect(completedTurns({ turns: turns(3), replying: true, replyingTurnStored: false })).toHaveLength(3);
    expect(completedTurns({ turns: turns(3), replying: true, replyingTurnStored: true })).toHaveLength(2);
    expect(completedTurns({ turns: turns(3), replying: false, replyingTurnStored: false })).toHaveLength(3);
  });
});

describe('the queue', () => {
  it('a request goes in between two batches of background work, without stopping the one running', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'long', turns(45)));
    addConversation(world, conversation('s2', 'short', turns(2)));
    setRecap(world, conversation('s2', 'short', []), {});
    await scheduler.scan();
    world.now = new Date(T0 + RECAP_IDLE_MS);
    // While the first batch of the long one runs, the user asks for the short one.
    world.answers.push(async (request) => {
      const view = await scheduler.refresh('s2', 'short');
      expect(view.ok && view.value.state).toBe('queued');
      return { ok: true, output: answerFor(request.prompt) };
    });
    await scheduler.tick();
    const order = world.runs.map((run) => readPrompt(run.prompt).turns.length);
    expect(order).toEqual([20, 2, 20, 5]);
    expect(recapOf(world, 's1', 'long')!.coveredTurns).toBe(45);
    expect(recapOf(world, 's2', 'short')).toMatchObject({ coveredTurns: 2, requestedAt: null });
  });

  it('50 turns go in 3 batches; a failed second stops at 20, and asking again picks up from there', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(50)));
    world.answers.push((request) => ({ ok: true, output: answerFor(request.prompt) }), { ok: false, code: 'run_failed' });
    expect((await scheduler.refresh('s1', 'c1')).ok).toBe(true);
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 19], [20, 39]]);
    const recap = recapOf(world, 's1', 'c1')!;
    expect(recap).toMatchObject({ coveredTurns: 20, failures: 1, lastError: { code: 'run_failed', retryAt: at(T0 + MIN) } });
    const [view] = (await scheduler.sessionRecaps('s1'))!.conversations;
    expect(view).toMatchObject({ state: 'behind', coveredTurns: 20, pendingTurns: 30, error: { code: 'run_failed' } });

    // The request stands, but not before its backoff…
    await scheduler.tick();
    expect(world.runs).toHaveLength(2);
    // …unless the user asks again.
    world.now = new Date(T0 + 1000);
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 19], [20, 39], [20, 39], [40, 49]]);
    expect(recapOf(world, 's1', 'c1')).toMatchObject({ coveredTurns: 50, failures: 0, lastError: null, requestedAt: null });
    expect((await scheduler.sessionRecaps('s1'))!.conversations[0]!.state).toBe('up_to_date');
  });

  it('a malformed answer is tried once more straight away; twice is a failure, retried after the backoff', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    world.answers.push({ ok: false, code: 'invalid_output' });
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect(world.runs).toHaveLength(2);
    expect(recapOf(world, 's1', 'c1')).toMatchObject({ coveredTurns: 2, failures: 0 });

    addConversation(world, conversation('s1', 'c2', turns(2)));
    // The answer breaks the merge rules (an empty title), both times.
    const bad = { ok: true as const, output: { items: [{ id: null, title: ' ', status: 'uncertain' as const, turns: { from: 0, to: 0 }, mergedFrom: [] }] } };
    world.answers.push(bad, bad);
    await scheduler.refresh('s1', 'c2');
    await scheduler.tick();
    expect(world.runs).toHaveLength(4);
    expect(recapOf(world, 's1', 'c2')).toMatchObject({ coveredTurns: 0, failures: 1, items: [], lastError: { code: 'invalid_output', retryAt: at(T0 + MIN) } });
    expect((await scheduler.sessionRecaps('s1'))!.conversations.find((v) => v.conversationId === 'c2')).toMatchObject({ state: 'failed', error: { code: 'invalid_output' } });

    world.now = new Date(T0 + MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(5);
    expect(recapOf(world, 's1', 'c2')).toMatchObject({ coveredTurns: 2, failures: 0 });
  });

  it('failures in a row back off longer each time', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    await scheduler.scan();
    const waits = [MIN, 5 * MIN, 30 * MIN, 120 * MIN, 120 * MIN];
    let now = T0 + RECAP_IDLE_MS;
    for (const wait of waits) {
      world.now = new Date(now);
      world.answers.push({ ok: false, code: 'run_timeout' });
      await scheduler.tick();
      expect(recapOf(world, 's1', 'c1')!.lastError).toMatchObject({ code: 'run_timeout', retryAt: at(now + wait) });
      now += wait;
    }
    expect(world.runs).toHaveLength(5);
  });

  it('turning recaps off empties the queue; the batch already running is still written', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(30)));
    addConversation(world, conversation('s2', 'c1', turns(2)));
    await scheduler.scan();
    world.now = new Date(T0 + RECAP_IDLE_MS);
    world.answers.push(async (request) => {
      expect((await scheduler.updateSettings({ enabled: false })).ok).toBe(true);
      return { ok: true, output: answerFor(request.prompt) };
    });
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    expect(recapOf(world, 's1', 'c1')!.coveredTurns).toBe(20);
    expect((await scheduler.getSettings()).queue).toEqual({ running: null, waiting: 0 });
    expect((await scheduler.refresh('s1', 'c1'))).toMatchObject({ ok: false, status: 409, code: 'recap_disabled' });
    expect((await scheduler.sessionRecaps('s1'))!.conversations[0]!.state).toBe('disabled');
  });

  it('turns that moved while the batch ran: planned again, and a failure if they keep moving', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    let edits = 0;
    const moveTurns = (conversationId: string) => (request: { prompt: string }) => {
      edits += 1;
      addConversation(world, conversation('s1', conversationId, [turn(0, at(T0), `改寫第 ${edits} 次`), turn(1)]));
      return { ok: true as const, output: answerFor(request.prompt) };
    };
    world.answers.push(moveTurns('c1'));
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect(world.runs).toHaveLength(2);
    expect(recapOf(world, 's1', 'c1')).toMatchObject({ coveredTurns: 2, failures: 0 });

    addConversation(world, conversation('s1', 'c2', turns(2)));
    world.answers.push(moveTurns('c2'), moveTurns('c2'), moveTurns('c2'));
    await scheduler.refresh('s1', 'c2');
    await scheduler.tick();
    expect(world.runs).toHaveLength(5);
    expect(recapOf(world, 's1', 'c2')).toMatchObject({ coveredTurns: 0, failures: 1, lastError: { code: 'run_failed' } });
  });

  it('a conversation in the trash is not recapped', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2), { trashed: true }));
    await scheduler.scan();
    world.now = new Date(T0 + RECAP_IDLE_MS);
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    expect(await scheduler.sessionRecaps('s1')).toBeNull();
    expect(await scheduler.refresh('s1', 'c1')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
  });
});

describe('conversations from before the recaps were turned on', () => {
  const enabledAt = T0 + 10 * MIN;
  const settings = { ...ON, enabledAt: at(enabledAt) };

  it('with nothing new: waits for 建立摘要, which then recaps it from the start', async () => {
    const scheduler = await makeScheduler(settings);
    addConversation(world, conversation('s1', 'old', turns(3)));
    await scheduler.scan();
    world.now = new Date(enabledAt + 60 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    expect((await scheduler.getSettings()).queue.waiting).toBe(0);
    expect((await scheduler.sessionRecaps('s1'))!.conversations[0]).toMatchObject({ state: 'not_created', items: [], coveredTurns: 0, totalTurns: 3 });

    const asked = await scheduler.refresh('s1', 'old');
    expect(asked.ok && asked.value.state).toBe('queued');
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 2]]);
  });

  it('with a turn since: the whole conversation is recapped, from its first turn', async () => {
    const scheduler = await makeScheduler(settings);
    addConversation(world, conversation('s1', 'c1', [...turns(3), turn(3, at(enabledAt + MIN))]));
    await scheduler.scan();
    world.now = new Date(enabledAt + 60 * MIN);
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 3]]);
  });

  it('a turn without a time is not one from since', () => {
    const plan = planRecap({ conversation: conversation('s1', 'c1', [turn(0, null)]), recap: null, settings, changedAt: T0 });
    expect(plan).toEqual({ kind: 'not_created' });
  });

  it('with backfillOld: recapped too, after everything else, newest first', async () => {
    const scheduler = await makeScheduler({ ...settings, backfillOld: true });
    addConversation(world, conversation('s1', 'older', turns(2, T0)));
    addConversation(world, conversation('s2', 'newer', turns(2, T0 + 5 * MIN)));
    addConversation(world, conversation('s3', 'fresh', [turn(0, at(enabledAt + MIN))]));
    await scheduler.scan();
    world.now = new Date(enabledAt + 60 * MIN);
    await scheduler.tick();
    expect(world.runs.map((run) => readPrompt(run.prompt).turns[0]!.index)).toHaveLength(3);
    expect([...world.recaps.keys()].map((key) => key.split('\n')[1])).toEqual(['fresh', 'newer', 'older']);

    // Turned off again: nothing more is backfilled.
    addConversation(world, conversation('s4', 'oldest', turns(2, T0 - 5 * MIN)));
    await scheduler.updateSettings({ backfillOld: false });
    await scheduler.tick();
    expect(world.runs).toHaveLength(3);
  });
});

// Backfilling older
// conversations is throttled like everything else.
describe('backfilling older conversations', () => {
  const enabledAt = T0 + 10 * MIN;
  const settings = { ...ON, enabledAt: at(enabledAt), backfillOld: true };
  // Answers that note how many batches run at once.
  function countingAnswers(count: number, during?: (index: number) => Promise<void>) {
    let running = 0;
    const seen = { most: 0 };
    for (let index = 0; index < count; index += 1) {
      world.answers.push(async (request) => {
        running += 1;
        seen.most = Math.max(seen.most, running);
        await during?.(index);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return { ok: true, output: answerFor(request.prompt) };
      });
    }
    return seen;
  }

  it('one batch at a time, and a request or new turns go ahead of the rest of it', async () => {
    const scheduler = await makeScheduler(settings);
    addConversation(world, conversation('s1', 'old', turns(45, T0)));
    addConversation(world, conversation('s2', 'asked', turns(2, T0 - MIN)));
    await scheduler.scan();
    world.now = new Date(enabledAt + 60 * MIN);
    const seen = countingAnswers(10, async (index) => {
      if (index !== 0) return;
      // While old's first batch runs: new turns elsewhere, and a request.
      addConversation(world, conversation('s3', 'fresh', [turn(0, at(enabledAt + 61 * MIN))]));
      await scheduler.scan();
      await scheduler.refresh('s2', 'asked');
    });
    await scheduler.tick();
    world.now = new Date(enabledAt + 61 * MIN + RECAP_IDLE_MS);
    await scheduler.tick();
    expect(seen.most).toBe(1);
    // Batches by size: old's 45 turns go 20, 20, 5; asked has 2, fresh 1.
    const order = world.runs.map((run) => readPrompt(run.prompt).turns.length);
    // The request right after the batch running; old carries on, fresh once quiet long enough.
    expect(order.slice(0, 2)).toEqual([20, 2]);
    expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 5, 20, 20]);
    expect(recapOf(world, 's1', 'old')!.coveredTurns).toBe(45);
  });

  it('turned off part way: the batch running is written, and no other backfill starts', async () => {
    const scheduler = await makeScheduler(settings);
    addConversation(world, conversation('s1', 'old', turns(2, T0)));
    addConversation(world, conversation('s2', 'older', turns(2, T0 - 5 * MIN)));
    await scheduler.scan();
    world.now = new Date(enabledAt + 60 * MIN);
    countingAnswers(5, async (index) => {
      if (index === 0) await scheduler.updateSettings({ backfillOld: false });
    });
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    expect(recapOf(world, 's1', 'old')!.coveredTurns).toBe(2);
    expect(recapOf(world, 's2', 'older')).toBeUndefined();
    expect((await scheduler.getSettings()).queue.waiting).toBe(0);
  });

  it('stops while the account is over its limit, and carries on after', async () => {
    const scheduler = await makeScheduler(settings);
    addConversation(world, conversation('s1', 'old', turns(2, T0)));
    addConversation(world, conversation('s2', 'older', turns(2, T0 - 5 * MIN)));
    await scheduler.scan();
    world.now = new Date(enabledAt + 60 * MIN);
    const until = at(enabledAt + 120 * MIN);
    world.answers.push({ ok: false, code: 'account_limited', until });
    await scheduler.tick();
    world.now = new Date(enabledAt + 119 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    world.now = new Date(enabledAt + 120 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(3);
    expect(recapOf(world, 's1', 'old')!.coveredTurns).toBe(2);
    expect(recapOf(world, 's2', 'older')!.coveredTurns).toBe(2);
  });
});

describe('pausing', () => {
  it('an account no longer there pauses everything, and only another choice lifts it', async () => {
    const scheduler = await makeScheduler();
    world.accounts.delete('native:codex');
    world.profiles = world.profiles.filter((profile) => profile.id !== 'native:codex');
    addConversation(world, conversation('s1', 'c1', turns(2)));
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    const settings = await scheduler.getSettings();
    expect(settings.pause).toMatchObject({ code: 'profile_unavailable', until: null });
    expect((await scheduler.sessionRecaps('s1'))!.conversations[0]).toMatchObject({ state: 'paused', pause: { code: 'profile_unavailable' } });
    expect(world.events.at(-1)).toMatchObject({ type: 'recap', sessionId: 's1', conversationId: 'c1', state: 'paused' });

    world.now = new Date(T0 + 24 * 60 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);

    expect((await scheduler.updateSettings({ profileId: 'janus:claude:personal', model: 'haiku', effort: null })).ok).toBe(true);
    await scheduler.tick();
    expect(world.runs).toEqual([expect.objectContaining({ profileId: 'janus:claude:personal', model: 'haiku', effort: null })]);
    expect((await scheduler.getSettings()).pause).toBeNull();
  });

  it('a model the account refuses pauses everything until another model is picked; no other account is tried', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    addConversation(world, conversation('s2', 'c1', turns(2)));
    world.answers.push({ ok: false, code: 'model_rejected' });
    await scheduler.scan();
    world.now = new Date(T0 + RECAP_IDLE_MS);
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    expect((await scheduler.getSettings()).pause).toMatchObject({ code: 'model_rejected' });
    expect(recapOf(world, 's1', 'c1')?.failures ?? 0).toBe(0);
    await scheduler.updateSettings({ effort: 'medium' });
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    await scheduler.updateSettings({ model: 'gpt-6.1-sol', effort: 'low' });
    await scheduler.tick();
    expect(world.runs.map((run) => run.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol']);
  });

  it('an account over its limit until a known time resumes at that time', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    const until = at(T0 + 90 * MIN);
    world.answers.push({ ok: false, code: 'account_limited', until });
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect((await scheduler.getSettings()).pause).toEqual({ code: 'account_limited', until, at: at(T0) });
    world.now = new Date(T0 + 90 * MIN - 1);
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    world.now = new Date(T0 + 90 * MIN);
    await scheduler.tick();
    expect(world.runs).toHaveLength(2);
    expect((await scheduler.getSettings()).pause).toBeNull();
    expect(recapOf(world, 's1', 'c1')!.coveredTurns).toBe(2);
  });

  it('an account known to be over its limit is not run on; without a reset time it is looked at again every 15 minutes', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    world.accounts.set('native:codex', { available: true, label: 'Codex (原生)', runtimeId: 'codex-cli', limited: { until: null } });
    await scheduler.refresh('s1', 'c1');
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    expect((await scheduler.getSettings()).pause).toMatchObject({ code: 'account_limited', until: null });

    world.accounts.set('native:codex', { available: true, label: 'Codex (原生)', runtimeId: 'codex-cli', limited: null });
    world.now = new Date(T0 + RECAP_LIMIT_RECHECK_MS - 1);
    await scheduler.tick();
    expect(world.runs).toHaveLength(0);
    world.now = new Date(T0 + RECAP_LIMIT_RECHECK_MS);
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
  });
});

describe('starting up', () => {
  it('a request made before the restart is first in line, without waiting', async () => {
    const owner = conversation('s1', 'asked', turns(2));
    addConversation(world, conversation('s0', 'busy', turns(2)));
    addConversation(world, owner);
    setRecap(world, owner, { requestedAt: at(T0 - MIN) });
    const scheduler = await makeScheduler();
    await scheduler.scan();
    // The other conversation only becomes due once quiet since start-up.
    await scheduler.tick();
    expect(world.runs).toHaveLength(1);
    expect(recapOf(world, 's1', 'asked')).toMatchObject({ coveredTurns: 2, requestedAt: null });
  });

  it('a recap whose turns shifted is made again from the start, keeping the user\'s items', async () => {
    const owner = addConversation(world, conversation('s1', 'c1', turns(4)));
    const mine = {
      id: 'r_mine0000', title: '使用者的項目', status: 'accepted' as const, statusSource: 'user' as const, turns: { from: 1, to: 1 },
      createdAt: at(T0), updatedAt: at(T0), statusChangedAt: at(T0),
    };
    // Covered 3 turns, but the third no longer reads as it did.
    setRecap(world, owner, { items: [mine], coveredTurns: 3, lastCovered: { index: 2, userAt: at(T0 + 2000), userTextHash: userTextHash('另一段文字') } });
    const scheduler = await makeScheduler();
    await scheduler.scan();
    const [view] = (await scheduler.sessionRecaps('s1'))!.conversations;
    expect(view).toMatchObject({ coveredTurns: 0, pendingTurns: 4 });
    world.now = new Date(T0 + RECAP_IDLE_MS);
    await scheduler.tick();
    expect(batchesRun()).toEqual([[0, 3]]);
    expect(readPrompt(world.runs[0]!.prompt).previous).toEqual([expect.objectContaining({ id: 'r_mine0000' })]);
    expect(recapOf(world, 's1', 'c1')).toMatchObject({ coveredTurns: 4, items: [mine, expect.objectContaining({ statusSource: 'auto' })] });
  });
});

describe('events', () => {
  it('tells clients when a conversation is queued, runs and is caught up', async () => {
    const scheduler = await makeScheduler();
    addConversation(world, conversation('s1', 'c1', turns(2)));
    await scheduler.scan();
    world.now = new Date(T0 + RECAP_IDLE_MS);
    await scheduler.tick();
    expect(world.events.map((event) => event.state)).toEqual(['waiting', 'queued', 'running', 'up_to_date']);
    expect(world.events.at(-1)).toEqual({
      type: 'recap', sessionId: 's1', conversationId: 'c1', state: 'up_to_date', coveredTurns: 2, totalTurns: 2, updatedAt: at(T0 + RECAP_IDLE_MS),
    });
  });

  it('says nothing for conversations at rest when first seen', async () => {
    const scheduler = await makeScheduler({ ...ON, enabledAt: at(T0 + 60 * MIN) });
    addConversation(world, conversation('s1', 'old', turns(2)));
    addConversation(world, conversation('s2', 'none', [], { provider: null }));
    await scheduler.scan();
    expect(world.events).toEqual([]);
  });
});

describe('settings', () => {
  it('starts off', async () => {
    const scheduler = await makeScheduler(emptyRecapSettings());
    expect(await scheduler.getSettings()).toEqual({
      enabled: false, profileId: null, model: null, effort: null, backfillOld: false, enabledAt: null, pause: null,
      queue: { running: null, waiting: 0 },
    });
  });

  it.each([
    ['on without an account or model', { enabled: true }, 400, 'invalid_request'],
    ['an account recaps can\'t use', { profileId: 'native:agy', model: 'x' }, 400, 'launch_profile_unavailable'],
    ['a model the account doesn\'t have', { profileId: 'native:codex', model: 'gpt-nope' }, 400, 'model_unknown'],
    ['an effort the model doesn\'t have', { profileId: 'native:codex', model: 'gpt-6-luna', effort: 'ultra' }, 400, 'invalid_request'],
    ['an effort for a model without efforts', { profileId: 'janus:claude:personal', model: 'haiku', effort: 'low' }, 400, 'invalid_request'],
    ['a model without an account', { model: 'haiku' }, 400, 'invalid_request'],
  ])('refuses %s', async (_name, patch, status, code) => {
    const scheduler = await makeScheduler(emptyRecapSettings());
    expect(await scheduler.updateSettings(patch)).toMatchObject({ ok: false, status, code });
    expect((await scheduler.getSettings()).enabled).toBe(false);
  });

  it('a model list that can\'t be read is model_list_failed', async () => {
    world.models.delete('native:codex');
    const scheduler = await makeScheduler(emptyRecapSettings());
    expect(await scheduler.updateSettings({ enabled: true, profileId: 'native:codex', model: 'gpt-6-luna' }))
      .toMatchObject({ ok: false, status: 502, code: 'model_list_failed', params: { cli: 'Codex (原生)' } });
  });

  it('turns on with an account and model, stamping enabledAt', async () => {
    const scheduler = await makeScheduler(emptyRecapSettings());
    const result = await scheduler.updateSettings({ enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low' });
    expect(result).toMatchObject({ ok: true, value: { enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabledAt: at(T0) } });
  });

  it('turning off needs no look at the account', async () => {
    const scheduler = await makeScheduler();
    world.models.clear();
    expect(await scheduler.updateSettings({ enabled: false })).toMatchObject({ ok: true, value: { enabled: false } });
  });
});

describe('item statuses', () => {
  it('the user\'s status is kept, also with recaps off', async () => {
    const owner = addConversation(world, conversation('s1', 'c1', turns(2)));
    const item = {
      id: 'r_a0000000', title: 'a', status: 'uncertain' as const, statusSource: 'auto' as const, turns: { from: 0, to: 1 },
      createdAt: at(T0), updatedAt: at(T0), statusChangedAt: null,
    };
    setRecap(world, owner, { items: [item], coveredTurns: 2, lastCovered: { index: 1, userAt: at(T0 + 1000), userTextHash: userTextHash('第 1 輪的要求') } });
    const scheduler = await makeScheduler(emptyRecapSettings());
    const result = await scheduler.setItemStatus('s1', 'c1', 'r_a0000000', 'accepted');
    expect(result).toMatchObject({ ok: true, value: { state: 'disabled', items: [{ status: 'accepted', statusSource: 'user', statusChangedAt: at(T0) }] } });
    expect(await scheduler.setItemStatus('s1', 'c1', 'r_nope', 'accepted')).toMatchObject({ ok: false, status: 404, code: 'recap_item_not_found' });
    expect(await scheduler.setItemStatus('s1', 'nope', 'r_a0000000', 'accepted')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
  });

  it('a conversation without a provider has no recap', async () => {
    addConversation(world, conversation('s1', 'c1', turns(2), { provider: null }));
    const scheduler = await makeScheduler();
    expect(await scheduler.setItemStatus('s1', 'c1', 'r_a', 'accepted')).toMatchObject({ ok: false, status: 409, code: 'recap_unavailable' });
    expect(await scheduler.refresh('s1', 'c1')).toMatchObject({ ok: false, status: 409, code: 'recap_unavailable' });
    expect((await scheduler.sessionRecaps('s1'))!.conversations[0]).toMatchObject({ available: false, state: 'unavailable', items: [] });
  });
});

describe('a session\'s recaps', () => {
  it('lists its conversations newest first', async () => {
    addConversation(world, conversation('s1', 'first', turns(1), { sequence: 1 }));
    addConversation(world, conversation('s1', 'third', turns(1), { sequence: 3 }));
    addConversation(world, conversation('s1', 'second', [], { sequence: 2 }));
    const scheduler = await makeScheduler();
    const recaps = await scheduler.sessionRecaps('s1');
    expect(recaps!.enabled).toBe(true);
    expect(recaps!.conversations.map((view) => [view.conversationId, view.state])).toEqual([['third', 'waiting'], ['second', 'empty'], ['first', 'waiting']]);
    expect(await scheduler.sessionRecaps('nope')).toBeNull();
  });
});
