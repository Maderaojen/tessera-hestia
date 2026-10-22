import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffMessageKind } from '../../src/contract/continuity.js';
import { createContinuity, decodeContinuityState, emptyContinuityState, type Continuity } from '../../src/continuity/engine.js';
import { HANDOFF_PROMPTS } from '../../src/continuity/policy.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { fakePorts, hit, landSwitch, newWorld, sessionView, type World } from './fake-ports.js';

// A handoff's own choices (§4.7):
// who writes the brief (briefBy), what the CLI taking over does once it
// has read it (afterReport), the 'incoming' brief, dismiss and selfBrief.

let dir: string;
let world: World;
let engine: Continuity;
const CHAIN = ['janus:claude:work', 'janus:claude:personal', 'native:codex'];

function makeEngine(): Continuity {
  return createContinuity(fakePorts(world), jsonFileStore({ path: path.join(dir, 'c.json'), empty: emptyContinuityState, decode: decodeContinuityState }));
}

const later = (seconds: number) => { world.now = new Date(world.now.getTime() + seconds * 1000); };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const idle = () => world.sessions.set('s1', { ...world.sessions.get('s1')!, phase: 'idle' });
const current = async () => (await engine.getSession('s1')).handoff!;
const stage = async () => (await engine.getSession('s1')).handoff?.stage ?? null;
const pastLimit = () => world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, resetsAt: '2026-10-03T15:30:00.000Z' } });

// From the start to the new CLI having taken the briefing in whole.
async function throughBriefing(): Promise<void> {
  await engine.advanceHandoffs(); // switch
  landSwitch(world, 's1', 'native:codex');
  await engine.advanceHandoffs(); // arrived
  await engine.advanceHandoffs(); // briefing sent
  later(5);
  await engine.advanceHandoffs(); // arrived whole
}

// With carry on, the CLI taking over is watched through its first turn
// before the handoff is over (ADR 0030).
async function firstTurnOver(): Promise<void> {
  idle();
  later(5);
  await engine.advanceHandoffs();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-options-'));
  world = newWorld();
  world.hits.set('s1', null);
  world.sessions.set('s1', sessionView({ lastTurnAt: '2026-10-03T13:39:00.000Z' }));
  engine = makeEngine();
  await engine.setDefaults({ mode: 'handoff', chain: CHAIN });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('briefBy incoming', () => {
  it('asks nothing of the CLI being left: the app writes its part at once', async () => {
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    expect(result.ok && result.view.handoff).toMatchObject({ stage: 'switching', source: 'incoming', confirm: 'ask', briefSource: 'incoming', briefNote: null });
    expect(world.sent).toEqual([]);
    expect(world.briefs.get((await current()).briefFile)).toMatch(/^# 交接（系統整理）/);
    expect((await engine.getSession('s1')).history.map((e) => [e.kind, e.detail])).toContainEqual(['handoff_brief', 'incoming']);
  });

  it('asks the new CLI to add its notes, and tells whether it did once it has reported', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    const { briefFile, briefPath } = await current();
    await throughBriefing();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.briefIncomingAsk(briefPath));
    expect(await stage()).toBe('reporting');
    later(20);
    world.briefs.set(briefFile, `${world.briefs.get(briefFile)}\n\n## 接手者的整理\n目標：X`);
    world.briefTimes.set(briefFile, world.now.toISOString());
    idle();
    await engine.advanceHandoffs();
    expect(await current()).toMatchObject({ stage: 'awaiting_confirmation', briefAmended: true });
    await flush();
    expect(world.notices.at(-1)?.body).toBe('Codex (原生) 讀完交接檔並回報了');
  });

  it('does not take the heading merely quoted in the brief for the notes', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming' });
    const { briefFile } = await current();
    await throughBriefing();
    later(20);
    world.briefs.set(briefFile, `${world.briefs.get(briefFile)}\n\n> 使用者說：請在「## 接手者的整理」寫下你的理解`);
    world.briefTimes.set(briefFile, world.now.toISOString());
    idle();
    await engine.advanceHandoffs();
    expect(await current()).toMatchObject({ stage: 'awaiting_confirmation', briefAmended: false });
  });

  it('says so when the report came without the notes', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming' });
    await throughBriefing();
    later(20);
    idle();
    await engine.advanceHandoffs();
    expect(await current()).toMatchObject({ stage: 'awaiting_confirmation', briefAmended: false });
  });

  it('with carry on: told to carry on once its notes are in, and the handoff is over', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'continue' });
    const { briefPath } = await current();
    await throughBriefing();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.briefIncomingAuto(briefPath));
    expect((await engine.getSession('s1')).handoff?.deliveredAt).toBeTruthy();
    await firstTurnOver();
    expect((await engine.getSession('s1')).handoff).toBeNull();
  });

  it('works for a CLI past its limit too, with no fallback note', async () => {
    pastLimit();
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming' });
    expect(result.ok && result.view.handoff).toMatchObject({ trigger: 'limit_hit', briefSource: 'incoming', briefNote: null });
  });

  it('its briefing is told apart as a handoff message, also cut at the head', () => {
    const text = HANDOFF_PROMPTS.briefIncomingAsk('/p/.hestia/handoffs/x.md');
    expect(handoffMessageKind(text)).toBe('brief');
    expect(handoffMessageKind(HANDOFF_PROMPTS.briefIncomingAuto('/p/.hestia/handoffs/x.md'))).toBe('brief');
  });
});

describe('briefBy current and afterReport', () => {
  it('current for a CLI past its limit: the app writes it, saying why', async () => {
    pastLimit();
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'current' });
    expect(result.ok && result.view.handoff).toMatchObject({ source: 'self_then_mechanical', briefSource: 'mechanical', briefNote: '已達額度上限，原本的 LLM 已無法回應', briefNoteCode: 'limit_hit' });
  });

  it('current overrides a policy of the app only; continue overrides ask', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical', handoffConfirm: 'ask' });
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'current', afterReport: 'continue' });
    expect(result.ok && result.view.handoff).toMatchObject({ source: 'self_then_mechanical', confirm: 'auto', stage: 'writing_brief' });
    await engine.advanceHandoffs();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.writeBrief((await current()).briefPath));
  });

  it('keeps the choices: changing the settings mid-way doesn\'t change the handoff', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    const { briefPath } = await current();
    await engine.setDefaults({ handoffConfirm: 'auto', handoffSource: 'self_then_mechanical' });
    await throughBriefing();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.briefIncomingAsk(briefPath));
    expect(await stage()).toBe('reporting');
  });

  it('without choices takes the policy then', async () => {
    await engine.setDefaults({ handoffConfirm: 'auto' });
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    expect(result.ok && result.view.handoff).toMatchObject({ source: 'self_then_mechanical', confirm: 'auto' });
  });

  it('a handoff saved before it had choices follows the policy', async () => {
    await engine.setDefaults({ handoffSource: 'mechanical' });
    await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    const file = path.join(dir, 'c.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.sessions.s1.handoff.source;
    delete raw.sessions.s1.handoff.confirm;
    await writeFile(file, JSON.stringify(raw));
    engine = makeEngine();
    const { briefPath } = await current();
    await throughBriefing();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.briefAsk(briefPath));
  });
});

describe('dismiss', () => {
  it('only once it has reported; ends it without sending anything', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    expect(await engine.dismissHandoff('s1')).toMatchObject({ ok: false, code: 'handoff_not_awaiting' });
    await throughBriefing();
    later(20);
    idle();
    await engine.advanceHandoffs();
    const sent = world.sent.length;
    const result = await engine.dismissHandoff('s1');
    expect(result.ok && result.view.handoff).toBeNull();
    expect(result.ok && result.view.history.at(-1)).toMatchObject({ kind: 'handoff_done', detail: 'Codex (原生)' });
    expect(world.sent).toHaveLength(sent);
  });
});

describe('selfBrief', () => {
  it('available with a CLI running and no limit hit', async () => {
    expect((await engine.getSession('s1')).selfBrief).toEqual({ available: true, reason: null });
  });

  it('not when the conversation ends on a limit not yet reset', async () => {
    pastLimit();
    expect((await engine.getSession('s1')).selfBrief).toEqual({ available: false, reason: 'limit_hit' });
  });

  it('available again once that limit has reset', async () => {
    world.hits.set('s1', { conversationId: 'c1', hit: { ...hit, resetsAt: '2026-10-03T13:00:00.000Z' } });
    expect((await engine.getSession('s1')).selfBrief).toEqual({ available: true, reason: null });
  });

  it('not with no CLI running', async () => {
    world.sessions.set('s1', sessionView({ running: false, phase: null }));
    expect((await engine.getSession('s1')).selfBrief).toEqual({ available: false, reason: 'cli_not_running' });
  });

  it('is in what every action returns too', async () => {
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex' });
    expect(result.ok && result.view.selfBrief).toEqual({ available: true, reason: null });
  });
});

describe('the handoff written on the conversation it started (session-timeline §4.2)', () => {
  const segment = () => world.segments.get('s1:c2');

  it('once the new conversation is there, with who wrote the brief and its file', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    const { id, briefFile } = await current();
    await engine.advanceHandoffs(); // switch
    landSwitch(world, 's1', 'native:codex');
    await engine.advanceHandoffs(); // arrived
    expect(segment()).toEqual({
      handoffId: id, trigger: 'manual', fromConversationId: 'c1', briefSource: 'incoming', source: 'incoming', briefNote: null, briefNoteCode: null,
      confirm: 'ask', briefAmended: null, briefFile,
    });
    expect((await current()).segmentMarked).toBe(true);
  });

  it('with briefAmended once the incoming LLM has reported', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    const { briefFile } = await current();
    await throughBriefing();
    later(20);
    world.briefs.set(briefFile, `${world.briefs.get(briefFile)}\n\n## 接手者的整理\n目標：X`);
    world.briefTimes.set(briefFile, world.now.toISOString());
    idle();
    await engine.advanceHandoffs();
    expect(segment()?.briefAmended).toBe(true);
  });

  it('carry on: briefAmended is never judged, null', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'continue' });
    await throughBriefing();
    await firstTurnOver();
    expect((await engine.getSession('s1')).handoff).toBeNull();
    expect(segment()).toMatchObject({ confirm: 'auto', briefAmended: null });
  });

  it('a write that didn\'t work is tried again on the next step', async () => {
    world.markFails = true;
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'wait' });
    await engine.advanceHandoffs();
    landSwitch(world, 's1', 'native:codex');
    await engine.advanceHandoffs();
    expect(segment()).toBeUndefined();
    expect((await current()).segmentMarked).toBeFalsy();
    world.markFails = false;
    await engine.advanceHandoffs();
    expect(segment()).toBeDefined();
  });

  it('every event of the handoff carries its id', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'continue' });
    const { id } = await current();
    await throughBriefing();
    await firstTurnOver();
    const events = (await engine.getSession('s1')).history;
    expect(events.map((e) => [e.kind, e.handoffId])).toEqual([
      ['handoff_started', id], ['handoff_brief', id], ['handoff_switched', id], ['handoff_done', id],
    ]);
  });
});

describe('permissionMode (ADR 0027)', () => {
  it('is kept on the handoff and passed to the switch, which happens later', async () => {
    const result = await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', permissionMode: 'yolo' });
    expect(result.ok && result.view.handoff?.permissionMode).toBe('yolo');
    await engine.advanceHandoffs();
    expect(world.switched).toEqual([{ sessionId: 's1', profileId: 'native:codex', permissionMode: 'yolo' }]);
  });

  it('is left to the setting when not chosen: an automatic or later handoff never carries an earlier one-off yolo', async () => {
    await engine.startHandoff('s1', { toProfileId: 'native:codex', briefBy: 'incoming', permissionMode: 'yolo' });
    await engine.advanceHandoffs();
    world.switched = [];
    await engine.cancelHandoff('s1');
    landSwitch(world, 's1', 'native:codex');
    // The next one (as a quota-triggered one would be) chooses nothing.
    const next = await engine.startHandoff('s1', { toProfileId: 'janus:claude:work', briefBy: 'incoming' });
    expect(next.ok && next.view.handoff).not.toHaveProperty('permissionMode');
    await engine.advanceHandoffs();
    expect(world.switched).toEqual([{ sessionId: 's1', profileId: 'janus:claude:work' }]);
  });
});
