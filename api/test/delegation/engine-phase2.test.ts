import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DELEGATION_MESSAGES, delegationMessageKind } from '../../src/contract/delegation.js';
import { createDelegationEngine, decodeDelegationState, emptyDelegationState, type DelegationEngine } from '../../src/delegation/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { childView, fakePorts, firstTurnOver, later, newWorld, type World } from './fake-ports.js';

// Phase 2 (ADR 0015 決策 6, 7, 10, 13): an LLM starting one (and the
// user's approval), the checks, the settings, and what goes back to the
// delegating conversation.

let dir: string;
let file: string;
let world: World;

function makeEngine(): DelegationEngine {
  return createDelegationEngine(fakePorts(world), jsonFileStore({ path: file, empty: emptyDelegationState, decode: decodeDelegationState }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-p2-'));
  file = path.join(dir, 'delegation.json');
  world = newWorld();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const task = { parentSessionId: 'p1', task: 'Add a --json flag to `hestia status`.' };

async function letLlm(engine: DelegationEngine, llmInitiated: 'allow' | 'ask' | 'off' = 'allow', targets = ['native:codex']) {
  await engine.setSettings({ preferences: { llmInitiated, targets } });
}

async function startOk(engine: DelegationEngine, initiator: 'user' | 'llm', extra: Record<string, unknown> = {}) {
  const result = await engine.startDelegation({ ...task, profileId: 'native:codex', ...extra }, initiator);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.delegation;
}

// From starting to working (as in engine.test.ts).
async function toWorking(engine: DelegationEngine, id: string, childId = 'child-1'): Promise<void> {
  await engine.advance(); // workspace
  await engine.advance(); // session
  await engine.advance(); // launch
  world.children.set(childId, childView({ profileId: 'native:codex' }));
  await engine.advance(); // briefing
  later(world, 5_000);
  await engine.advance(); // sent
  later(world, 4_000);
  await engine.advance(); // read back
  firstTurnOver(world, childId);
  await engine.advance(); // its first turn is through
  expect((await engine.get(id))?.state).toBe('working');
}

// The delegating CLI quiet long enough to be told something.
function parentQuiet(): void {
  later(world, 60_000);
  world.children.set('p1', childView({ profileId: 'native:claude', lastTurnAt: new Date(world.now.getTime() - 60_000).toISOString() }));
}

const sentToParent = () => world.sent.filter((s) => s.sessionId === 'p1').map((s) => s.text);

describe('an LLM starting one', () => {
  it('is refused with no targets (the default), or when LLM delegation is off', async () => {
    const engine = makeEngine();
    expect(await engine.startDelegation(task, 'llm')).toMatchObject({ ok: false, code: 'profile_not_allowed' });
    await letLlm(engine, 'off');
    expect(await engine.startDelegation(task, 'llm')).toMatchObject({ ok: false, code: 'delegation_disabled' });
    expect(await engine.list({})).toEqual([]);
  });

  it('goes to the first target by default, only to a target, and only stricter isolation', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'allow', ['native:claude', 'native:codex']);
    const first = await engine.startDelegation(task, 'llm');
    expect(first.ok && first.delegation).toMatchObject({ profileId: 'native:claude', initiator: 'llm', state: 'starting', approvedAt: null });
    expect(await engine.startDelegation({ ...task, profileId: 'gone' }, 'llm')).toMatchObject({ ok: false, code: 'profile_not_allowed' });
    expect(await engine.startDelegation({ ...task, isolation: 'shared' }, 'llm')).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('says not_in_managed_tmux for a session the app doesn\'t have', async () => {
    const engine = makeEngine();
    await letLlm(engine);
    expect(await engine.startDelegation({ ...task, parentSessionId: 'nope' }, 'llm')).toMatchObject({ ok: false, code: 'not_in_managed_tmux' });
    expect(await engine.startDelegation({ ...task, parentSessionId: 'nope', profileId: 'native:codex' }, 'user')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('uses the tmux\'s own settings over the global ones', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'off');
    await engine.setSessionSettings('p1', { preferences: { llmInitiated: 'allow' } });
    expect((await engine.startDelegation(task, 'llm')).ok).toBe(true);
  });
});

describe('proposals (llmInitiated ask)', () => {
  it('waits for the user without making anything, and pushes the proposal', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'ask');
    const proposed = await startOk(engine, 'llm');
    expect(proposed).toMatchObject({ state: 'proposed', startup: null, quotaAtStart: null, depth: 1 });
    expect(world.notices.at(-1)?.body).toContain('等你核准');
    for (let i = 0; i < 3; i++) await engine.advance();
    expect(world.workspaces).toEqual([]);
    expect(world.createdSessions).toEqual([]);
    expect((await engine.get(proposed.id))?.state).toBe('proposed');
  });

  it('starts once approved, trusting the new worktree on the user\'s behalf', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'ask');
    const proposed = await startOk(engine, 'llm');
    const approved = await engine.approve(proposed.id);
    expect(approved.ok && approved.delegation).toMatchObject({ state: 'starting', approvedAt: world.now.toISOString(), startup: { stage: 'workspace' } });
    expect(approved.ok && approved.delegation.reports.at(-1)).toMatchObject({ kind: 'decision', by: 'user' });
    await engine.advance();
    await engine.advance();
    await engine.advance();
    world.children.set('child-1', childView({ startupPrompt: 'workspace_trust' }));
    await engine.advance(); // briefing
    await engine.advance(); // the trust prompt
    expect(world.trustAnswers).toEqual(['child-1']);
    expect((await engine.get(proposed.id))?.reports.at(-1)?.text).toContain('核准');
    // Only once.
    expect(await engine.approve(proposed.id)).toMatchObject({ ok: false, code: 'delegation_state' });
  });

  it('runs the checks again when approved', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'ask');
    const proposed = await startOk(engine, 'llm');
    world.quota.set('native:codex', { remainingPercent: 5, limitedUntil: null });
    expect(await engine.approve(proposed.id)).toMatchObject({ ok: false, code: 'quota_too_low' });
    expect((await engine.get(proposed.id))?.state).toBe('proposed');
    world.quota.set('native:codex', { remainingPercent: 60, limitedUntil: null });
    // Not counted against itself.
    await engine.setSettings({ limits: { maxConcurrent: 1 } });
    const approved = await engine.approve(proposed.id);
    expect(approved.ok && approved.delegation).toMatchObject({ state: 'starting', quotaAtStart: 60 });
  });

  it('stops when declined, telling the delegating conversation', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'ask');
    const proposed = await startOk(engine, 'llm');
    const declined = await engine.decline(proposed.id);
    expect(declined.ok && declined.delegation).toMatchObject({ state: 'stopped', stateReason: 'declined', outbox: [{ event: 'declined', to: 'parent' }] });
    parentQuiet();
    await engine.advance();
    expect(sentToParent()).toHaveLength(1);
    expect(delegationMessageKind(sentToParent()[0]!)).toBe('parent');
  });

  it('expires after 24 hours without an answer', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'ask');
    const proposed = await startOk(engine, 'llm');
    later(world, 23 * 60 * 60_000);
    await engine.advance();
    expect((await engine.get(proposed.id))?.state).toBe('proposed');
    later(world, 60 * 60_000);
    await engine.advance();
    expect(await engine.get(proposed.id)).toMatchObject({ state: 'stopped', stateReason: 'expired' });
  });
});

describe('limits', () => {
  it('refuses a delegate delegating past maxDepth', async () => {
    const engine = makeEngine();
    const first = await startOk(engine, 'user');
    await toWorking(engine, first.id);
    // The delegate's own session delegates.
    world.parents.set('child-1', { cwd: '/work/hestia-delegate-ab12cd34/api', projectId: 'proj1', tmuxName: 'hestia-child-1', conversationId: 'cc', profileId: 'native:codex', profileLabel: 'Codex CLI' });
    expect(await engine.startDelegation({ ...task, parentSessionId: 'child-1', profileId: 'native:claude' }, 'user'))
      .toMatchObject({ ok: false, code: 'limit_reached', params: { limit: 'depth' } });
    await engine.setSettings({ limits: { maxDepth: 2 } });
    const deeper = await engine.startDelegation({ ...task, parentSessionId: 'child-1', profileId: 'native:claude' }, 'user');
    expect(deeper.ok && deeper.delegation.depth).toBe(2);
  });

  it('counts host-wide against the global limit, and the tmux\'s own against its override', async () => {
    const engine = makeEngine();
    world.parents.set('p2', { ...world.parents.get('p1')!, tmuxName: 'hestia-p2' });
    await engine.setSessionSettings('p1', { limits: { maxConcurrent: 1 } });
    await startOk(engine, 'user');
    expect(await engine.startDelegation({ ...task, profileId: 'native:codex' }, 'user'))
      .toMatchObject({ ok: false, code: 'limit_reached', params: { limit: 'concurrent', max: '1' } });
    await startOk(engine, 'user', { parentSessionId: 'p2' });
    await startOk(engine, 'user', { parentSessionId: 'p2' });
    // Three going on the host (the global default).
    expect(await engine.startDelegation({ ...task, parentSessionId: 'p2', profileId: 'native:codex' }, 'user'))
      .toMatchObject({ ok: false, code: 'limit_reached', params: { limit: 'concurrent', max: '3' } });
  });

  it('checks the target account\'s quota, recording it, and allows unknown quota', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'allow');
    world.quota.set('native:codex', { remainingPercent: 12, limitedUntil: null });
    expect(await engine.startDelegation({ ...task, profileId: 'native:codex' }, 'llm')).toMatchObject({ ok: false, code: 'quota_too_low' });
    // The LLM can't confirm its way past it.
    expect(await engine.startDelegation({ ...task, profileId: 'native:codex', confirmLowQuota: true }, 'llm')).toMatchObject({ ok: false, code: 'quota_too_low' });
    world.quota.set('native:codex', { remainingPercent: 90, limitedUntil: '2026-10-06T12:00:00.000Z' });
    expect(await engine.startDelegation({ ...task, profileId: 'native:codex' }, 'llm')).toMatchObject({ ok: false, code: 'quota_too_low', params: { until: '2026-10-06T12:00:00.000Z' } });
    expect(await engine.list({})).toEqual([]);
    world.quota.set('native:codex', { remainingPercent: 55, limitedUntil: null });
    expect((await startOk(engine, 'user')).quotaAtStart).toBe(55);
    expect((await startOk(engine, 'user', { profileId: 'native:claude' })).quotaAtStart).toBeNull();
  });
});

describe('the user starting one on a low quota', () => {
  it('asks the user to confirm first, saying how much is left', async () => {
    const engine = makeEngine();
    world.quota.set('native:codex', { remainingPercent: 12, limitedUntil: null });
    expect(await engine.startDelegation({ ...task, profileId: 'native:codex' }, 'user'))
      .toMatchObject({ ok: false, status: 409, code: 'quota_low_confirm', params: { remaining: '12', min: '20' } });
    world.quota.set('native:codex', { remainingPercent: 90, limitedUntil: '2026-10-06T12:00:00.000Z' });
    expect(await engine.startDelegation({ ...task, profileId: 'native:codex', confirmLowQuota: false }, 'user'))
      .toMatchObject({ ok: false, code: 'quota_low_confirm', params: { remaining: '0', until: '2026-10-06T12:00:00.000Z' } });
    expect(await engine.list({})).toEqual([]);
  });

  it('starts once confirmed, writing the decision down', async () => {
    const engine = makeEngine();
    world.quota.set('native:codex', { remainingPercent: 90, limitedUntil: '2026-10-06T12:00:00.000Z' });
    const started = await startOk(engine, 'user', { confirmLowQuota: true });
    expect(started).toMatchObject({ state: 'starting', quotaAtStart: 90 });
    expect(started.reports).toEqual([expect.objectContaining({ kind: 'decision', by: 'user', text: expect.stringContaining('2026-10-06T12:00:00.000Z 重置') })]);
    world.quota.set('native:codex', { remainingPercent: 3, limitedUntil: null });
    const low = await startOk(engine, 'user', { confirmLowQuota: true });
    expect(low.reports[0]?.text).toContain('剩 3%，低於門檻 20%');
    // Enough quota: nothing to confirm, nothing written down.
    world.quota.set('native:codex', { remainingPercent: 80, limitedUntil: null });
    expect((await startOk(engine, 'user', { confirmLowQuota: true })).reports).toEqual([]);
  });

  it('still refuses approving an LLM\'s proposal on a low quota', async () => {
    const engine = makeEngine();
    await letLlm(engine, 'ask');
    const proposed = await startOk(engine, 'llm');
    world.quota.set('native:codex', { remainingPercent: 0, limitedUntil: '2026-10-06T12:00:00.000Z' });
    expect(await engine.approve(proposed.id)).toMatchObject({ ok: false, code: 'quota_too_low' });
  });

  it('stays at work while the delegate\'s own continuity waits for the reset', async () => {
    const engine = makeEngine();
    world.quota.set('native:codex', { remainingPercent: 2, limitedUntil: null });
    const started = await startOk(engine, 'user', { confirmLowQuota: true });
    await toWorking(engine, started.id);
    // The delegate hit the limit and sits idle: continuity has a carry-on pending.
    world.children.set('child-1', childView({ profileId: 'native:codex', lastTurnAt: world.now.toISOString() }));
    world.busySessions.add('child-1');
    later(world, 3 * 60 * 60_000);
    await engine.advance();
    expect((await engine.get(started.id))?.state).toBe('working');
    world.busySessions.delete('child-1');
    await engine.advance();
    expect((await engine.get(started.id))).toMatchObject({ state: 'needs_attention', stateReason: 'idle' });
  });
});

describe('settings', () => {
  it('keeps global settings and a tmux\'s own, refusing a looser limit there', async () => {
    const engine = makeEngine();
    expect(await engine.getSettings()).toMatchObject({ preferences: { llmInitiated: 'ask', targets: [] }, limits: { maxConcurrent: 3 } });
    await engine.setSettings({ preferences: { targets: ['native:codex'] }, limits: { minRemainingPercent: 30 } });
    let view = await engine.setSessionSettings('p1', { preferences: { notify: 'all' }, limits: { maxConcurrent: 2, minRemainingPercent: 50 } });
    expect(view.ok && view.view).toEqual({
      effective: expect.objectContaining({ notify: 'all', targets: ['native:codex'] }),
      override: { preferences: { notify: 'all' }, limits: { maxConcurrent: 2, minRemainingPercent: 50 } },
      limits: { maxConcurrent: 2, maxDepth: 1, maxReviewRounds: 3, minRemainingPercent: 50 },
    });
    expect(await engine.setSessionSettings('p1', { limits: { minRemainingPercent: 10 } }))
      .toMatchObject({ ok: false, code: 'invalid_request', params: { field: 'minRemainingPercent' } });
    expect(await engine.setSessionSettings('p1', { limits: { maxDepth: 3 } })).toMatchObject({ ok: false, params: { field: 'maxDepth' } });
    view = await engine.setSessionSettings('p1', { preferences: { notify: null }, limits: { maxConcurrent: null, minRemainingPercent: null } });
    expect(view.ok && view.view.override).toEqual({ preferences: {}, limits: {} });
    expect(JSON.parse(await readFile(file, 'utf-8')).sessions).toEqual({});
    expect(await engine.getSessionSettings('nope')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('reads a file phase 1 wrote', async () => {
    await writeFile(file, JSON.stringify({
      version: 1, preferences: { isolation: 'shared' }, limits: {}, sessions: { p1: { preferences: { idleAttentionMinutes: 5 } } },
      delegations: { old: { id: 'old', state: 'delivered', outbox: [], reports: [], createdAt: '2026-10-06T09:00:00.000Z' } },
    }));
    const engine = makeEngine();
    expect(await engine.getSettings()).toMatchObject({ preferences: { isolation: 'shared', llmInitiated: 'ask', targets: [] }, limits: { maxDepth: 1 } });
    const own = await engine.getSessionSettings('p1');
    expect(own.ok && own.view.override).toEqual({ preferences: { idleAttentionMinutes: 5 }, limits: {} });
    expect(await engine.get('old')).toMatchObject({ approvedAt: null, outbox: [] });
  });
});

describe('what goes back to the delegating conversation', () => {
  // Without the LLM's review (parentReview off): the delegating conversation is told it was delivered.
  async function delivered(engine: DelegationEngine): Promise<string> {
    await engine.setSettings({ preferences: { parentReview: false } });
    const delegation = await startOk(engine, 'user');
    await toWorking(engine, delegation.id);
    world.children.set('p1', childView({ phase: 'replying' }));
    const result = await engine.deliver(delegation.id, { fromSessionId: 'child-1', report: '## Done\n- added --json' });
    expect(result.ok && result.delegation.outbox).toMatchObject([{ to: 'parent', event: 'delivered', text: '', attempts: 0, sentAt: null }]);
    return delegation.id;
  }

  it('is sent only once that CLI is idle and quiet, pointing at a report file, and checked', async () => {
    const engine = makeEngine();
    const id = await delivered(engine);
    await engine.advance();
    expect(sentToParent()).toEqual([]);
    // Just finished a turn: still left alone.
    world.children.set('p1', childView({ lastTurnAt: world.now.toISOString() }));
    await engine.advance();
    expect(sentToParent()).toEqual([]);
    // A handoff going on it.
    parentQuiet();
    world.busySessions.add('p1');
    await engine.advance();
    expect(sentToParent()).toEqual([]);
    world.busySessions.clear();
    await engine.advance();
    const reportFile = `/work/hestia/api/.hestia/delegations/${id}/report.md`;
    expect(sentToParent()).toEqual([DELEGATION_MESSAGES.parent('delivered', id, reportFile)]);
    expect(world.parentReports.get(reportFile)).toContain('## 交付報告');
    expect(world.parentReports.get(reportFile)).toContain('- added --json');
    expect((await engine.get(id))?.outbox[0]).toMatchObject({ attempts: 1, sentAt: world.now.toISOString() });
    later(world, 4_000);
    await engine.advance();
    expect((await engine.get(id))?.outbox).toEqual([]);
  });

  it('keeps waiting across a restart', async () => {
    const id = await delivered(makeEngine());
    const again = makeEngine();
    parentQuiet();
    await again.advance();
    expect(sentToParent()).toHaveLength(1);
    expect((await again.get(id))?.outbox).toHaveLength(1);
  });

  it('is dropped, and that written down, when the delegating session is gone', async () => {
    const engine = makeEngine();
    const id = await delivered(engine);
    world.children.delete('p1');
    await engine.advance();
    const after = await engine.get(id);
    expect(after?.outbox).toEqual([]);
    expect(after?.reports.at(-1)).toMatchObject({ kind: 'decision', by: 'system' });
    expect(after?.reports.at(-1)?.text).toContain('已不存在');
  });

  it('is typed in again once when it didn\'t arrive, then given up', async () => {
    const engine = makeEngine();
    const id = await delivered(engine);
    parentQuiet();
    world.delivery = 'partial';
    await engine.advance(); // sent
    later(world, 4_000);
    await engine.advance(); // cut short: again
    parentQuiet();
    await engine.advance(); // sent again
    later(world, 4_000);
    await engine.advance(); // still: given up
    expect(sentToParent()).toHaveLength(2);
    const after = await engine.get(id);
    expect(after?.outbox).toEqual([]);
    expect(after?.reports.at(-1)?.text).toContain('重送後仍沒有送進');
  });

  it('tells it the user\'s verdict, after it is over, one message at a time', async () => {
    const engine = makeEngine();
    const id = await delivered(engine);
    const accepted = await engine.accept(id);
    expect(accepted.ok && accepted.delegation.outbox.map((item) => item.event)).toEqual(['delivered', 'accepted']);
    parentQuiet();
    await engine.advance();
    expect(sentToParent()).toHaveLength(1);
    later(world, 4_000);
    await engine.advance(); // delivered checked
    parentQuiet();
    await engine.advance(); // accepted sent
    expect(sentToParent().at(-1)).toContain('已接受');
    later(world, 4_000);
    await engine.advance();
    expect((await engine.get(id))?.outbox).toEqual([]);
  });

  it('tells it when the delegate is blocked', async () => {
    const engine = makeEngine();
    const delegation = await startOk(engine, 'user');
    await toWorking(engine, delegation.id);
    await engine.deliver(delegation.id, { fromSessionId: 'child-1', report: 'Which flag name?', blocked: true });
    parentQuiet();
    await engine.advance();
    expect(sentToParent()).toHaveLength(1);
    expect(sentToParent()[0]).toContain('卡住');
    expect([...world.parentReports.values()][0]).toContain('Which flag name?');
  });
});

describe('the delegating LLM stopping its own', () => {
  it('only from the delegating session', async () => {
    const engine = makeEngine();
    const delegation = await startOk(engine, 'user');
    await toWorking(engine, delegation.id);
    expect(await engine.stopDelegation(delegation.id, { by: 'parent', sessionId: 'child-1' })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await engine.stopDelegation(delegation.id, { by: 'parent', sessionId: 'ghost' })).toMatchObject({ ok: false, code: 'not_in_managed_tmux' });
    const stopped = await engine.stopDelegation(delegation.id, { by: 'parent', sessionId: 'p1' });
    expect(stopped.ok && stopped.delegation).toMatchObject({ state: 'stopped', stateReason: 'parent' });
    expect(stopped.ok && stopped.delegation.reports.at(-1)).toMatchObject({ kind: 'decision', by: 'parent' });
  });
});

describe('notify and profile history', () => {
  it('pushes the start and the understanding only with notify all', async () => {
    const engine = makeEngine();
    const quietOne = await startOk(engine, 'user');
    await toWorking(engine, quietOne.id);
    world.firstReply = 'I will add the flag.';
    await engine.advance();
    expect(world.notices.map((n) => n.body).join('\n')).not.toContain('理解');
    await engine.setSettings({ preferences: { notify: 'all' } });
    const loud = await startOk(engine, 'user');
    await toWorking(engine, loud.id, 'child-2');
    await engine.advance();
    const bodies = world.notices.filter((n) => n.id === loud.id).map((n) => n.body);
    expect(bodies).toContain('被指派者已開始工作');
    expect(bodies.some((body) => body.startsWith('被指派者的理解：I will add the flag.'))).toBe(true);
  });

  it('writes down a profile continuity handed the delegate to', async () => {
    const engine = makeEngine();
    const delegation = await startOk(engine, 'user');
    await toWorking(engine, delegation.id);
    world.children.set('child-1', childView({ profileId: 'native:claude', phase: 'replying' }));
    later(world, 1_000);
    await engine.advance();
    expect((await engine.get(delegation.id))?.profileHistory.map((entry) => entry.profileId)).toEqual(['native:codex', 'native:claude']);
  });
});
