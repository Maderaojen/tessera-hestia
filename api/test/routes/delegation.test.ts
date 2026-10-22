import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as auth from '../../src/auth.js';
import { createDelegationEngine, decodeDelegationState, emptyDelegationState, type DelegationEngine } from '../../src/delegation/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { delegationSettingsRouter, delegationsRouter, sessionDelegationRouter } from '../../src/routes/delegation.js';
import { childView, fakePorts, firstTurnOver, later, newWorld, type World } from '../delegation/fake-ports.js';

// The delegation routes behind the same gate as server.ts's requireAuth
// (a login or the local tool token), with an engine of their own.

const TOOL_TOKEN = 'tool-token-for-tests';
let dir: string;
let world: World;
let engine: DelegationEngine;
let app: express.Express;
let login: string;

function gate(req: Request, res: Response, next: NextFunction): void {
  if (auth.accountForRequest(req)) next();
  else res.status(401).json({ code: 'not_authenticated' });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'delegation-route-'));
  world = newWorld();
  engine = createDelegationEngine(fakePorts(world), jsonFileStore({ path: path.join(dir, 'd.json'), empty: emptyDelegationState, decode: decodeDelegationState }));
  app = express().use(express.json()).use(gate)
    .use('/delegations', delegationsRouter(engine))
    .use('/delegation', delegationSettingsRouter(engine))
    .use('/sessions', sessionDelegationRouter(engine));
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  login = `Bearer ${auth.issueSessionToken({ username: 'alice', localOnly: false })}`;
});

afterEach(async () => {
  auth.__setLocalToolTokenForTests(null);
  await rm(dir, { recursive: true, force: true });
});

const body = { parentSessionId: 'p1', task: 'Add a --json flag', profileId: 'native:codex' };
const asTool = (req: request.Test) => req.set('X-Hestia-Token', TOOL_TOKEN);
const asUser = (req: request.Test) => req.set('Authorization', login);

// At work, with the LLM's review off unless `review` (delivered goes straight to the user).
async function delegationAtWork(review = false): Promise<string> {
  // The delegating LLM's review is off by default; on only when asked for.
  await engine.setSettings({ preferences: { parentReview: review } });
  const res = await asUser(request(app).post('/delegations')).send(body);
  const id = res.body.delegation.id as string;
  for (let i = 0; i < 3; i++) await engine.advance();
  world.children.set('child-1', childView());
  await engine.advance();
  later(world, 5_000);
  await engine.advance();
  later(world, 4_000);
  await engine.advance();
  firstTurnOver(world);
  await engine.advance();
  return id;
}

describe('/delegations', () => {
  it('takes a permission mode only with the user\'s login (ADR 0027)', async () => {
    await engine.setSettings({ preferences: { targets: ['native:codex'], llmInitiated: 'allow' } });
    let res = await asTool(request(app).post('/delegations')).send({ ...body, permissionMode: 'yolo' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    res = await asTool(request(app).post('/delegations')).send({ ...body, permissionMode: 'cli_default' });
    expect(res.status).toBe(403);
    res = await asUser(request(app).post('/delegations')).send({ ...body, permissionMode: 'yolo' });
    expect(res.status).toBe(201);
    expect(res.body.delegation.permissionMode).toBe('yolo');
    res = await asUser(request(app).post('/delegations')).send({ ...body, permissionMode: 'everything' });
    expect(res.status).toBe(400);
  });

  it('caps an LLM\'s own delegation below yolo, whatever the delegating tmux is set to', async () => {
    await engine.setSettings({ preferences: { targets: ['native:codex'], llmInitiated: 'allow' } });
    world.permissionSetting = 'yolo';
    let res = await asTool(request(app).post('/delegations')).send({ parentSessionId: 'p1', task: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.delegation.permissionMode).toBe('auto');
    // A runtime without auto falls back to cli_default.
    world.permissionSupported = ['cli_default', 'yolo'];
    res = await asTool(request(app).post('/delegations')).send({ parentSessionId: 'p1', task: 'y' });
    expect(res.body.delegation.permissionMode).toBe('cli_default');
    // The user's own delegation follows the setting.
    world.permissionSupported = ['cli_default', 'auto', 'yolo'];
    res = await asUser(request(app).post('/delegations')).send(body);
    expect(res.body.delegation.permissionMode).toBe('yolo');
  });

  it('starts one with the user\'s login', async () => {
    const res = await asUser(request(app).post('/delegations')).send(body);
    expect(res.status).toBe(201);
    expect(res.body.delegation).toMatchObject({ state: 'starting', initiator: 'user', profileId: 'native:codex' });
  });

  it('starts one as the LLM with the local tool token, checked against the settings', async () => {
    let res = await asTool(request(app).post('/delegations')).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('profile_not_allowed');
    await engine.setSettings({ preferences: { targets: ['native:codex'] } });
    res = await asTool(request(app).post('/delegations')).send({ parentSessionId: 'p1', task: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.delegation).toMatchObject({ initiator: 'llm', state: 'proposed', profileId: 'native:codex' });
  });

  it('asks the user to confirm a low quota, and starts once confirmed', async () => {
    world.quota.set('native:codex', { remainingPercent: 5, limitedUntil: null });
    let res = await asUser(request(app).post('/delegations')).send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'quota_low_confirm', params: { remaining: '5', min: '20' } });
    res = await asUser(request(app).post('/delegations')).send({ ...body, confirmLowQuota: true });
    expect(res.status).toBe(201);
    expect(res.body.delegation.reports[0]).toMatchObject({ kind: 'decision', by: 'user' });
    // The tool token is the LLM: refused, confirmed or not.
    await engine.setSettings({ preferences: { targets: ['native:codex'], llmInitiated: 'allow' } });
    res = await asTool(request(app).post('/delegations')).send({ ...body, confirmLowQuota: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('quota_too_low');
  });

  it.each([
    [{ ...body, task: '   ' }],
    [{ ...body, isolation: 'nowhere' }],
    [{ ...body, extra: 1 }],
    [{ task: 'x', profileId: 'native:codex' }],
  ])('rejects %j', async (bad) => {
    const res = await asUser(request(app).post('/delegations')).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('lists and reads with either token', async () => {
    const id = (await asUser(request(app).post('/delegations')).send(body)).body.delegation.id;
    const list = await asTool(request(app).get('/delegations?session=p1'));
    expect(list.status).toBe(200);
    expect(list.body.delegations.map((d: { id: string }) => d.id)).toEqual([id]);
    expect((await asUser(request(app).get('/delegations?session=other'))).body.delegations).toEqual([]);
    expect((await asTool(request(app).get(`/delegations/${id}`))).body.delegation.id).toBe(id);
    expect((await asUser(request(app).get('/delegations/nope'))).status).toBe(404);
  });

  it('reads, with one, the branch its delivery has been merged into', async () => {
    const id = await delegationAtWork();
    world.mergedInto = 'main';
    expect((await asUser(request(app).get(`/delegations/${id}`))).body.deliveryMergedInto).toBeNull();
    await asTool(request(app).post(`/delegations/${id}/deliver`)).send({ fromSessionId: 'child-1', report: '## Done' });
    const res = await asUser(request(app).get(`/delegations/${id}`));
    expect(res.body.delegation.workspace.headAtDelivery).toBe('f00dfeed');
    expect(res.body.deliveryMergedInto).toBe('main');
  });

  it('takes a delivery from the delegate with the tool token', async () => {
    const id = await delegationAtWork();
    const res = await asTool(request(app).post(`/delegations/${id}/deliver`)).send({ fromSessionId: 'child-1', report: '## Done' });
    expect(res.status).toBe(200);
    expect(res.body.delegation.state).toBe('delivered');
  });

  it('answers workspace_dirty for uncommitted work', async () => {
    const id = await delegationAtWork();
    world.clean = false;
    const res = await asTool(request(app).post(`/delegations/${id}/deliver`)).send({ fromSessionId: 'child-1', report: '## Done' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_dirty');
  });

  it.each(['accept', 'reject'])('refuses the tool token for %s', async (action) => {
    const id = await delegationAtWork();
    await asTool(request(app).post(`/delegations/${id}/deliver`)).send({ fromSessionId: 'child-1', report: 'done' });
    const res = await asTool(request(app).post(`/delegations/${id}/${action}`));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    expect((await engine.get(id))?.state).toBe('delivered');
  });

  it('accepts with the login, and says when the state does not allow it', async () => {
    const id = await delegationAtWork();
    let res = await asUser(request(app).post(`/delegations/${id}/accept`));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'delegation_state', params: { state: 'working' } });
    await asTool(request(app).post(`/delegations/${id}/deliver`)).send({ fromSessionId: 'child-1', report: 'done' });
    res = await asUser(request(app).post(`/delegations/${id}/accept`));
    expect(res.status).toBe(200);
    expect(res.body.delegation.state).toBe('accepted');
  });

  it('starts one again with the login once its CLI quit (ADR 0030)', async () => {
    const id = await delegationAtWork();
    expect((await asTool(request(app).post(`/delegations/${id}/relaunch`))).status).toBe(403);
    expect((await asUser(request(app).post(`/delegations/${id}/relaunch`))).body.code).toBe('cli_already_running');
    world.children.set('child-1', childView({ running: false, provider: null, phase: null }));
    const res = await asUser(request(app).post(`/delegations/${id}/relaunch`));
    expect(res.status).toBe(200);
    expect(res.body.delegation).toMatchObject({ state: 'starting', startup: { stage: 'workspace' } });
  });

  it('stops with the login', async () => {
    const id = await delegationAtWork();
    const res = await asUser(request(app).post(`/delegations/${id}/stop`));
    expect(res.body.delegation).toMatchObject({ state: 'stopped', stateReason: 'user' });
  });
});

describe('reviewing', () => {
  async function reviewing(): Promise<string> {
    const id = await delegationAtWork(true);
    world.children.set('p1', childView({ phase: 'replying' }));
    const res = await asTool(request(app).post(`/delegations/${id}/deliver`)).send({ fromSessionId: 'child-1', report: 'done' });
    expect(res.body.delegation.state).toBe('reviewing');
    return id;
  }

  it('takes the delegating LLM\'s review from its session with the tool token', async () => {
    const id = await reviewing();
    let res = await asTool(request(app).post(`/delegations/${id}/review`)).send({ verdict: 'pass' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    res = await asTool(request(app).post(`/delegations/${id}/review`)).send({ fromSessionId: 'p1', verdict: 'send_back', feedback: 'Add a test.' });
    expect(res.status).toBe(200);
    expect(res.body.delegation).toMatchObject({ state: 'working', round: 2 });
  });

  it('passes it on with the tool token', async () => {
    const id = await reviewing();
    const res = await asTool(request(app).post(`/delegations/${id}/review`)).send({ fromSessionId: 'p1', verdict: 'pass' });
    expect(res.body.delegation).toMatchObject({ state: 'delivered', stateReason: 'passed' });
  });

  it('lets the user\'s login only send it back', async () => {
    const id = await reviewing();
    let res = await asUser(request(app).post(`/delegations/${id}/review`)).send({ verdict: 'pass' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    res = await asUser(request(app).post(`/delegations/${id}/review`)).send({ verdict: 'send_back', feedback: 'Rename it.' });
    expect(res.status).toBe(200);
    expect(res.body.delegation.reports.at(-1)).toMatchObject({ kind: 'review', by: 'user', verdict: 'send_back', text: 'Rename it.' });
  });

  it.each([[{ verdict: 'maybe' }], [{ verdict: 'pass', extra: 1 }], [{}]])('rejects %j', async (bad) => {
    const id = await reviewing();
    const res = await asUser(request(app).post(`/delegations/${id}/review`)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('cleaning up', () => {
  it('only with the login, once it is over', async () => {
    const id = await delegationAtWork();
    let res = await asUser(request(app).post(`/delegations/${id}/cleanup`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('delegation_state');
    await asUser(request(app).post(`/delegations/${id}/stop`));
    res = await asTool(request(app).post(`/delegations/${id}/cleanup`)).send({ deleteBranch: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    expect(world.removals).toEqual([]);
    res = await asUser(request(app).post(`/delegations/${id}/cleanup`)).send({ deleteBranch: true });
    expect(res.status).toBe(200);
    expect(res.body.delegation.workspace).toMatchObject({ removedAt: expect.any(String), branchDeletedAt: expect.any(String) });
  });

  it('says why it kept the worktree or branch', async () => {
    const id = await delegationAtWork();
    await asUser(request(app).post(`/delegations/${id}/stop`));
    world.removeOutcome = { ok: false, code: 'branch_not_merged', message: 'not merged' };
    const res = await asUser(request(app).post(`/delegations/${id}/cleanup`)).send({ deleteBranch: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('branch_not_merged');
    expect((await asUser(request(app).post(`/delegations/${id}/cleanup`)).send({ deleteBranch: 'yes' })).status).toBe(400);
    world.removeOutcome = null;
    world.closeOutcome = { ok: false, reason: 'cli_busy' };
    const busy = await asUser(request(app).post(`/delegations/${id}/cleanup`)).send({});
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: 'delegate_still_running', params: { reason: 'cli_busy' } });
  });
});

describe('proposals', () => {
  async function proposal(): Promise<string> {
    await engine.setSettings({ preferences: { targets: ['native:codex'] } });
    return (await asTool(request(app).post('/delegations')).send({ parentSessionId: 'p1', task: 'x' })).body.delegation.id;
  }

  it.each(['approve', 'decline'])('refuses the tool token for %s', async (action) => {
    const id = await proposal();
    const res = await asTool(request(app).post(`/delegations/${id}/${action}`));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    expect((await engine.get(id))?.state).toBe('proposed');
  });

  it('approves and declines with the login', async () => {
    const id = await proposal();
    expect((await asUser(request(app).post(`/delegations/${id}/approve`))).body.delegation).toMatchObject({ state: 'starting' });
    const other = (await asTool(request(app).post('/delegations')).send({ parentSessionId: 'p1', task: 'y' })).body.delegation.id;
    expect((await asUser(request(app).post(`/delegations/${other}/decline`))).body.delegation).toMatchObject({ state: 'stopped', stateReason: 'declined' });
  });
});

describe('stopping with the tool token', () => {
  it('works only from the delegating session', async () => {
    const id = await delegationAtWork();
    let res = await asTool(request(app).post(`/delegations/${id}/stop`));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    res = await asTool(request(app).post(`/delegations/${id}/stop`)).send({ fromSessionId: 'child-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect((await engine.get(id))?.state).toBe('working');
    res = await asTool(request(app).post(`/delegations/${id}/stop`)).send({ fromSessionId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body.delegation).toMatchObject({ state: 'stopped', stateReason: 'parent' });
  });
});

describe('/delegation settings', () => {
  it('reads with either token, changes only with the login', async () => {
    expect((await asTool(request(app).get('/delegation'))).body).toMatchObject({ preferences: { llmInitiated: 'ask' }, limits: { maxConcurrent: 3 } });
    let res = await asTool(request(app).put('/delegation')).send({ preferences: { llmInitiated: 'allow' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
    res = await asUser(request(app).put('/delegation')).send({ preferences: { llmInitiated: 'allow', targets: ['native:codex'] }, limits: { maxConcurrent: 5 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ preferences: { llmInitiated: 'allow', targets: ['native:codex'] }, limits: { maxConcurrent: 5 } });
  });

  it.each([
    [{ preferences: { llmInitiated: 'always' } }],
    [{ limits: { maxConcurrent: -1 } }],
    [{ preferences: { targets: null } }],
    [{ other: 1 }],
  ])('rejects %j', async (bad) => {
    const res = await asUser(request(app).put('/delegation')).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('keeps a tmux\'s own: either token reads, only the login writes, limits only stricter, null reverts', async () => {
    let res = await asTool(request(app).get('/sessions/p1/delegation'));
    expect(res.body).toMatchObject({ override: { preferences: {}, limits: {} }, limits: { maxConcurrent: 3 } });
    res = await asTool(request(app).put('/sessions/p1/delegation')).send({ preferences: { llmInitiated: 'allow' } });
    expect(res.status).toBe(403);
    res = await asUser(request(app).put('/sessions/p1/delegation')).send({ preferences: { llmInitiated: 'allow' }, limits: { maxConcurrent: 1 } });
    expect(res.body).toMatchObject({ effective: { llmInitiated: 'allow' }, override: { limits: { maxConcurrent: 1 } }, limits: { maxConcurrent: 1 } });
    res = await asUser(request(app).put('/sessions/p1/delegation')).send({ limits: { maxConcurrent: 9 } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_request', params: { field: 'maxConcurrent' } });
    res = await asUser(request(app).put('/sessions/p1/delegation')).send({ preferences: { llmInitiated: null }, limits: { maxConcurrent: null } });
    expect(res.body.override).toEqual({ preferences: {}, limits: {} });
    expect((await asUser(request(app).get('/sessions/nope/delegation'))).status).toBe(404);
  });
});
