import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDelegationEngine, decodeDelegationState, emptyDelegationState, type DelegationEngine } from '../../src/delegation/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { childView, fakePorts, firstTurnOver, later, newWorld, type World } from './fake-ports.js';

let dir: string;
let file: string;
let world: World;

function makeEngine(): DelegationEngine {
  return createDelegationEngine(fakePorts(world), jsonFileStore({ path: file, empty: emptyDelegationState, decode: decodeDelegationState }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-'));
  file = path.join(dir, 'delegation.json');
  world = newWorld();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = { parentSessionId: 'p1', task: 'Add a --json flag to `hestia status`.\nKeep the old output.', profileId: 'native:codex' };

async function started(engine: DelegationEngine, initiator: 'user' | 'llm' = 'user') {
  const result = await engine.startDelegation(request, initiator);
  if (!result.ok) throw new Error(result.message);
  return result.delegation.id;
}

// workspace → session → launch → (CLI up) → briefing.
async function upToBriefing(engine: DelegationEngine, id: string): Promise<void> {
  await engine.advance(); // workspace
  await engine.advance(); // session
  await engine.advance(); // launch
  world.children.set('child-1', childView());
  await engine.advance(); // up → briefing
  expect((await engine.get(id))?.startup?.stage).toBe('briefing');
  // The CLI draws its input box.
  later(world, 5_000);
}

async function working(engine: DelegationEngine): Promise<string> {
  const id = await started(engine);
  await upToBriefing(engine, id);
  await engine.advance(); // sent
  later(world, 4_000);
  await engine.advance(); // read back
  firstTurnOver(world);
  await engine.advance(); // its first turn is through
  expect((await engine.get(id))?.state).toBe('working');
  return id;
}

describe('starting a delegation', () => {
  it('records it as starting, with the planned worktree, branch and brief', async () => {
    const engine = makeEngine();
    const result = await engine.startDelegation({ ...request, title: 'Status JSON flag' }, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation).toMatchObject({
      id: 'ab12cd34', title: 'Status JSON flag', initiator: 'user', parentSessionId: 'p1', parentConversationId: 'c1',
      profileId: 'native:codex', profileLabel: 'Codex CLI', state: 'starting', round: 1, childSessionId: null,
      workspace: { isolation: 'worktree', path: '/work/hestia-delegate-ab12cd34/api', branch: 'delegate/ab12cd34-status-json-flag', baseCommit: 'base0001' },
      briefFile: '/work/hestia-delegate-ab12cd34/api/.hestia/delegations/ab12cd34/brief.md',
      startup: { stage: 'workspace' },
    });
    const saved = JSON.parse(await readFile(file, 'utf-8'));
    expect(saved.delegations.ab12cd34.state).toBe('starting');
    expect(saved.preferences).toMatchObject({ isolation: 'worktree', idleAttentionMinutes: 20 });
  });

  it('titles it from the task when no title is given, keeping only ASCII words in the branch', async () => {
    const engine = makeEngine();
    const result = await engine.startDelegation({ ...request, task: '把狀態輸出改成 JSON\n細節…' }, 'user');
    expect(result.ok && result.delegation.title).toBe('把狀態輸出改成 JSON');
    expect(result.ok && result.delegation.workspace.branch).toBe('delegate/ab12cd34-json');
    const chinese = await engine.startDelegation({ ...request, title: '狀態輸出' }, 'user');
    expect(chinese.ok && chinese.delegation.workspace.branch).toBe('delegate/ef56ab78');
  });

  it('refuses an unknown session, a missing profile and an unknown profile', async () => {
    const engine = makeEngine();
    expect(await engine.startDelegation({ ...request, parentSessionId: 'nope' }, 'user')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(await engine.startDelegation({ ...request, profileId: undefined }, 'user')).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await engine.startDelegation({ ...request, profileId: 'janus:x' }, 'user')).toMatchObject({ ok: false, code: 'launch_profile_unavailable' });
  });

  it('works in the same folder when it is not a git repo', async () => {
    world.repo = false;
    const engine = makeEngine();
    const result = await engine.startDelegation(request, 'user');
    expect(result.ok && result.delegation.workspace).toMatchObject({ isolation: 'shared', path: '/work/hestia/api', branch: null });
  });

  it('goes through workspace, session, launch and briefing to working', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    await engine.advance();
    let d = (await engine.get(id))!;
    expect(world.workspaces).toHaveLength(1);
    expect(d.childSessionId).toBe('child-1');
    expect(d.startup?.stage).toBe('session');
    const brief = world.briefs.get(d.briefFile)!;
    expect(brief).toContain('Add a --json flag');
    expect(brief).toContain('delegate/ab12cd34');
    expect(brief).toContain('hestia delegate done --report-file /work/hestia-delegate-ab12cd34/api/.hestia/delegations/ab12cd34/report.md');
    // Where the delegating conversation is, not a copy of it.
    expect(brief).not.toContain('parent-conversation');
    expect(brief).toContain('hestia conversation show --upstream');
    expect(brief).toContain('hestia conversation show --session p1 --conversation c1 --turns ..2');
    expect(world.upstreamReads).toEqual([{ sessionId: 'p1', conversationId: 'c1', upTo: null }]);
    expect(d.parentTurnsAtStart).toBe(2);
    expect(brief).toContain('那些改動不在這裡');

    await engine.advance();
    expect(world.createdSessions).toEqual([{
      sessionId: 'child-1', cwd: '/work/hestia-delegate-ab12cd34/api', projectId: 'proj1', delegationId: id, alias: d.title,
      origin: { fromSessionId: 'p1', fromConversationId: 'c1' },
    }]);
    await engine.advance();
    expect(world.launches).toEqual([{ sessionId: 'child-1', profileId: 'native:codex' }]);
    // Still coming up.
    await engine.advance();
    expect((await engine.get(id))?.startup?.stage).toBe('launch');
    world.children.set('child-1', childView());
    await engine.advance();
    // Typed only once the CLI has had a moment to draw its input box.
    await engine.advance();
    expect(world.sent).toEqual([]);
    later(world, 5_000);
    await engine.advance();
    expect(world.sent).toEqual([{ sessionId: 'child-1', text: `請讀 ${d.briefFile}，先用一段話回報你的理解，然後開始。` }]);
    // Read back only after a moment.
    later(world, 1_000);
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('starting');
    later(world, 3_000);
    await engine.advance();
    // In; at work once its first turn is through (ADR 0030).
    expect((await engine.get(id))?.state).toBe('starting');
    firstTurnOver(world);
    await engine.advance();
    d = (await engine.get(id))!;
    expect(d).toMatchObject({ state: 'working', startup: null, briefSentAt: '2026-10-06T10:00:05.000Z' });
  });

  it('picks up after a restart without making a second session or launching twice', async () => {
    let engine = makeEngine();
    const id = await started(engine);
    await engine.advance(); // workspace: child id saved
    await engine.advance(); // session made
    // A new process reading the same file.
    engine = makeEngine();
    await engine.advance(); // launch
    engine = makeEngine();
    // The launch landed but the record of it was lost: the bound CLI counts.
    const saved = JSON.parse(await readFile(file, 'utf-8'));
    saved.delegations[id].startup.launchedAt = null;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(saved));
    engine = makeEngine();
    await engine.advance();
    expect(world.createdSessions).toHaveLength(1);
    expect(world.launches).toHaveLength(1);
    expect((await engine.get(id))?.startup?.launchedAt).not.toBeNull();
  });

  it('writing the brief again points at the same turns, not the ones added since', async () => {
    let engine = makeEngine();
    const id = await started(engine);
    expect((await engine.get(id))?.parentTurnsAtStart).toBeNull();
    await engine.advance(); // workspace
    // A restart before the next step was saved; the delegating conversation went on meanwhile.
    const saved = JSON.parse(await readFile(file, 'utf-8'));
    saved.delegations[id].startup.stage = 'workspace';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(saved));
    world.upstreamTurns.push({ index: 3, request: '另一件事' });
    engine = makeEngine();
    await engine.advance();
    const d = (await engine.get(id))!;
    expect(d.parentTurnsAtStart).toBe(2);
    expect(world.upstreamReads.at(-1)).toEqual({ sessionId: 'p1', conversationId: 'c1', upTo: 2 });
    const brief = world.briefs.get(d.briefFile)!;
    expect(brief).toContain('--turns ..2');
    expect(brief).toContain('到指派時為止的 2 輪');
    expect(brief).not.toContain('另一件事');
  });

  it('keeps no count when the delegating conversation has no turns, so --upstream prints all of it later', async () => {
    world.upstreamTurns = [];
    const engine = makeEngine();
    const id = await started(engine);
    await engine.advance(); // workspace
    const d = (await engine.get(id))!;
    expect(d.parentTurnsAtStart).toBeNull();
    expect(world.briefs.get(d.briefFile)).toContain('沒有發起對話的紀錄');
  });

  it('reads the conversation it was delegated from, even once that session is on another one', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    world.parents.set('p1', { ...world.parents.get('p1')!, conversationId: 'c9' });
    await engine.advance();
    expect(world.upstreamReads).toEqual([{ sessionId: 'p1', conversationId: 'c1', upTo: null }]);
    expect(world.briefs.get((await engine.get(id))!.briefFile)).toContain('--conversation c1');
  });

  it('does not send the brief again after a restart once it was sent', async () => {
    let engine = makeEngine();
    const id = await started(engine);
    await upToBriefing(engine, id);
    await engine.advance();
    engine = makeEngine();
    world.delivery = 'missing';
    later(world, 4_000);
    await engine.advance();
    expect(world.sent).toHaveLength(1);
    world.delivery = 'exact';
    await engine.advance();
    firstTurnOver(world);
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('working');
  });

  it('stops as launch_failed, telling the user, when the worktree cannot be made', async () => {
    world.workspaceError = 'fatal: a branch named delegate/x already exists';
    const engine = makeEngine();
    const id = await started(engine);
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'stopped', stateReason: 'launch_failed', stateDetail: expect.stringContaining('already exists'), startup: null });
    expect(world.notices).toEqual([{ id, body: expect.stringMatching(/^沒有啟動成功：/) }]);
  });

  it('stops as launch_failed when the launch is refused', async () => {
    world.launchOutcome = { ok: false, reason: 'launch config incomplete' };
    const engine = makeEngine();
    const id = await started(engine);
    await engine.advance();
    await engine.advance();
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'stopped', stateReason: 'launch_failed', stateDetail: 'launch config incomplete' });
  });

  it('stops as launch_failed when the CLI never comes up', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    await engine.advance();
    await engine.advance();
    await engine.advance();
    later(world, 4 * 60_000);
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'stopped', stateReason: 'launch_failed' });
  });
});

describe('the trust prompt and other start-up screens', () => {
  it('answers "trust" once for a delegation the user started, and writes it down', async () => {
    const engine = makeEngine();
    const id = await started(engine, 'user');
    await upToBriefing(engine, id);
    world.children.set('child-1', childView({ startupPrompt: 'workspace_trust' }));
    await engine.advance();
    expect(world.trustAnswers).toEqual(['child-1']);
    expect(world.sent).toHaveLength(0);
    const d = (await engine.get(id))!;
    expect(d.reports).toEqual([{ kind: 'decision', by: 'system', at: world.now.toISOString(), text: expect.stringContaining('/work/hestia-delegate-ab12cd34/api') }]);
    // The prompt is gone: the brief goes in, once the CLI has settled.
    await engine.advance();
    expect(world.sent).toHaveLength(0);
    later(world, 5_000);
    await engine.advance();
    expect(world.sent).toHaveLength(1);
  });

  it('asks the user when the trust prompt stays after answering', async () => {
    world.trustAnswer = 'answered';
    const engine = makeEngine();
    const id = await started(engine, 'user');
    await upToBriefing(engine, id);
    world.children.set('child-1', childView({ startupPrompt: 'workspace_trust' }));
    await engine.advance();
    world.children.set('child-1', childView({ startupPrompt: 'workspace_trust' }));
    later(world, 31_000);
    await engine.advance();
    expect(world.trustAnswers).toHaveLength(1);
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'workspace_trust' });
  });

  it('never answers it for a delegation nobody approved, and starts again once the user has', async () => {
    const engine = makeEngine();
    await engine.setSettings({ preferences: { llmInitiated: 'allow', targets: ['native:codex'] } });
    const id = await started(engine, 'llm');
    await upToBriefing(engine, id);
    world.children.set('child-1', childView({ startupPrompt: 'workspace_trust' }));
    await engine.advance();
    expect(world.trustAnswers).toEqual([]);
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'workspace_trust', startup: { stage: 'briefing', sentAt: null } });
    expect(world.notices.at(-1)?.body).toContain('信任');
    // Still there: nothing changes.
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('needs_attention');
    // The user answered it in the app.
    world.children.set('child-1', childView());
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('starting');
    later(world, 5_000);
    await engine.advance();
    expect(world.sent).toHaveLength(1);
  });

  it('leaves any other start-up screen to the user', async () => {
    const engine = makeEngine();
    const id = await started(engine, 'user');
    await upToBriefing(engine, id);
    world.children.set('child-1', childView({ interaction: true }));
    await engine.advance();
    expect(world.trustAnswers).toEqual([]);
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'startup_prompt' });
    world.children.set('child-1', childView());
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('starting');
  });

  it('asks the user when the instruction arrives cut short twice', async () => {
    world.delivery = 'partial';
    const engine = makeEngine();
    const id = await started(engine);
    await upToBriefing(engine, id);
    await engine.advance();
    later(world, 4_000);
    await engine.advance(); // resend scheduled
    world.children.set('child-1', childView());
    await engine.advance();
    expect(world.sent).toHaveLength(2);
    later(world, 4_000);
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'brief_not_delivered' });
  });
});

describe('a delegation at work', () => {
  it('records the first reply as what it understood, without waiting', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.firstReply = 'I will add a --json flag to the status command.';
    await engine.advance();
    const d = (await engine.get(id))!;
    expect(d.state).toBe('working');
    expect(d.reports).toEqual([expect.objectContaining({ kind: 'understanding', by: 'child', text: world.firstReply })]);
    await engine.advance();
    expect((await engine.get(id))!.reports).toHaveLength(1);
  });

  it('needs attention after sitting idle too long, and goes back to work on a new turn', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.children.set('child-1', childView({ lastTurnAt: world.now.toISOString() }));
    later(world, 19 * 60_000);
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('working');
    later(world, 2 * 60_000);
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'idle' });
    expect(world.notices.at(-1)?.body).toContain('20 分鐘');
    // Told once.
    const told = world.notices.length;
    await engine.advance();
    expect(world.notices).toHaveLength(told);
    later(world, 60_000);
    world.children.set('child-1', childView({ phase: 'replying', lastSentAt: world.now.toISOString() }));
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'working', stateReason: null });
  });

  it('keeps waiting while continuity has a carry-on or handoff pending', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.continuityBusy = true;
    later(world, 60 * 60_000);
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('working');
    world.children.set('child-1', childView({ running: false, phase: null }));
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('working');
  });

  it('needs attention when its CLI ends', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.children.set('child-1', childView({ running: false, phase: null }));
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'cli_exited' });
  });

  it('stops as child_gone when its session is deleted', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.children.delete('child-1');
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'stopped', stateReason: 'child_gone' });
  });
});

describe('delivering', () => {
  it('refuses a worktree with uncommitted changes', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.clean = false;
    expect(await engine.deliver(id, { fromSessionId: 'child-1', report: 'done' })).toMatchObject({ ok: false, status: 409, code: 'workspace_dirty' });
    expect((await engine.get(id))?.state).toBe('working');
  });

  it('is delivered, with the head and the report, and the user is told (no LLM review)', async () => {
    const engine = makeEngine();
    await engine.setSettings({ preferences: { parentReview: false } });
    const id = await working(engine);
    const result = await engine.deliver(id, { fromSessionId: 'child-1', report: '## Done\n- added --json' });
    expect(result).toMatchObject({ ok: true, delegation: { state: 'delivered', workspace: { headAtDelivery: 'f00dfeed' } } });
    expect((await engine.get(id))!.reports.at(-1)).toMatchObject({ kind: 'delivery', by: 'child', text: '## Done\n- added --json' });
    expect(world.notices.at(-1)).toEqual({ id, body: '已交付，等你驗收' });
    // Idle from here on is not the delegate's business any more.
    later(world, 60 * 60_000);
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('delivered');
  });

  it('only takes a delivery from the delegate itself', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    expect(await engine.deliver(id, { fromSessionId: 'p9', report: 'x' })).toMatchObject({ ok: false, code: 'not_in_managed_tmux' });
    world.children.set('other', childView());
    expect(await engine.deliver(id, { fromSessionId: 'other', report: 'x' })).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('refuses a delivery while starting', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    expect(await engine.deliver(id, { fromSessionId: 'child-1', report: 'x' })).toMatchObject({ ok: false, status: 409, code: 'delegation_state', params: { state: 'starting' } });
  });

  it('the user starts a delegate whose CLI quit again, and its brief goes in again (ADR 0030)', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    // Running: nothing to start again.
    expect(await engine.relaunch(id)).toMatchObject({ ok: false, code: 'cli_already_running' });
    world.children.set('child-1', childView({ running: false, provider: null, phase: null }));
    await engine.advance();
    expect((await engine.get(id))?.stateReason).toBe('cli_exited');
    const result = await engine.relaunch(id);
    expect(result).toMatchObject({ ok: true, delegation: { state: 'starting', startup: { stage: 'workspace' } } });
    const launches = world.launches.length;
    await engine.advance(); // workspace (as it was)
    await engine.advance(); // session (still there)
    await engine.advance(); // launch
    expect(world.launches).toHaveLength(launches + 1);
    world.children.set('child-1', childView());
    await engine.advance(); // briefing
    later(world, 5_000);
    await engine.advance();
    expect(world.sent.filter((sent) => sent.sessionId === 'child-1')).toHaveLength(2);
    // Over: nothing to start again.
    await engine.stopDelegation(id);
    expect(await engine.relaunch(id)).toMatchObject({ ok: false, code: 'delegation_state' });
  });

  it('the user starts again a delegate stuck on a screen before its brief went in: its tmux is closed first (ADR 0030)', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    await upToBriefing(engine, id);
    world.screen = { screen: { kind: 'unknown' }, tail: '> 1. Sign in with ChatGPT' };
    await engine.advance();
    later(world, 61_000);
    await engine.advance();
    expect(await engine.get(id)).toMatchObject({ state: 'needs_attention', stateReason: 'startup_prompt' });
    expect(world.sent).toHaveLength(0);
    // Its CLI still runs, but has done nothing: ended (forced), then started from the top.
    const result = await engine.relaunch(id);
    expect(result).toMatchObject({ ok: true, delegation: { state: 'starting', startup: { stage: 'workspace' } } });
    expect(world.closed).toContain('child-1');
  });

  it('won\'t end a stuck delegate\'s CLI when it can\'t be closed (ADR 0030)', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    await upToBriefing(engine, id);
    world.screen = { screen: { kind: 'unknown' }, tail: '?' };
    await engine.advance();
    later(world, 61_000);
    await engine.advance();
    world.closeOutcome = { ok: false, reason: 'in_transition' };
    expect(await engine.relaunch(id)).toMatchObject({ ok: false, code: 'cli_already_running' });
    expect((await engine.get(id))?.state).toBe('needs_attention');
  });

  it('takes a delivery made within the first turn, once the brief is in (ADR 0030)', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    await upToBriefing(engine, id);
    await engine.advance(); // sent
    later(world, 4_000);
    await engine.advance(); // read back: in, its first turn watched
    expect((await engine.get(id))?.state).toBe('starting');
    expect(await engine.deliver(id, { fromSessionId: 'other', report: 'x' })).toMatchObject({ ok: false });
    expect((await engine.get(id))?.state).toBe('starting');
    const result = await engine.deliver(id, { fromSessionId: 'child-1', report: 'done quickly' });
    expect(result).toMatchObject({ ok: true, delegation: { state: 'delivered', startup: null, briefSentAt: expect.any(String) } });
  });

  it('--blocked needs attention at once with the question, even with uncommitted work, and resumes on the user\'s answer', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.clean = false;
    // The delegate runs it inside its own turn.
    world.children.set('child-1', childView({ phase: 'replying', lastSentAt: world.now.toISOString() }));
    const result = await engine.deliver(id, { fromSessionId: 'child-1', report: 'Which flag name?\nOptions: --json, --format', blocked: true });
    expect(result).toMatchObject({ ok: true, delegation: { state: 'needs_attention', stateReason: 'blocked', stateDetail: 'Which flag name?' } });
    expect(world.notices.at(-1)?.body).toBe('被指派者需要你決定：Which flag name?');
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('needs_attention');
    later(world, 60_000);
    world.children.set('child-1', childView({ phase: 'replying', lastSentAt: world.now.toISOString() }));
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('working');
  });
});

describe('accepting, rejecting, stopping', () => {
  async function delivered(engine: DelegationEngine): Promise<string> {
    const id = await working(engine);
    await engine.deliver(id, { fromSessionId: 'child-1', report: 'done' });
    return id;
  }

  it('accepts a delivered one, merging nothing', async () => {
    const engine = makeEngine();
    const id = await delivered(engine);
    const result = await engine.accept(id);
    expect(result).toMatchObject({ ok: true, delegation: { state: 'accepted', endedAt: world.now.toISOString() } });
    expect((await engine.get(id))!.reports.at(-1)).toMatchObject({ kind: 'decision', by: 'user', verdict: 'accept' });
    expect(await engine.accept(id)).toMatchObject({ ok: false, code: 'delegation_state' });
  });

  it('rejects a delivered one', async () => {
    const engine = makeEngine();
    const id = await delivered(engine);
    expect(await engine.reject(id)).toMatchObject({ ok: true, delegation: { state: 'rejected' } });
  });

  it('accepts only what was delivered', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    expect(await engine.accept(id)).toMatchObject({ ok: false, status: 409, code: 'delegation_state' });
    expect(await engine.reject(id)).toMatchObject({ ok: false, status: 409, code: 'delegation_state' });
  });

  it('stops one at work, interrupting its reply, and keeps it stopped', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    world.children.set('child-1', childView({ phase: 'replying' }));
    expect(await engine.stopDelegation(id)).toMatchObject({ ok: true, delegation: { state: 'stopped', stateReason: 'user' } });
    expect(world.interrupted).toEqual(['child-1']);
    await engine.advance();
    expect((await engine.get(id))?.state).toBe('stopped');
    expect(await engine.stopDelegation(id)).toMatchObject({ ok: false, code: 'delegation_state' });
  });

  it('stops one still starting', async () => {
    const engine = makeEngine();
    const id = await started(engine);
    expect(await engine.stopDelegation(id)).toMatchObject({ ok: true, delegation: { state: 'stopped', startup: null } });
    await engine.advance();
    expect(world.workspaces).toEqual([]);
  });

  it('answers not_found for an unknown id', async () => {
    const engine = makeEngine();
    expect(await engine.accept('nope')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
  });
});

describe('listing', () => {
  it('lists a session\'s delegations, newest first, as the delegator or the delegate', async () => {
    const engine = makeEngine();
    const first = await working(engine);
    later(world, 1_000);
    const second = await started(engine);
    expect((await engine.list({ sessionId: 'p1' })).map((d) => d.id)).toEqual([second, first]);
    expect((await engine.list({ sessionId: 'child-1' })).map((d) => d.id)).toEqual([first]);
    await engine.stopDelegation(second);
    expect((await engine.list({ active: true })).map((d) => d.id)).toEqual([first]);
  });
});

describe('the delegate\'s permission mode (ADR 0027)', () => {
  it('is decided when it is made and kept for the deferred launch', async () => {
    const engine = makeEngine();
    const result = await engine.startDelegation({ ...request, permissionMode: 'yolo' }, 'user');
    if (!result.ok) throw new Error(result.message);
    expect(result.delegation.permissionMode).toBe('yolo');
    // A later change to the setting doesn't touch it.
    world.permissionSetting = 'cli_default';
    for (let i = 0; i < 3; i++) await engine.advance();
    expect(world.launches).toEqual([{ sessionId: 'child-1', profileId: 'native:codex', permissionMode: 'yolo' }]);
  });

  it('follows the delegating tmux\'s setting when none is chosen, and caps an LLM\'s below yolo', async () => {
    world.permissionSetting = 'yolo';
    const engine = makeEngine();
    const user = await engine.startDelegation(request, 'user');
    expect(user.ok && user.delegation.permissionMode).toBe('yolo');
    await engine.setSettings({ preferences: { targets: ['native:codex'], llmInitiated: 'allow' } });
    const llm = await engine.startDelegation({ parentSessionId: 'p1', task: 'x' }, 'llm');
    expect(llm.ok && llm.delegation.permissionMode).toBe('auto');
  });

  it('refuses an LLM that asks for a mode, and a mode the runtime lacks', async () => {
    const engine = makeEngine();
    await engine.setSettings({ preferences: { targets: ['native:codex'], llmInitiated: 'allow' } });
    const llm = await engine.startDelegation({ parentSessionId: 'p1', task: 'x', permissionMode: 'auto' }, 'llm');
    expect(llm).toMatchObject({ ok: false, status: 403, code: 'login_required' });
    world.permissionSupported = ['cli_default', 'yolo'];
    const unsupported = await engine.startDelegation({ ...request, permissionMode: 'auto' }, 'user');
    expect(unsupported).toMatchObject({ ok: false, status: 400, code: 'permission_mode_unsupported' });
  });
});
