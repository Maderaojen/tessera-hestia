import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { createContinuity, decodeContinuityState, emptyContinuityState, type Continuity } from '../../src/continuity/engine.js';
import { DEFAULT_CONTINUITY, HANDOFF_PROMPTS } from '../../src/continuity/policy.js';
import type { HandoffConversation } from '../../src/continuity/ports.js';
import { fakePorts, landSwitch, newWorld, sessionView, type World } from './fake-ports.js';

// A handoff recorded as done before ADR 0030 whose CLI never took over —
// cube's, 2026-10-16 (test/fixtures/continuity/cube-lost-handoff.json) —
// is read again once: failed, and recovered the way a live one would be.

const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'fixtures', 'continuity', 'cube-lost-handoff.json'), 'utf8'));
const SID: string = fixture.sessionId;
const HANDOFF_ID: string = fixture.handoffConversation.record.handoffId;
const conversation = fixture.handoffConversation as HandoffConversation;
const UPDATED_PANE = await readFile(path.join(import.meta.dirname, '..', 'fixtures', 'launch-screens', 'codex.updated.0.163.0-cube-handoff.txt'), 'utf8');

let dir: string;
let world: World;
let engine: Continuity;

async function makeEngine(sessionState: object = fixture.continuitySession): Promise<Continuity> {
  const file = path.join(dir, 'c.json');
  await writeFile(file, JSON.stringify({
    version: 1, defaults: { ...DEFAULT_CONTINUITY, mode: 'handoff', chain: ['janus:claude:work', 'native:codex'] }, sessions: { [SID]: sessionState }, accounts: {},
  }));
  return createContinuity(fakePorts(world), jsonFileStore({ path: file, empty: emptyContinuityState, decode: decodeContinuityState }));
}
const view = () => engine.getSession(SID);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lost-handoff-'));
  world = newWorld();
  // After the deploy, later that day: the tmux back at its shell.
  world.now = new Date('2026-10-16T14:00:00.000Z');
  world.sessions = new Map([[SID, sessionView({ conversationId: null, running: false, phase: null, profileId: null, accountId: null })]]);
  world.hits = new Map([[SID, null]]);
  world.handoffConversations.set(`${SID}:${HANDOFF_ID}`, structuredClone(conversation));
  world.briefs.set(conversation.record.briefFile!, '# 交接（系統整理）');
  world.screen = { screen: { kind: 'cli_updated' }, tail: UPDATED_PANE.trim().split('\n').slice(-2).join('\n') };
  engine = await makeEngine();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a handoff recorded as done whose CLI never took over (cube, 2026-10-16)', () => {
  it('its pane says Codex quit to restart after updating: started again, same profile and mode, and the same brief given', async () => {
    await engine.scan();
    const current = await view();
    expect(current.history.slice(-2)).toMatchObject([
      { kind: 'handoff_failed', handoffId: HANDOFF_ID, detail: expect.stringContaining('之前記成完成') },
      { kind: 'handoff_relaunched', handoffId: HANDOFF_ID },
    ]);
    expect(current.handoff).toMatchObject({
      id: HANDOFF_ID, trigger: 'limit_hit', stage: 'switching', relaunch: true, toProfileId: 'native:codex', toLabel: 'Codex (原生)',
      permissionMode: 'yolo', source: 'incoming', confirm: 'auto', fromConversationId: 'ae2181de-bdf1-49ee-b89a-f4d8c5d26bef',
      briefFile: '.hestia/handoffs/20261016-111747Z-d6abb9d7.md', guard: { relaunches: 1 },
    });
    await engine.advanceHandoffs();
    expect(world.launched).toEqual([{ sessionId: SID, profileId: 'native:codex', permissionMode: 'yolo' }]);
    world.screen = { screen: { kind: 'input_ready' }, tail: '› Ask Codex to do anything' };
    landSwitch(world, SID, 'native:codex', 'c-new');
    await engine.advanceHandoffs();
    await engine.advanceHandoffs();
    expect(world.sent.at(-1)?.text).toBe(HANDOFF_PROMPTS.briefIncomingAuto(conversation.briefPath!));
  });

  it('any other pane: failed, and 重新啟動並交接 offered, nothing started', async () => {
    world.screen = { screen: { kind: 'unknown' }, tail: 'dev@host:~/cube$' };
    await engine.scan();
    const current = await view();
    expect(current.handoff).toBeNull();
    expect(current.failedHandoff).toMatchObject({ handoffId: HANDOFF_ID, toProfileId: 'native:codex', permissionMode: 'yolo', tail: 'dev@host:~/cube$' });
    expect(world.launched).toEqual([]);
  });

  it('only once', async () => {
    world.screen = { screen: { kind: 'unknown' }, tail: '$' };
    await engine.scan();
    await engine.dismissFailedHandoff(SID);
    await engine.scan();
    expect((await view()).history.filter((event) => event.kind === 'handoff_failed')).toHaveLength(1);
    expect((await view()).failedHandoff).toBeNull();
  });

  it.each([
    ['a CLI runs in the tmux now', () => world.sessions.set(SID, sessionView({ conversationId: 'c9' }))],
    ['a later conversation was started there', () => { world.handoffConversations.get(`${SID}:${HANDOFF_ID}`)!.latest = false; }],
    ['the conversation had turns: it took over', () => { world.handoffConversations.get(`${SID}:${HANDOFF_ID}`)!.turns = 3; }],
    ['it ended for another reason', () => { world.handoffConversations.get(`${SID}:${HANDOFF_ID}`)!.endReason = 'relaunch'; }],
    ['it ended long after the handoff', () => { world.handoffConversations.get(`${SID}:${HANDOFF_ID}`)!.endedAt = '2026-10-16T13:00:00.000Z'; }],
    ['it is days old', () => { world.now = new Date('2026-10-18T14:00:00.000Z'); }],
    ['its brief is gone', () => { world.briefs.clear(); }],
  ])('left alone when %s', async (_name, change) => {
    change();
    await engine.scan();
    const current = await view();
    expect(current.history.at(-1)?.kind).toBe('handoff_done');
    expect(current.handoff).toBeNull();
    expect(current.failedHandoff).toBeNull();
  });

  it('left alone when something happened in continuity since', async () => {
    const later = { ...fixture.continuitySession, history: [...fixture.continuitySession.history, { at: '2026-10-16T12:00:00.000Z', kind: 'cancelled', detail: null }] };
    engine = await makeEngine(later);
    await engine.scan();
    expect((await view()).history.at(-1)?.kind).toBe('cancelled');
  });
});
