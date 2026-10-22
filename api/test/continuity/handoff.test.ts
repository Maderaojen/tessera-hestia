import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContinuity, decodeContinuityState, emptyContinuityState, type Continuity } from '../../src/continuity/engine.js';
import { HANDOFF_PROMPTS } from '../../src/continuity/policy.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { fakePorts, hit, landSwitch, newWorld, sessionView, type World } from './fake-ports.js';

let dir: string;
let world: World;
let engine: Continuity;
const CHAIN = ['janus:claude:work', 'janus:claude:personal', 'native:codex'];

function makeEngine(ports = fakePorts(world)): Continuity {
  return createContinuity(ports, jsonFileStore({ path: path.join(dir, 'c.json'), empty: emptyContinuityState, decode: decodeContinuityState }));
}

const at = (iso: string) => { world.now = new Date(iso); };
const later = (seconds: number) => { world.now = new Date(world.now.getTime() + seconds * 1000); };
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  world = newWorld();
  // At work, nothing hit yet.
  world.hits.set('s1', null);
  world.sessions.set('s1', sessionView({ lastTurnAt: '2026-10-03T13:39:00.000Z' }));
  engine = makeEngine();
  await engine.setDefaults({ mode: 'handoff', chain: CHAIN });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function stage(): Promise<string | null> {
  return (await engine.getSession('s1')).handoff?.stage ?? null;
}

describe('quota monitor', () => {
  it('does nothing while the account has plenty left', async () => {
    await engine.scan();
    expect(await stage()).toBeNull();
  });

  it('asks for fresher numbers when getting close', async () => {
    world.quota.set('janus:claude:work', 22);
    await engine.scan();
    expect(world.refreshes).toBe(1);
    expect(await stage()).toBeNull();
  });

  it('a soft threshold after a turn starts a handoff to the next account in the chain', async () => {
    world.quota.set('janus:claude:work', 12);
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.handoff).toMatchObject({ trigger: 'soft', stage: 'writing_brief', toProfileId: 'janus:claude:personal', toLabel: 'Claude · personal', sentAt: null });
    await flush();
    expect(world.notices.at(-1)?.body).toBe('額度剩 12%，開始交接給 Claude · personal');
  });

  it('not for a session left idle a long while', async () => {
    world.quota.set('janus:claude:work', 12);
    world.sessions.set('s1', sessionView({ lastTurnAt: '2026-10-03T12:00:00.000Z' }));
    await engine.scan();
    expect(await stage()).toBeNull();
  });

  it('a hard threshold interrupts the reply in progress', async () => {
    world.quota.set('janus:claude:work', 3);
    world.sessions.set('s1', sessionView({ phase: 'replying' }));
    await engine.scan();
    expect((await engine.getSession('s1')).handoff).toMatchObject({ trigger: 'hard', interrupt: true });
    await engine.advanceHandoffs();
    expect(world.interrupted).toEqual(['s1']);
  });

  it('skips accounts that are low or over their limit, and the same account', async () => {
    world.quota.set('janus:claude:work', 12);
    world.quota.set('janus:claude:personal', 10);
    await engine.scan();
    expect((await engine.getSession('s1')).handoff?.toProfileId).toBe('native:codex');
  });

  it('with nobody to hand to, says so once and keeps going', async () => {
    world.quota.set('janus:claude:work', 12);
    await engine.setDefaults({ chain: ['janus:claude:work'] });
    await engine.scan();
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.handoff).toBeNull();
    expect(view.history.map((e) => e.kind)).toEqual(['no_target']);
  });

  it('only in handoff mode', async () => {
    world.quota.set('janus:claude:work', 3);
    await engine.setDefaults({ mode: 'wait_resume' });
    await engine.scan();
    expect(await stage()).toBeNull();
  });
});

describe('a handoff, step by step', () => {
  beforeEach(async () => {
    world.quota.set('janus:claude:work', 12);
    await engine.scan();
  });

  const idle = () => world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'idle' });
  const handoff = async () => (await engine.getSession('s1')).handoff!;

  it('the CLI writes its brief; the app adds its own part; switch; brief; report; confirm', async () => {
    // 1. Ask the CLI being left to write the brief, by its absolute path.
    await engine.advanceHandoffs();
    const { briefFile, briefPath } = await handoff();
    expect(briefPath).toMatch(/^\/p\/\.hestia\/handoffs\//);
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.writeBrief(briefPath));
    // It writes it and finishes its turn.
    later(30);
    world.briefs.set(briefFile, '# 交接\n目標：做完 X');
    idle();
    await engine.advanceHandoffs();
    expect(world.briefs.get(briefFile)).toBe('# 交接\n目標：做完 X\n\n---\n\n# 交接（系統整理）\nsoft');
    expect(await handoff()).toMatchObject({ stage: 'switching', briefSource: 'self', briefNote: null });
    // 2. Switch, retaining the source through the transition claim.
    const ports = fakePorts(world);
    const switchProfile = vi.spyOn(ports, 'switchProfile');
    engine = makeEngine(ports);
    await engine.advanceHandoffs();
    expect(switchProfile).toHaveBeenCalledWith('s1', 'janus:claude:personal', { expectedConversationId: 'c1' });
    expect(world.switched).toEqual([{ sessionId: 's1', profileId: 'janus:claude:personal' }]);
    await engine.advanceHandoffs();
    expect(await stage()).toBe('switching');
    landSwitch(world, 's1', 'janus:claude:personal');
    await engine.advanceHandoffs();
    expect(await handoff()).toMatchObject({ stage: 'briefing', toConversationId: 'c2' });
    // 3. Brief the new CLI; once it arrived whole, it is reporting back.
    await engine.advanceHandoffs();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.briefAsk(briefPath));
    expect(await stage()).toBe('briefing');
    later(5);
    await engine.advanceHandoffs();
    expect(await stage()).toBe('reporting');
    // No go-ahead while it is still reading and reporting.
    expect(await engine.confirmHandoff('s1')).toMatchObject({ ok: false, code: 'handoff_not_awaiting' });
    await engine.advanceHandoffs();
    expect(await stage()).toBe('reporting');
    // 4. Its report is done: now the user is asked.
    idle();
    await engine.advanceHandoffs();
    expect(await stage()).toBe('awaiting_confirmation');
    const confirmed = await engine.confirmHandoff('s1');
    expect(confirmed.ok).toBe(true);
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.confirm);
    const view = await engine.getSession('s1');
    expect(view.handoff).toBeNull();
    expect(view.history.map((e) => e.kind)).toEqual(['handoff_started', 'handoff_brief', 'handoff_switched', 'handoff_done']);
  });

  it('ends the brief with what another feature adds for the session (a delegate\'s how-to-deliver)', async () => {
    world.addenda.set('s1', '## 這是一個指派');
    await engine.advanceHandoffs();
    const { briefFile } = await handoff();
    later(30);
    world.briefs.set(briefFile, '# 交接\n目標：做完 X');
    idle();
    await engine.advanceHandoffs();
    expect(world.briefs.get(briefFile)).toBe('# 交接\n目標：做完 X\n\n---\n\n# 交接（系統整理）\nsoft\n\n---\n\n## 這是一個指派');
  });

  it('a request that arrived cut short is not trusted: the app writes the brief', async () => {
    await engine.advanceHandoffs();
    world.delivery = 'partial';
    later(5);
    await engine.advanceHandoffs();
    const current = await handoff();
    expect(current).toMatchObject({ stage: 'switching', briefSource: 'mechanical', briefNote: '請求送到時被截斷了', briefNoteCode: 'cut_short' });
    expect(world.briefs.get(current.briefFile)).toBe('# 交接（系統整理）\nsoft 請求送到時被截斷了');
  });

  it('a brief written under the right name in the wrong place is used', async () => {
    await engine.advanceHandoffs();
    const { briefFile } = await handoff();
    world.strayBriefs.set(briefFile, '# 寫錯地方的交接');
    later(30);
    idle();
    await engine.advanceHandoffs();
    expect(await handoff()).toMatchObject({ stage: 'switching', briefSource: 'self' });
    expect(world.briefs.get(briefFile)).toMatch(/^# 寫錯地方的交接/);
  });

  it('falls back to the app\'s own brief when the CLI never writes one, saying why', async () => {
    await engine.advanceHandoffs();
    idle();
    later(60);
    await engine.advanceHandoffs();
    expect(await stage()).toBe('writing_brief');
    later(60);
    await engine.advanceHandoffs();
    expect(await handoff()).toMatchObject({ stage: 'switching', briefSource: 'mechanical', briefNote: '回覆結束了，但沒有寫出交接檔', briefNoteCode: 'no_brief_written' });
  });

  it('falls back when it hits the limit while writing', async () => {
    await engine.advanceHandoffs();
    later(10);
    world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, at: world.now.toISOString() } });
    await engine.advanceHandoffs();
    expect(await handoff()).toMatchObject({ briefSource: 'mechanical', briefNote: '寫交接時已達額度上限' });
  });

  it('auto confirm: the new CLI just carries on', async () => {
    await engine.setDefaults({ handoffConfirm: 'auto', handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    await engine.advanceHandoffs(); // switch
    landSwitch(world, 's1', 'janus:claude:personal', 'c4');
    await engine.advanceHandoffs(); // arrived
    await engine.advanceHandoffs(); // brief
    expect(world.sent.at(-1)?.text).toMatch(/接著把工作做下去/);
    later(5);
    await engine.advanceHandoffs(); // arrived whole
    // Over once it got through its first turn (ADR 0030).
    expect((await engine.getSession('s1')).handoff?.deliveredAt).toBeTruthy();
    idle();
    later(5);
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).handoff).toBeNull();
  });

  it('a briefing that arrived cut short is sent again once, then given up', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    await engine.advanceHandoffs();
    landSwitch(world, 's1', 'janus:claude:personal', 'c4');
    await engine.advanceHandoffs();
    await engine.advanceHandoffs();
    world.delivery = 'partial';
    later(5);
    await engine.advanceHandoffs();
    expect(await handoff()).toMatchObject({ stage: 'briefing', sentAt: null, resent: 1 });
    idle();
    await engine.advanceHandoffs();
    expect(world.sent.filter((s) => s.text.startsWith('你要接手'))).toHaveLength(2);
    later(5);
    await engine.advanceHandoffs();
    const view = await engine.getSession('s1');
    expect(view.handoff).toBeNull();
    expect(view.history.at(-1)?.kind).toBe('handoff_failed');
  });

  it('a failed switch is reported', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    world.switchOutcome = { ok: false, reason: 'another launch is pending' };
    await engine.advanceHandoffs();
    const view = await engine.getSession('s1');
    expect(view.handoff).toBeNull();
    expect(view.history.at(-1)).toMatchObject({ kind: 'handoff_failed', detail: 'another launch is pending' });
  });

  it('says at once why the switch waits for the turn, once, and why it gave up', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'replying' });
    world.switchOutcome = { ok: false, reason: '回覆仍在進行，而此 CLI 的中斷方式尚未驗證' };
    const notices = world.notices.length;
    await engine.advanceHandoffs();
    let view = await engine.getSession('s1');
    expect(view.handoff).toMatchObject({ stage: 'switching', switchBlocked: { reason: '回覆仍在進行，而此 CLI 的中斷方式尚未驗證' } });
    expect(view.history.at(-1)).toMatchObject({ kind: 'handoff_waiting', detail: '回覆仍在進行，而此 CLI 的中斷方式尚未驗證' });
    expect(world.notices.slice(notices).map((notice) => notice.body)).toEqual([expect.stringContaining('要等目前這一輪結束')]);
    // Still refused for the same reason: nothing more is said.
    later(30);
    await engine.advanceHandoffs();
    expect(world.notices.length).toBe(notices + 1);
    expect((await engine.getSession('s1')).history.filter((event) => event.kind === 'handoff_waiting')).toHaveLength(1);
    // Never ended: given up, saying the turn never ended.
    later(11 * 60);
    await engine.advanceHandoffs();
    view = await engine.getSession('s1');
    expect(view.handoff).toBeNull();
    expect(view.history.at(-1)).toMatchObject({ kind: 'handoff_failed', detail: expect.stringContaining('目前這一輪一直沒有結束') });
  });

  it('the user can skip the wait: the CLI being left is ended and the switch goes on', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    // Nothing to force before the switch is held up.
    expect(await engine.forceHandoffSwitch('s1')).toMatchObject({ ok: false, code: 'handoff_not_awaiting' });
    world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'replying' });
    world.switchOutcome = { ok: false, reason: '回覆仍在進行，而此 CLI 的中斷方式尚未驗證' };
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).handoff?.switchBlocked).toBeTruthy();

    const ports = fakePorts(world);
    const switchProfile = vi.spyOn(ports, 'switchProfile');
    engine = makeEngine(ports);
    expect(await engine.forceHandoffSwitch('s1')).toMatchObject({ ok: true });
    expect(switchProfile).toHaveBeenCalledWith('s1', expect.any(String), { force: true, expectedConversationId: 'c3' });
    expect(world.switched.at(-1)).toMatchObject({ sessionId: 's1', force: true });
    let view = await engine.getSession('s1');
    expect(view.handoff).toMatchObject({ stage: 'switching', switchBlocked: null });
    expect(view.handoff?.sentAt).toBeTruthy();
    expect(view.history.at(-1)?.kind).toBe('handoff_forced');
    // Then on as usual once the new CLI is there.
    landSwitch(world, 's1', world.switched.at(-1)!.profileId, 'c4');
    await engine.advanceHandoffs();
    view = await engine.getSession('s1');
    expect(view.handoff?.stage).toBe('briefing');
  });

  it.each(['replaced', 'ended', 'switching', 'missing'] as const)('refuses a stale force switch when its source is %s', async (change) => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'replying' });
    world.switchOutcome = { ok: false, reason: 'interrupt unverified' };
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).handoff?.switchBlocked).toBeTruthy();
    if (change === 'missing') world.sessions.delete('s1');
    else world.sessions.set('s1', {
      ...world.sessions.get('s1')!,
      ...(change === 'replaced' ? { conversationId: 'another-conversation' } : {}),
      ...(change === 'ended' ? { running: false } : {}),
      ...(change === 'switching' ? { switching: true } : {}),
    });
    const before = world.sessions.get('s1');

    expect(await engine.forceHandoffSwitch('s1')).toMatchObject({ ok: false, code: 'handoff_force_failed' });
    expect(world.switched).toEqual([]);
    expect(world.sessions.get('s1')).toEqual(before);
    expect((await engine.getSession('s1')).handoff?.sentAt).toBeNull();
  });

  it('waits out a trust prompt on the new CLI', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    await engine.advanceHandoffs();
    landSwitch(world, 's1', 'native:codex', 'c4');
    await engine.advanceHandoffs();
    world.sendOutcome = { status: 'blocked', reason: 'startup_prompt_pending' };
    await engine.advanceHandoffs();
    expect(await stage()).toBe('briefing');
    world.sendOutcome = { status: 'sent' };
    await engine.advanceHandoffs();
    later(5);
    await engine.advanceHandoffs();
    expect(await stage()).toBe('reporting');
  });

  it('the user answering in the chat ends the wait', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.cancelHandoff('s1');
    world.sessions.set('s1', sessionView({ conversationId: 'c3', lastTurnAt: world.now.toISOString() }));
    await engine.scan();
    await engine.advanceHandoffs();
    landSwitch(world, 's1', 'janus:claude:personal', 'c4');
    await engine.advanceHandoffs();
    await engine.advanceHandoffs();
    later(5);
    await engine.advanceHandoffs();
    idle();
    later(5);
    await engine.advanceHandoffs();
    expect(await stage()).toBe('awaiting_confirmation');
    later(60);
    world.sessions.set('s1', { ...world.sessions.get('s1')!, lastSentAt: world.now.toISOString() });
    await engine.advanceHandoffs();
    expect(await stage()).toBeNull();
  });
});

describe('a CLI past its limit, or one that never takes the request', () => {
  it('a manual handoff from a conversation that ends on a limit hit is a limit hit\'s: no request, the app writes the brief', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, resetsAt: '2026-10-03T15:30:00.000Z' } });
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    expect(result.ok && result.view.handoff).toMatchObject({ trigger: 'limit_hit', stage: 'switching', briefSource: 'mechanical' });
    expect(world.sent).toEqual([]);
    await flush();
    expect(world.notices.at(-1)?.body).toBe('額度已用完，開始交接給 Codex (原生)');
  });

  it('one whose limit has reset since is asked as usual', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, resetsAt: '2026-10-03T13:00:00.000Z' } });
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    expect(result.ok && result.view.handoff).toMatchObject({ trigger: 'manual', stage: 'writing_brief' });
    await flush();
    expect(world.notices.at(-1)?.body).toBe('開始交接給 Codex (原生)');
  });

  it('a request that never shows up is given up on after 30 seconds', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    await engine.advanceHandoffs();
    world.delivery = 'missing';
    later(10);
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).handoff?.stage).toBe('writing_brief');
    later(25);
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).handoff).toMatchObject({ stage: 'switching', briefNote: '請求一直沒有送進 CLI' });
  });

  it('"let the app write it" while the CLI writes, or is waited on', async () => {
    world.sessions.set('s1', sessionView({ phase: 'replying' }));
    await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    await engine.advanceHandoffs();
    const result = await engine.skipHandoffBrief('s1');
    expect(result.ok && result.view.handoff?.skipBrief).toBe(true);
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).handoff).toMatchObject({ stage: 'switching', briefNote: '使用者選擇改由系統整理', briefNoteCode: 'user_skipped' });
    expect(await engine.skipHandoffBrief('s1')).toMatchObject({ ok: false, code: 'handoff_not_awaiting' });
  });
});

describe('waiting for the turn to end', () => {
  beforeEach(async () => {
    world.sessions.set('s1', sessionView({ phase: 'replying' }));
  });

  it('waits by default, then interrupts after ten minutes rather than giving up', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    await engine.advanceHandoffs();
    expect(world.interrupted).toEqual([]);
    later(11 * 60);
    await engine.advanceHandoffs();
    expect(world.interrupted).toEqual(['s1']);
    // Settles a moment before typing.
    await engine.advanceHandoffs();
    expect(world.sent).toEqual([]);
    later(5);
    await engine.advanceHandoffs();
    expect(world.sent.at(-1)?.text).toMatch(/^接下來這項工作會交給另一個 LLM 接手/);
  });

  it('interrupts right away when asked to', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', interrupt: true });
    await engine.advanceHandoffs();
    expect(world.interrupted).toEqual(['s1']);
  });

  it('"interrupt now" while it waits', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    await engine.advanceHandoffs();
    const result = await engine.interruptHandoff('s1');
    expect(result.ok && result.view.handoff?.interrupt).toBe(true);
    await engine.advanceHandoffs();
    expect(world.interrupted).toEqual(['s1']);
  });

  it('"interrupt now" only while the brief is being waited for', async () => {
    expect(await engine.interruptHandoff('s1')).toMatchObject({ ok: false, code: 'handoff_not_awaiting' });
  });
});

describe('limit hit in handoff mode', () => {
  it('hands off with the app\'s own brief (the CLI can\'t answer any more)', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit });
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.handoff).toMatchObject({ trigger: 'limit_hit', stage: 'switching', briefSource: 'mechanical' });
    expect(view.pending).toBeNull();
  });

  it('the app\'s own brief gets the addendum too', async () => {
    world.addenda.set('s1', '## 這是一個指派');
    world.hits.set('s1', { conversationId: 'c1', hit });
    await engine.scan();
    const { briefFile } = (await engine.getSession('s1')).handoff!;
    expect(world.briefs.get(briefFile)).toMatch(/^# 交接（系統整理）\nlimit_hit[^]*\n\n---\n\n## 這是一個指派$/);
  });

  it('marks the account limited, so it is skipped as a target', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit });
    await engine.scan();
    // Back on the work account in another tmux: personal is next, work is out.
    world.sessions.set('s2', sessionView({ conversationId: 'x1', profileId: 'native:codex', accountId: 'native:codex:default', lastTurnAt: world.now.toISOString() }));
    world.hits.set('s2', null);
    world.quota.set('native:codex:default', 10);
    world.quota.set('janus:claude:personal', 10);
    await engine.scan();
    expect((await engine.getSession('s2')).history.at(-1)?.kind).toBe('no_target');
  });

  it('with nobody to hand to, waits for the reset', async () => {
    await engine.setDefaults({ chain: [] });
    world.hits.set('s1', { conversationId: 'c1', hit });
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.handoff).toBeNull();
    expect(view.pending?.wakeAt).toBe('2026-10-03T15:32:00.000Z');
    expect(view.history.map((e) => e.kind)).toEqual(['no_target', 'scheduled']);
  });

  it('a failed handoff falls back to waiting for the reset', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit });
    world.switchOutcome = { ok: false, reason: 'nope' };
    await engine.scan();
    await engine.advanceHandoffs();
    await engine.scan();
    const view = await engine.getSession('s1');
    expect(view.pending?.wakeAt).toBe('2026-10-03T15:32:00.000Z');
  });
});

describe('manual handoff', () => {
  it('to a named profile', async () => {
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    expect(result.ok && result.view.handoff).toMatchObject({ trigger: 'manual', toProfileId: 'native:codex' });
  });

  it('picks from the chain without one', async () => {
    const result = await engine.startHandoff('s1', {});
    expect(result.ok && result.view.handoff?.toProfileId).toBe('janus:claude:personal');
  });

  it.each([
    ['an unknown profile', { toProfileId: 'nope' }, 'launch_profile_unavailable'],
    ['the running profile', { toProfileId: 'janus:claude:work' }, 'invalid_request'],
  ])('refuses %s', async (_name, request, code) => {
    const result = await engine.startHandoff('s1', request);
    expect(!result.ok && result.code).toBe(code);
  });

  it('refuses a second one, and a CLI that is not running', async () => {
    await engine.startHandoff('s1', {});
    expect(await engine.startHandoff('s1', {})).toMatchObject({ ok: false, code: 'handoff_in_progress' });
    world.sessions.set('s2', sessionView({ running: false, phase: null }));
    expect(await engine.startHandoff('s2', {})).toMatchObject({ ok: false, code: 'no_running_cli' });
  });

  it('confirm only while waiting for it; cancel any time', async () => {
    await engine.startHandoff('s1', {});
    expect(await engine.confirmHandoff('s1')).toMatchObject({ ok: false, code: 'handoff_not_awaiting' });
    const view = await engine.cancelHandoff('s1');
    expect(view.handoff).toBeNull();
    expect(view.history.at(-1)).toMatchObject({ kind: 'handoff_cancelled', detail: 'writing_brief' });
  });

  it('survives a restart mid-way', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.startHandoff('s1', {});
    engine = makeEngine();
    await engine.advanceHandoffs();
    expect(world.switched).toHaveLength(1);
  });
});

describe('time', () => {
  it('gives up a relaunch that never shows up', async () => {
    at('2026-10-03T13:40:00.000Z');
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.startHandoff('s1', {});
    await engine.advanceHandoffs();
    later(6 * 60);
    await engine.advanceHandoffs();
    expect((await engine.getSession('s1')).history.at(-1)).toMatchObject({ kind: 'handoff_failed', detail: '新的 CLI 一直沒有啟動完成' });
  });
});
