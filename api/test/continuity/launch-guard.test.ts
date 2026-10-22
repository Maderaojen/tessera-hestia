import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { createContinuity, decodeContinuityState, emptyContinuityState, type Continuity } from '../../src/continuity/engine.js';
import { HANDOFF_PROMPTS } from '../../src/continuity/policy.js';
import { cliQuit, fakePorts, hit, landSwitch, newWorld, sessionView, type World } from './fake-ports.js';
import type { ScreenReading } from '../../src/launch-guard/decide.js';

// A handoff's CLI taking over, from the moment it is launched until it has
// taken over, replaying the
// 2026-10-16 cube incident: Codex showed its update menu, the brief's line
// and Enter picked "Update now", Codex updated itself and quit — and the
// handoff was recorded as done.

let dir: string;
let world: World;
let engine: Continuity;
const CHAIN = ['janus:claude:work', 'janus:claude:personal', 'native:codex'];

const UPDATE_MENU: ScreenReading = {
  screen: { kind: 'update_prompt', selected: 'update', options: ['update', 'skip', 'skip_version'] },
  tail: '  Update available · 0.162.1 → 0.163.0\n› 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n  enter continue · esc skip',
};
const UPDATED: ScreenReading = {
  screen: { kind: 'cli_updated' },
  tail: 'Updating Codex via `npm install -g @openai/codex`...\nchanged 2 packages in 4s\n🎉 Update ran successfully! Please restart Codex.\ndev@host:/srv/dev/projects/game/cube$',
};
const READY: ScreenReading = { screen: { kind: 'input_ready' }, tail: '› Ask Codex to do anything' };

function makeEngine(): Continuity {
  return createContinuity(fakePorts(world), jsonFileStore({ path: path.join(dir, 'c.json'), empty: emptyContinuityState, decode: decodeContinuityState }));
}
const later = (seconds: number) => { world.now = new Date(world.now.getTime() + seconds * 1000); };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const view = () => engine.getSession('s1');
const briefs = () => world.sent.filter((sent) => sent.text.startsWith('你要接手'));

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'launch-guard-'));
  world = newWorld();
  world.hits.set('s1', null);
  world.sessions.set('s1', sessionView({ lastTurnAt: '2026-10-03T13:39:00.000Z' }));
  engine = makeEngine();
  // As cube had it: hand off at the limit, carry on without asking.
  await engine.setDefaults({ mode: 'handoff', chain: CHAIN, handoffConfirm: 'auto' });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A limit hit hands off to the next profile (personal); the switch lands.
async function landed(profileId = 'janus:claude:personal', conversationId = 'c2'): Promise<void> {
  world.hits.set('s1', { conversationId: 'c1', hit });
  await engine.scan();
  expect((await view()).handoff).toMatchObject({ trigger: 'limit_hit', stage: 'switching', toProfileId: profileId });
  await engine.advanceHandoffs(); // switch
  landSwitch(world, 's1', profileId, conversationId);
  await engine.advanceHandoffs(); // arrived
  expect((await view()).handoff?.stage).toBe('briefing');
}

describe('before the brief: only into the input box', () => {
  it('the incident\'s update menu is never typed into; Skip is chosen, then the brief goes in', async () => {
    await landed();
    world.screen = UPDATE_MENU;
    await engine.advanceHandoffs();
    expect(world.skips).toBe(1);
    expect(briefs()).toEqual([]);
    await engine.advanceHandoffs();
    expect(briefs().map((sent) => sent.text)).toEqual([HANDOFF_PROMPTS.briefAuto((await view()).handoff!.briefPath)]);
  });

  it('an update menu Skip can\'t be confirmed on is left to the user, told once with the screen', async () => {
    await landed();
    world.screen = UPDATE_MENU;
    world.skipAnswer = 'unsure';
    await engine.advanceHandoffs();
    await engine.advanceHandoffs();
    await flush();
    expect(briefs()).toEqual([]);
    const waiting = (await view()).history.filter((event) => event.kind === 'handoff_waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.detail).toMatch(/^CLI 在問要不要更新/);
    expect(world.notices.at(-1)?.body).toContain('Skip until next version');
  });

  it('waits on a screen it doesn\'t know, tells once after a minute, and gives up after ten with the screen\'s last lines', async () => {
    await landed();
    world.screen = { screen: { kind: 'unknown' }, tail: '> 1. Sign in with ChatGPT\n  Press enter to continue' };
    await engine.advanceHandoffs();
    later(61);
    await engine.advanceHandoffs();
    later(5);
    await engine.advanceHandoffs();
    await flush();
    expect(briefs()).toEqual([]);
    expect((await view()).history.filter((event) => event.kind === 'handoff_waiting')).toHaveLength(1);
    expect(world.notices.at(-1)?.body).toBe('Claude · personal 停在 App 不認得的畫面，還沒送出交接：\n> 1. Sign in with ChatGPT\n  Press enter to continue');
    later(10 * 60);
    await engine.advanceHandoffs();
    const after = await view();
    expect(after.handoff).toBeNull();
    expect(after.history.at(-1)).toMatchObject({ kind: 'handoff_failed', detail: expect.stringContaining('新的 CLI 沒有準備好接收交接') });
    expect(after.failedHandoff).toMatchObject({ tail: '> 1. Sign in with ChatGPT\n  Press enter to continue' });
  });
});

describe('after the brief: delivered only when the transcript shows it', () => {
  it('no conversation bound yet (\'unknown\') is not done: sent once more, then failed', async () => {
    await landed();
    world.delivery = 'unknown';
    await engine.advanceHandoffs(); // brief
    later(5);
    await engine.advanceHandoffs();
    expect((await view()).handoff?.stage).toBe('briefing');
    expect((await view()).history.map((event) => event.kind)).not.toContain('handoff_done');
    later(60);
    await engine.advanceHandoffs();
    expect((await view()).handoff).toMatchObject({ sentAt: null, resent: 1 });
    world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'idle' });
    await engine.advanceHandoffs();
    expect(briefs()).toHaveLength(2);
    later(65);
    await engine.advanceHandoffs();
    const after = await view();
    expect(after.handoff).toBeNull();
    expect(after.history.at(-1)).toMatchObject({ kind: 'handoff_failed' });
    expect(after.history.map((event) => event.kind)).not.toContain('handoff_done');
  });

  it('auto: done only once the CLI got through its first turn', async () => {
    await landed();
    await engine.advanceHandoffs(); // brief
    later(5);
    await engine.advanceHandoffs(); // in
    expect((await view()).handoff).toMatchObject({ stage: 'briefing', deliveredAt: world.now.toISOString() });
    world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'idle' });
    later(5);
    await engine.advanceHandoffs();
    const after = await view();
    expect(after.handoff).toBeNull();
    expect(after.history.at(-1)?.kind).toBe('handoff_done');
  });
});

describe('a CLI that quits before it took over', () => {
  it('the incident: quit to finish updating itself → started again once, same profile, same tmux; the brief sent again', async () => {
    await landed('janus:claude:personal', 'c2');
    world.delivery = 'unknown';
    await engine.advanceHandoffs(); // brief typed (into what turned out to be a menu)
    later(2);
    cliQuit(world, 's1');
    world.screen = UPDATED;
    await engine.advanceHandoffs();
    let current = await view();
    expect(current.handoff).toMatchObject({ stage: 'switching', relaunch: true, toProfileId: 'janus:claude:personal', toConversationId: null, guard: { relaunches: 1 } });
    expect(current.history.at(-1)).toMatchObject({ kind: 'handoff_relaunched' });
    expect(current.history.map((event) => event.kind)).not.toContain('handoff_done');
    // Across a restart of the API.
    engine = makeEngine();
    await engine.advanceHandoffs();
    expect(world.launched).toEqual([{ sessionId: 's1', profileId: 'janus:claude:personal' }]);
    world.screen = READY;
    world.delivery = 'exact';
    landSwitch(world, 's1', 'janus:claude:personal', 'c3');
    await engine.advanceHandoffs(); // arrived
    await engine.advanceHandoffs(); // brief again
    expect(briefs()).toHaveLength(2);
    later(5);
    await engine.advanceHandoffs();
    world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'idle' });
    later(5);
    await engine.advanceHandoffs();
    current = await view();
    expect(current.handoff).toBeNull();
    expect(current.history.at(-1)?.kind).toBe('handoff_done');
    // The conversation that took over is the one marked with the handoff.
    expect(world.segments.get('s1:c3')).toMatchObject({ fromConversationId: 'c1' });
  });

  it('quitting during its first turn is a failure, not done; the chain\'s next profile is tried in the tmux', async () => {
    await landed('janus:claude:personal', 'c2');
    await engine.advanceHandoffs(); // brief
    later(5);
    await engine.advanceHandoffs(); // in, watched
    cliQuit(world, 's1');
    world.screen = { screen: { kind: 'unknown' }, tail: 'Segmentation fault\ndev@host:~/cube$' };
    await engine.advanceHandoffs();
    await flush();
    const current = await view();
    expect(current.history.map((event) => event.kind)).not.toContain('handoff_done');
    expect(current.history.slice(-2)).toMatchObject([
      { kind: 'handoff_failed', detail: '接手的 CLI 在第一輪結束前就結束了' },
      { kind: 'handoff_relaunched', detail: '→ Codex (原生)' },
    ]);
    expect(current.handoff).toMatchObject({ stage: 'switching', relaunch: true, toProfileId: 'native:codex', tried: ['janus:claude:personal'] });
    expect(world.notices.at(-1)?.body).toContain('改交接給 Codex (原生)');
    await engine.advanceHandoffs();
    expect(world.launched.at(-1)).toMatchObject({ profileId: 'native:codex' });
  });

  it('with nobody left to try: stopped, the user told with the screen\'s last lines, and a retry offered', async () => {
    await engine.setDefaults({ chain: ['janus:claude:work', 'janus:claude:personal'] });
    await landed('janus:claude:personal', 'c2');
    cliQuit(world, 's1');
    world.screen = { screen: { kind: 'unknown' }, tail: 'panic: oops\ndev@host:~/cube$' };
    await engine.advanceHandoffs();
    await flush();
    const current = await view();
    expect(current.handoff).toBeNull();
    expect(current.history.at(-1)).toMatchObject({ kind: 'handoff_failed', detail: '接手的 CLI 在接手前就結束了' });
    expect(current.failedHandoff).toMatchObject({
      toProfileId: 'janus:claude:personal', reason: '接手的 CLI 在接手前就結束了', tail: 'panic: oops\ndev@host:~/cube$', fromConversationId: 'c1',
    });
    expect(world.notices.at(-1)?.body).toBe('交接給 Claude · personal 沒有完成：接手的 CLI 在接手前就結束了\npanic: oops\ndev@host:~/cube$');
  });

  it('a second quit to update is not relaunched again', async () => {
    await engine.setDefaults({ chain: ['janus:claude:work', 'janus:claude:personal'] });
    await landed('janus:claude:personal', 'c2');
    cliQuit(world, 's1');
    world.screen = UPDATED;
    await engine.advanceHandoffs();
    await engine.advanceHandoffs();
    landSwitch(world, 's1', 'janus:claude:personal', 'c3');
    await engine.advanceHandoffs();
    cliQuit(world, 's1');
    await engine.advanceHandoffs();
    expect(world.launched).toHaveLength(1);
    expect((await view()).handoff).toBeNull();
    expect((await view()).failedHandoff?.reason).toBe('接手的 CLI 在接手前就結束了');
  });
});

describe('relaunch and hand off (POST …/continuity/handoff/relaunch)', () => {
  async function failed(): Promise<string> {
    await engine.setDefaults({ chain: ['janus:claude:work', 'janus:claude:personal'] });
    await landed('janus:claude:personal', 'c2');
    cliQuit(world, 's1');
    world.screen = { screen: { kind: 'unknown' }, tail: '$' };
    await engine.advanceHandoffs();
    return (await view()).failedHandoff!.briefFile;
  }

  it('starts the profile again in the tmux with the same brief, and goes on as a handoff', async () => {
    const briefFile = await failed();
    world.screen = READY;
    const result = await engine.relaunchHandoff('s1', { briefFile });
    expect(result.ok && result.view.handoff).toMatchObject({ stage: 'switching', relaunch: true, toProfileId: 'janus:claude:personal', briefFile });
    expect(result.ok && result.view.failedHandoff).toBeNull();
    await engine.advanceHandoffs();
    expect(world.launched).toEqual([{ sessionId: 's1', profileId: 'janus:claude:personal' }]);
    landSwitch(world, 's1', 'janus:claude:personal', 'c3');
    await engine.advanceHandoffs();
    await engine.advanceHandoffs();
    expect(briefs().map((sent) => sent.text)).toEqual([HANDOFF_PROMPTS.briefAuto(result.ok ? result.view.handoff!.briefPath : '')]);
  });

  it('a CLI that got stuck and still runs is ended by the switch, as any handoff\'s', async () => {
    await landed();
    world.screen = { screen: { kind: 'unknown' }, tail: '> 1. Sign in with ChatGPT' };
    await engine.advanceHandoffs();
    later(61);
    await engine.advanceHandoffs(); // told
    later(10 * 60);
    await engine.advanceHandoffs(); // given up
    const { failedHandoff } = await view();
    expect(failedHandoff).toBeTruthy();
    const result = await engine.relaunchHandoff('s1', { briefFile: failedHandoff!.briefPath });
    expect(result.ok && result.view.handoff).toMatchObject({ relaunch: false, fromConversationId: 'c2', stage: 'switching' });
    await engine.advanceHandoffs();
    expect(world.switched.at(-1)).toMatchObject({ sessionId: 's1', profileId: 'janus:claude:personal' });
    expect(world.launched).toEqual([]);
  });

  it('to another profile, if asked', async () => {
    const briefFile = await failed();
    const result = await engine.relaunchHandoff('s1', { briefFile, toProfileId: 'native:codex' });
    expect(result.ok && result.view.handoff).toMatchObject({ toProfileId: 'native:codex', toLabel: 'Codex (原生)' });
  });

  it('refuses without a failed handoff, for another brief, or while a handoff runs', async () => {
    expect(await engine.relaunchHandoff('s1', { briefFile: '.hestia/handoffs/x.md' })).toMatchObject({ ok: false, code: 'handoff_not_retryable' });
    const briefFile = await failed();
    expect(await engine.relaunchHandoff('s1', { briefFile: '.hestia/handoffs/other.md' })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await engine.relaunchHandoff('s1', { briefFile, toProfileId: 'nope' })).toMatchObject({ ok: false, code: 'launch_profile_unavailable' });
    world.briefs.delete(briefFile);
    expect(await engine.relaunchHandoff('s1', { briefFile })).toMatchObject({ ok: false, code: 'handoff_brief_missing' });
  });

  it('the failure can be dismissed', async () => {
    await failed();
    expect((await engine.dismissFailedHandoff('s1')).failedHandoff).toBeNull();
  });
});
