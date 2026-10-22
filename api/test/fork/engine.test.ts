import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forkStatus } from '../../src/contract/fork.js';
import { createForkEngine, decodeForkState, emptyForkState, type ForkEngine } from '../../src/fork/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { fakePorts, firstTurnOver, later, newWorld, sessionView, type World } from './fake-ports.js';

let dir: string;
let file: string;
let world: World;

function makeEngine(): ForkEngine {
  return createForkEngine(fakePorts(world), jsonFileStore({ path: file, empty: emptyForkState, decode: decodeForkState }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fork-'));
  file = path.join(dir, 'fork.json');
  world = newWorld();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function started(engine: ForkEngine, request: Partial<Parameters<ForkEngine['startFork']>[0]> = {}) {
  const result = await engine.startFork({ parentSessionId: 'main', ...request });
  if (!result.ok) throw new Error(result.message);
  return result.fork;
}

// workspace → session → launch → (CLI up) → briefing → (settled) sent → read back.
async function throughStart(engine: ForkEngine): Promise<void> {
  await engine.advance(); // workspace
  await engine.advance(); // session
  await engine.advance(); // launch
  world.sessions.set('branch-1', sessionView());
  await engine.advance(); // up → briefing
  later(world, 5_000);
  await engine.advance(); // sent
  later(world, 4_000);
  await engine.advance(); // read back
  firstTurnOver(world);
  await engine.advance(); // its first turn is through
}

describe('starting a branch line', () => {
  it('records where it came from and picks its session before anything is made', async () => {
    const engine = makeEngine();
    const fork = await started(engine, { instruction: 'Try a two-column settings page\nand compare' });
    expect(fork).toMatchObject({
      id: 'f1f1f1f1',
      title: 'Try a two-column settings page',
      origin: { sessionId: 'main', conversationId: 'c1', tmuxName: 'hestia-main', profileId: 'native:claude', turnsAtFork: 12, commit: 'base0001' },
      profileId: 'native:claude', profileLabel: 'Claude Code', memory: 'native',
      childSessionId: 'branch-1',
      workspace: { isolation: 'worktree', branch: 'fork/f1f1f1f1-try-a-two-column-settings-page', worktree: '/work/hestia-fork-f1f1f1f1' },
      briefFile: '/work/hestia-fork-f1f1f1f1/api/.hestia/forks/f1f1f1f1/brief.md',
      closedAt: null, failedAt: null,
    });
    expect(forkStatus(fork)).toBe('starting');
    expect(world.created).toEqual([]);
  });

  it('forks natively for the same profile, and with a brief for another one', async () => {
    const engine = makeEngine();
    await started(engine);
    await throughStart(engine);
    expect(world.launches[0]).toEqual({ sessionId: 'branch-1', profileId: 'native:claude', from: { sessionId: 'main', conversationId: 'c1' } });
    const other = await started(engine, { profileId: 'native:codex' });
    expect(other.memory).toBe('brief');
  });

  it('goes through the four steps, then sends the line once and is open', async () => {
    const engine = makeEngine();
    const fork = await started(engine);
    await throughStart(engine);
    expect(world.workspaces).toHaveLength(1);
    expect(world.created).toEqual([{ sessionId: 'branch-1', cwd: '/work/hestia-fork-f1f1f1f1/api', projectId: 'proj1', forkId: 'f1f1f1f1', alias: 'hestia-main 的支線' }]);
    expect(world.sent).toEqual([{
      sessionId: 'branch-1',
      text: `[Hestia 支線] 這是從另一個對話分出來的支線。請先讀 ${fork.briefFile}，用一兩句話說明你的理解，然後等使用者的指示。（這是 App 自動送的訊息，不是使用者打的字）`,
    }]);
    const open = await engine.get(fork.id);
    expect(open?.startup).toBeNull();
    expect(forkStatus(open!)).toBe('open');
    expect(world.notices).toEqual([]);
  });

  it('picks up after a restart without making a second session', async () => {
    const first = makeEngine();
    await started(first);
    await first.advance(); // workspace
    await first.advance(); // session
    const second = makeEngine();
    await second.advance(); // launch
    expect(world.created).toHaveLength(1);
    expect(world.launches).toHaveLength(1);
    world.sessions.set('branch-1', sessionView());
    await second.advance();
    later(world, 5_000);
    await second.advance();
    expect(world.sent).toHaveLength(1);
  });

  it('tells the user about a start that needs them once, and clears it when the brief goes in', async () => {
    const engine = makeEngine();
    const fork = await started(engine);
    await engine.advance();
    await engine.advance();
    await engine.advance();
    // Up, but asking something the app can't answer.
    world.sessions.set('branch-1', sessionView({ interaction: true }));
    await engine.advance(); // → briefing
    await engine.advance();
    await engine.advance();
    expect((await engine.get(fork.id))?.issue?.reason).toBe('startup_prompt');
    expect(world.notices).toEqual([{ id: fork.id, body: 'CLI 在等你回應啟動畫面' }]);
    world.sessions.set('branch-1', sessionView());
    later(world, 5_000);
    await engine.advance(); // sent
    later(world, 4_000);
    await engine.advance(); // read back
    firstTurnOver(world);
    await engine.advance(); // its first turn is through
    const open = await engine.get(fork.id);
    expect(open?.issue).toBeNull();
    expect(forkStatus(open!)).toBe('open');
  });

  it('fails with what went wrong, keeping what it made', async () => {
    world.launchOutcome = { ok: false, reason: 'profile gone' };
    const engine = makeEngine();
    const fork = await started(engine);
    await engine.advance();
    await engine.advance();
    await engine.advance();
    const failed = await engine.get(fork.id);
    expect(forkStatus(failed!)).toBe('failed');
    expect(failed?.issue).toMatchObject({ reason: 'launch_failed', detail: 'profile gone' });
    expect(world.notices).toEqual([{ id: fork.id, body: '沒有啟動成功：profile gone' }]);
    // A failed one stays as it is.
    await engine.advance();
    expect(world.launches).toHaveLength(1);
  });

  it('starts again a branch line stuck on a screen before its brief went in: its tmux is closed first (ADR 0030)', async () => {
    const engine = makeEngine();
    const fork = await started(engine);
    await engine.advance(); // workspace
    await engine.advance(); // session
    await engine.advance(); // launch
    world.sessions.set('branch-1', sessionView());
    await engine.advance(); // up → briefing
    // Up, on a screen the app doesn't know: nothing is typed.
    world.screen = { screen: { kind: 'unknown' }, tail: '> 1. Sign in with ChatGPT' };
    later(world, 5_000);
    await engine.advance();
    later(world, 61_000);
    await engine.advance();
    expect((await engine.get(fork.id))?.issue?.reason).toBe('startup_prompt');
    expect(world.sent).toHaveLength(0);
    const result = await engine.relaunch(fork.id);
    expect(result).toMatchObject({ ok: true, fork: { issue: null, startup: { stage: 'workspace' } } });
    expect(world.closed).toContainEqual({ sessionId: 'branch-1', force: true });
  });

  it('starts again, on the user\'s word, once its CLI is gone: after a failed launch, or a CLI that quit (ADR 0030)', async () => {
    world.launchOutcome = { ok: false, reason: 'profile gone' };
    const engine = makeEngine();
    const fork = await started(engine);
    await engine.advance();
    await engine.advance();
    await engine.advance();
    expect(forkStatus((await engine.get(fork.id))!)).toBe('failed');
    world.launchOutcome = { ok: true };
    world.sessions.set('branch-1', sessionView({ running: false, provider: null, phase: null }));
    const result = await engine.relaunch(fork.id);
    expect(result).toMatchObject({ ok: true, fork: { failedAt: null, issue: null, startup: { stage: 'workspace' } } });
    await throughStart(engine);
    expect(world.launches).toHaveLength(2);
    expect(world.sent).toHaveLength(1);
    expect(forkStatus((await engine.get(fork.id))!)).toBe('open');
    // Running: nothing to start again; closed: neither.
    expect(await engine.relaunch(fork.id)).toMatchObject({ ok: false, code: 'cli_already_running' });
    await engine.close(fork.id, {});
    expect(await engine.relaunch(fork.id)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('closes itself when its session is removed, keeping the worktree and saying so once', async () => {
    const engine = makeEngine();
    const fork = await started(engine);
    await throughStart(engine);
    world.notices = [];
    world.sessions.delete('branch-1');
    await engine.advance();
    const closed = await engine.get(fork.id);
    expect(closed).toMatchObject({ closedReason: 'session_removed', cleanup: null });
    expect(forkStatus(closed!)).toBe('closed');
    expect(world.removals).toEqual([]);
    expect(world.notices).toEqual([{ id: fork.id, body: expect.stringContaining(`worktree 還在 /work/hestia-fork-${fork.id}`) }]);
    await engine.advance();
    expect(world.notices).toHaveLength(1);
  });

  it('says nothing more when a removed session\'s branch line shared the folder', async () => {
    world.repo = false;
    const engine = makeEngine();
    const fork = await started(engine);
    await throughStart(engine);
    world.notices = [];
    world.sessions.delete('branch-1');
    await engine.advance();
    expect(await engine.get(fork.id)).toMatchObject({ closedReason: 'session_removed' });
    expect(world.notices).toEqual([]);
  });

  it('refuses a main line with nothing to fork, an unknown one, an unavailable profile', async () => {
    const engine = makeEngine();
    world.parents.set('empty', { ...world.parents.get('main')!, turns: 0 });
    expect(await engine.startFork({ parentSessionId: 'empty' })).toMatchObject({ ok: false, status: 409, code: 'nothing_to_fork' });
    expect(await engine.startFork({ parentSessionId: 'nope' })).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(await engine.startFork({ parentSessionId: 'main', profileId: 'native:agy' })).toMatchObject({ ok: false, code: 'launch_profile_unavailable' });
  });

  it('asks the user to confirm a low quota, then starts', async () => {
    world.quota.set('native:claude', { remainingPercent: 7, limitedUntil: null });
    const engine = makeEngine();
    expect(await engine.startFork({ parentSessionId: 'main' })).toMatchObject({ ok: false, status: 409, code: 'quota_low_confirm', params: { remaining: '7', min: '20' } });
    expect((await engine.startFork({ parentSessionId: 'main', confirmLowQuota: true })).ok).toBe(true);
  });
});

describe('preview', () => {
  it('says how the memory would go and where it would work, writing nothing', async () => {
    const engine = makeEngine();
    const same = await engine.preview('main');
    expect(same).toEqual({
      ok: true,
      preview: {
        memory: 'native', memoryReason: null, profileId: 'native:claude', turnsAtFork: 12,
        workspace: { isolation: 'worktree', path: '/work/hestia-fork-…/api', branch: 'fork/…', baseCommit: 'base0001', repoRoot: '/work/hestia' },
        parentDirtyFiles: ['web/src/App.vue'],
      },
    });
    expect(await engine.preview('main', 'native:codex')).toMatchObject({ ok: true, preview: { memory: 'brief', memoryReason: 'other_profile' } });
    world.parents.set('main', { ...world.parents.get('main')!, forkBlocked: 'runtime_unsupported' });
    expect(await engine.preview('main')).toMatchObject({ ok: true, preview: { memory: 'brief', memoryReason: 'runtime_unsupported' } });
    expect(await engine.list({})).toEqual([]);
    expect(world.workspaces).toEqual([]);
  });
});

describe('closing a branch line', () => {
  it('closes its tmux, removes a merged worktree and branch, and can be sent again', async () => {
    const engine = makeEngine();
    const fork = await started(engine);
    await throughStart(engine);
    const first = await engine.close(fork.id, {});
    expect(first).toMatchObject({ ok: true, outcome: { tmuxClosed: true, workspace: 'removed' }, fork: { closedReason: 'user', cleanup: { result: 'removed' } } });
    expect(world.closed).toEqual([{ sessionId: 'branch-1', force: false }]);
    const again = await engine.close(fork.id, {});
    expect(again).toMatchObject({ ok: true, outcome: { tmuxClosed: false, workspace: 'removed' } });
    expect(world.removals).toHaveLength(1);
  });

  it('keeps an unmerged branch or uncommitted work, and says why', async () => {
    world.removable = { ok: false, code: 'branch_not_merged', message: 'not merged' };
    const engine = makeEngine();
    const fork = await started(engine);
    const result = await engine.close(fork.id, {});
    expect(result).toMatchObject({ ok: true, outcome: { workspace: 'kept', keptReason: 'branch_not_merged' }, fork: { cleanup: { result: 'kept', reason: 'branch_not_merged' } } });
    expect(world.removals).toEqual([]);
    expect(forkStatus((await engine.get(fork.id))!)).toBe('closed');
  });

  it('refuses while its CLI won\'t exit, and forces it when asked', async () => {
    const engine = makeEngine();
    const fork = await started(engine);
    await throughStart(engine);
    world.closeOutcome = { ok: false, reason: 'exit_unverified' };
    expect(await engine.close(fork.id, {})).toMatchObject({ ok: false, status: 409, code: 'fork_still_running', params: { reason: 'exit_unverified' } });
    expect((await engine.get(fork.id))?.closedAt).toBeNull();
    world.closeOutcome = { ok: true, closed: true };
    expect(await engine.close(fork.id, { force: true })).toMatchObject({ ok: true });
    expect(world.closed.at(-1)).toEqual({ sessionId: 'branch-1', force: true });
  });

  it('leaves a shared folder alone', async () => {
    world.repo = false;
    const engine = makeEngine();
    const fork = await started(engine);
    expect(fork.workspace.isolation).toBe('shared');
    expect(await engine.close(fork.id, {})).toMatchObject({ ok: true, outcome: { workspace: 'shared' } });
    expect(world.removals).toEqual([]);
  });
});

describe('listing', () => {
  it('finds a session\'s branch lines from either end, newest first, the open ones on request', async () => {
    const engine = makeEngine();
    const a = await started(engine);
    later(world, 1_000);
    const b = await started(engine);
    await engine.close(a.id, {});
    expect((await engine.list({ sessionId: 'main' })).map((fork) => fork.id)).toEqual([b.id, a.id]);
    expect((await engine.list({ sessionId: 'main', open: true })).map((fork) => fork.id)).toEqual([b.id]);
    expect((await engine.list({ sessionId: 'branch-2' })).map((fork) => fork.id)).toEqual([b.id]);
  });
});

describe('a branch line\'s permission mode (ADR 0027)', () => {
  it('keeps the user\'s choice for the deferred launch', async () => {
    const engine = makeEngine();
    const fork = await started(engine, { permissionMode: 'yolo' });
    expect(fork.permissionMode).toBe('yolo');
    world.permissionSetting = 'auto';
    for (let i = 0; i < 3; i++) await engine.advance();
    expect(world.launches[0]).toMatchObject({ sessionId: 'branch-1', permissionMode: 'yolo' });
  });

  it('follows the main line\'s setting when none is chosen', async () => {
    world.permissionSetting = 'auto';
    const fork = await started(makeEngine());
    expect(fork.permissionMode).toBe('auto');
  });
});
