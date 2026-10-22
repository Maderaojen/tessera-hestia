import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DELEGATION_MESSAGES, delegationMessageKind } from '../../src/contract/delegation.js';
import { createDelegationEngine, decodeDelegationState, emptyDelegationState, type DelegationEngine } from '../../src/delegation/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { childView, fakePorts, firstTurnOver, later, newWorld, type World } from './fake-ports.js';

// Phase 3 (ADR 0015 決策 5, 13): the delegating LLM reviews a delivery
// first and passes it on or sends it back, the user sends it back too, and
// a delegation that is over has its worktree cleaned up.

let dir: string;
let file: string;
let world: World;

// The review by the delegating LLM is off by default (every automatic step
// waits for the user to turn it on); these tests are about it, so it's on.
function reviewOn() {
  const state = emptyDelegationState();
  state.preferences.parentReview = true;
  return state;
}

function makeEngine(): DelegationEngine {
  return createDelegationEngine(fakePorts(world), jsonFileStore({ path: file, empty: reviewOn, decode: decodeDelegationState }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-p3-'));
  file = path.join(dir, 'delegation.json');
  world = newWorld();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const task = { parentSessionId: 'p1', task: 'Add a --json flag to `hestia status`.', profileId: 'native:codex' };
const parent = { by: 'parent' as const, sessionId: 'p1' };
const user = { by: 'user' as const };

async function working(engine: DelegationEngine): Promise<string> {
  const result = await engine.startDelegation(task, 'user');
  if (!result.ok) throw new Error(result.code);
  const id = result.delegation.id;
  await engine.advance(); // workspace
  await engine.advance(); // session
  await engine.advance(); // launch
  world.children.set('child-1', childView({ profileId: 'native:codex' }));
  await engine.advance(); // briefing
  later(world, 5_000);
  await engine.advance(); // sent
  later(world, 4_000);
  await engine.advance(); // read back
  firstTurnOver(world);
  await engine.advance(); // its first turn is through
  expect((await engine.get(id))?.state).toBe('working');
  return id;
}

// Delivered by the delegate, now waiting on the delegating LLM.
async function reviewing(engine: DelegationEngine): Promise<string> {
  const id = await working(engine);
  // The delegating CLI is busy, so nothing is typed into it yet.
  world.children.set('p1', childView({ phase: 'replying' }));
  const result = await engine.deliver(id, { fromSessionId: 'child-1', report: '## Done\n- added --json' });
  expect(result).toMatchObject({ ok: true, delegation: { state: 'reviewing', outbox: [{ to: 'parent', event: 'review' }] } });
  return id;
}

// A CLI quiet long enough to be told something.
function quiet(sessionId: string): void {
  later(world, 60_000);
  world.children.set(sessionId, childView({ profileId: 'native:codex', lastTurnAt: new Date(world.now.getTime() - 60_000).toISOString() }));
}

const sentTo = (sessionId: string) => world.sent.filter((s) => s.sessionId === sessionId).map((s) => s.text);
// What the delegate was told after its brief.
const feedbackSent = () => sentTo('child-1').filter((text) => delegationMessageKind(text) === 'feedback');

describe('the delegating LLM reviewing a delivery', () => {
  it('goes to it first, asking it to review with the review command', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    // Not pushed to the user with notify 'key': it isn't theirs yet.
    expect(world.notices.filter((n) => n.body.includes('驗收'))).toEqual([]);
    quiet('p1');
    await engine.advance();
    const reportFile = `/work/hestia/api/.hestia/delegations/${id}/report.md`;
    expect(sentTo('p1')).toEqual([DELEGATION_MESSAGES.parent('review', id, reportFile)]);
    const report = world.parentReports.get(reportFile)!;
    expect(report).toContain('## 請你審查');
    expect(report).toContain(`hestia delegate review ${id} --pass`);
    expect(report).toContain(`hestia delegate review ${id} --send-back --feedback-file`);
    expect(report).toContain('- added --json');
  });

  it('passes it on to the user', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    const result = await engine.review(id, { verdict: 'pass', feedback: 'Tests pass.' }, parent);
    expect(result).toMatchObject({ ok: true, delegation: { state: 'delivered', stateReason: 'passed' } });
    if (!result.ok) return;
    expect(result.delegation.reports.at(-1)).toMatchObject({ kind: 'review', by: 'parent', verdict: 'pass', text: 'Tests pass.' });
    // The request to review, never typed in, is moot.
    expect(result.delegation.outbox).toEqual([]);
    expect(world.notices.at(-1)).toEqual({ id, body: 'LLM 審過，待你驗收' });
    // Then only the user's verdict.
    expect(await engine.review(id, { verdict: 'pass' }, parent)).toMatchObject({ ok: false, code: 'delegation_state' });
    expect(await engine.accept(id)).toMatchObject({ ok: true, delegation: { state: 'accepted' } });
  });

  it('sends it back with feedback, which reaches the delegate once it is idle', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    const result = await engine.review(id, { verdict: 'send_back', feedback: 'The flag is missing from --help.\nAdd a test.' }, parent);
    expect(result).toMatchObject({ ok: true, delegation: { state: 'working', round: 2, outbox: [{ to: 'child', event: 'feedback', round: 2 }] } });
    // Only with notify 'all'.
    expect(world.notices.some((n) => n.body.includes('退回'))).toBe(false);
    world.children.set('child-1', childView({ phase: 'replying' }));
    await engine.advance();
    expect(feedbackSent()).toEqual([]);
    quiet('child-1');
    await engine.advance();
    const feedbackFile = `/work/hestia-delegate-ab12cd34/api/.hestia/delegations/${id}/feedback-2.md`;
    expect(feedbackSent()).toEqual([DELEGATION_MESSAGES.feedback(id, 2, feedbackFile)]);
    const feedback = world.feedback.get(feedbackFile)!;
    expect(feedback).toContain('交付被退回（第 2 輪）');
    expect(feedback).toContain('發起的 LLM');
    expect(feedback).toContain('The flag is missing from --help.');
    expect(feedback).toContain('hestia delegate done --report-file /work/hestia-delegate-ab12cd34/api/.hestia/delegations/ab12cd34/report.md');
    // Read back, then gone from the outbox.
    later(world, 4_000);
    await engine.advance();
    expect((await engine.get(id))?.outbox).toEqual([]);
    // Delivered again: back to the LLM.
    expect(await engine.deliver(id, { fromSessionId: 'child-1', report: 'fixed' })).toMatchObject({ ok: true, delegation: { state: 'reviewing', round: 2 } });
  });

  it('pushes each send-back with notify \'all\'', async () => {
    const engine = makeEngine();
    await engine.setSettings({ preferences: { notify: 'all' } });
    const id = await reviewing(engine);
    await engine.review(id, { verdict: 'send_back', feedback: 'Add a test.' }, parent);
    expect(world.notices.at(-1)).toEqual({ id, body: '發起的 LLM 退回了（第 2 輪）：Add a test.' });
  });

  it('counts only the LLM\'s send-backs against maxReviewRounds, then goes to the user', async () => {
    const engine = makeEngine();
    await engine.setSettings({ limits: { maxReviewRounds: 1 } });
    const id = await reviewing(engine);
    await engine.review(id, { verdict: 'send_back', feedback: 'Again.' }, parent);
    // Used up: delivered straight to the user, saying why.
    const again = await engine.deliver(id, { fromSessionId: 'child-1', report: 'fixed' });
    expect(again).toMatchObject({ ok: true, delegation: { state: 'delivered', stateReason: 'review_rounds' } });
    expect(world.notices.at(-1)?.body).toBe('已交付，LLM 退回的次數已用完，等你驗收');
    // The user's own send-back doesn't count, and isn't limited.
    await engine.review(id, { verdict: 'send_back', feedback: 'One more thing.' }, user);
    expect((await engine.get(id))).toMatchObject({ state: 'working', round: 3 });
    expect(await engine.deliver(id, { fromSessionId: 'child-1', report: 'done' })).toMatchObject({ ok: true, delegation: { state: 'delivered', stateReason: 'review_rounds' } });
  });

  it('goes to the user when the limit was lowered while it reviewed', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    await engine.setSettings({ limits: { maxReviewRounds: 0 } });
    const result = await engine.review(id, { verdict: 'send_back', feedback: 'Again.' }, parent);
    expect(result).toMatchObject({ ok: true, delegation: { state: 'delivered', stateReason: 'review_rounds', round: 1 } });
    expect(result.ok && result.delegation.reports.slice(-2).map((r) => r.kind)).toEqual(['review', 'decision']);
  });

  it('skips the review with parentReview off, or with no send-backs allowed', async () => {
    const engine = makeEngine();
    await engine.setSettings({ limits: { maxReviewRounds: 0 } });
    const id = await working(engine);
    expect(await engine.deliver(id, { fromSessionId: 'child-1', report: 'done' })).toMatchObject({ ok: true, delegation: { state: 'delivered', stateReason: 'review_rounds' } });
  });

  it('takes a review only from the delegating session, with feedback to send back', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    world.children.set('other', childView());
    expect(await engine.review(id, { verdict: 'pass' }, { by: 'parent', sessionId: 'other' })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await engine.review(id, { verdict: 'pass' }, { by: 'parent', sessionId: 'nowhere' })).toMatchObject({ ok: false, code: 'not_in_managed_tmux' });
    expect(await engine.review(id, { verdict: 'send_back', feedback: '  ' }, parent)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await engine.get(id))?.state).toBe('reviewing');
  });

  it('goes to the user once the delegating session is gone, or has moved on to other work', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    world.movedOn.add('p1');
    await engine.advance();
    const switched = await engine.get(id);
    expect(switched).toMatchObject({ state: 'delivered', stateReason: 'parent_switched', outbox: [] });
    expect(world.notices.at(-1)?.body).toContain('等你驗收');

    world.ids.push('cd34ef56');
    world.sessionIds.push('child-2');
    world.movedOn.clear();
    const second = await engine.startDelegation(task, 'user');
    if (!second.ok) throw new Error(second.code);
    for (let i = 0; i < 3; i++) await engine.advance();
    world.children.set('child-2', childView({ profileId: 'native:codex' }));
    await engine.advance();
    later(world, 5_000);
    await engine.advance();
    later(world, 4_000);
    await engine.advance();
    firstTurnOver(world, 'child-2');
    await engine.advance();
    world.children.set('p1', childView({ phase: 'replying' }));
    await engine.deliver(second.delegation.id, { fromSessionId: 'child-2', report: 'done' });
    world.children.delete('p1');
    world.parents.delete('p1');
    await engine.advance();
    expect(await engine.get(second.delegation.id)).toMatchObject({ state: 'delivered', stateReason: 'parent_gone' });
  });

  it('tells the user once when the delegating conversation waits for its usage limit to reset', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    await engine.advance();
    expect(world.notices.some((n) => n.body.includes('額度上限'))).toBe(false);
    world.limitWaits.set('p1', '2026-10-06T13:30:00.000Z');
    await engine.advance();
    await engine.advance();
    const held = world.notices.filter((n) => n.body.includes('額度上限'));
    expect(held).toHaveLength(1);
    expect(held[0]!.body).toMatch(/^發起的對話已達額度上限，要等 .+ 重置後才會審；你也可以直接驗收或退回$/);
    expect(await engine.get(id)).toMatchObject({ state: 'reviewing' });
    // Sent back and delivered again: a new review, told again.
    await engine.review(id, { verdict: 'send_back', feedback: 'More.' }, user);
    later(world, 1_000);
    await engine.deliver(id, { fromSessionId: 'child-1', report: 'again' });
    later(world, 1_000);
    await engine.advance();
    expect(world.notices.filter((n) => n.body.includes('額度上限'))).toHaveLength(2);
  });

  it('is accepted or rejected while it reviews, dropping the request to review', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    expect(await engine.accept(id)).toMatchObject({ ok: true, delegation: { state: 'accepted', outbox: [{ to: 'parent', event: 'accepted' }] } });
  });
});

describe('the user sending it back', () => {
  it('from delivered or reviewing, with feedback, any number of times', async () => {
    const engine = makeEngine();
    await engine.setSettings({ preferences: { parentReview: false }, limits: { maxReviewRounds: 0 } });
    const id = await working(engine);
    for (const round of [2, 3, 4]) {
      await engine.deliver(id, { fromSessionId: 'child-1', report: 'done' });
      const result = await engine.review(id, { verdict: 'send_back', feedback: `Round ${round}: more.` }, user);
      expect(result).toMatchObject({ ok: true, delegation: { state: 'working', round } });
      expect(result.ok && result.delegation.reports.at(-1)).toMatchObject({ kind: 'review', by: 'user', verdict: 'send_back' });
    }
    // Feedback to the delegate says it was the user.
    quiet('child-1');
    await engine.advance();
    expect([...world.feedback.values()][0]).toContain('使用者看過你上一次的交付');
  });

  it('only sends back, only with feedback, and only what was delivered', async () => {
    const engine = makeEngine();
    const id = await working(engine);
    expect(await engine.review(id, { verdict: 'send_back', feedback: 'x' }, user)).toMatchObject({ ok: false, code: 'delegation_state' });
    await engine.deliver(id, { fromSessionId: 'child-1', report: 'done' });
    expect(await engine.review(id, { verdict: 'pass' }, user)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await engine.review(id, { verdict: 'send_back' }, user)).toMatchObject({ ok: false, code: 'invalid_request' });
    // From reviewing: the request to the LLM, not typed in yet, is dropped.
    const result = await engine.review(id, { verdict: 'send_back', feedback: 'More.' }, user);
    expect(result.ok && result.delegation.outbox).toEqual([expect.objectContaining({ to: 'child', event: 'feedback' })]);
  });

  it('never tells a delegate that has been stopped', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    await engine.review(id, { verdict: 'send_back', feedback: 'More.' }, user);
    await engine.stopDelegation(id);
    quiet('child-1');
    await engine.advance();
    expect(feedbackSent()).toEqual([]);
    const after = await engine.get(id);
    expect(after?.outbox).toEqual([]);
    expect(after?.reports.at(-1)?.text).toContain('指派已經結束');
  });
});

describe('cleaning up the worktree', () => {
  async function over(engine: DelegationEngine): Promise<string> {
    const id = await reviewing(engine);
    await engine.accept(id);
    return id;
  }

  it('only once it is over', async () => {
    const engine = makeEngine();
    const id = await reviewing(engine);
    expect(await engine.cleanup(id, {})).toMatchObject({ ok: false, code: 'delegation_state' });
    expect(world.removals).toEqual([]);
  });

  it('closes the delegate\'s tmux first, and keeps everything when its CLI won\'t exit', async () => {
    const engine = makeEngine();
    const id = await over(engine);
    world.closeOutcome = { ok: false, reason: 'exit_unverified' };
    expect(await engine.cleanup(id, {})).toMatchObject({ ok: false, status: 409, code: 'delegate_still_running', params: { reason: 'exit_unverified' } });
    expect(world.removals).toEqual([]);
    world.closeOutcome = { ok: true, closed: true };
    const removed = await engine.cleanup(id, {});
    expect(world.closed).toEqual(['child-1']);
    expect(removed.ok && removed.delegation.reports.at(-1)?.text).toBe('使用者關閉了被指派的 tmux，移除了 worktree `/work/hestia-delegate-ab12cd34`。');
  });

  it('refuses uncommitted work before closing the tmux', async () => {
    const engine = makeEngine();
    const id = await over(engine);
    world.removeOutcome = { ok: false, code: 'workspace_dirty', message: 'uncommitted' };
    expect(await engine.cleanup(id, {})).toMatchObject({ ok: false, code: 'workspace_dirty' });
    expect(world.closed).toEqual([]);
  });

  it('removes the worktree, keeping the branch, then deletes the branch when asked', async () => {
    const engine = makeEngine();
    const id = await over(engine);
    world.closeOutcome = { ok: true, closed: false };
    const removed = await engine.cleanup(id, {});
    expect(removed).toMatchObject({ ok: true, delegation: { workspace: { removedAt: world.now.toISOString() } } });
    expect(removed.ok && removed.delegation.workspace.branchDeletedAt).toBeUndefined();
    expect(world.removals).toEqual([{ worktree: '/work/hestia-delegate-ab12cd34', deleteBranch: false }]);
    expect(removed.ok && removed.delegation.reports.at(-1)?.text).toContain('移除了 worktree');
    // Again, without the branch: nothing left to do.
    expect(await engine.cleanup(id, {})).toMatchObject({ ok: false, code: 'invalid_request' });
    const branch = await engine.cleanup(id, { deleteBranch: true });
    // The worktree went already: nothing more to close.
    expect(world.closed).toEqual([]);
    expect(branch).toMatchObject({ ok: true, delegation: { workspace: { branchDeletedAt: world.now.toISOString() } } });
    expect(branch.ok && branch.delegation.reports.at(-1)?.text).toContain('刪除了已合併的 branch');
  });

  it('says why it refused, changing nothing', async () => {
    const engine = makeEngine();
    const id = await over(engine);
    world.removeOutcome = { ok: false, code: 'workspace_dirty', message: 'uncommitted' };
    expect(await engine.cleanup(id, {})).toMatchObject({ ok: false, status: 409, code: 'workspace_dirty' });
    world.removeOutcome = { ok: false, code: 'branch_not_merged', message: 'not merged' };
    expect(await engine.cleanup(id, { deleteBranch: true })).toMatchObject({ ok: false, status: 409, code: 'branch_not_merged' });
    expect((await engine.get(id))?.workspace.removedAt).toBeUndefined();
  });

  it('has nothing to remove in a shared folder', async () => {
    const engine = makeEngine();
    world.repo = false;
    const result = await engine.startDelegation(task, 'user');
    if (!result.ok) throw new Error(result.code);
    await engine.stopDelegation(result.delegation.id);
    expect(await engine.cleanup(result.delegation.id, {})).toMatchObject({ ok: false, code: 'invalid_request' });
  });
});
