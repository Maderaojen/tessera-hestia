import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as auth from '../../src/auth.js';
import { API_CAPABILITIES } from '../../src/contract/index.js';
import { createForkEngine, decodeForkState, emptyForkState, type ForkEngine } from '../../src/fork/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { forksRouter } from '../../src/routes/forks.js';
import { fakePorts, newWorld, type World } from '../fork/fake-ports.js';

// The fork routes behind the same gate as server.ts's requireAuth (a login
// or the local tool token), with an engine of their own.

const TOOL_TOKEN = 'tool-token-for-tests';
let dir: string;
let world: World;
let engine: ForkEngine;
let app: express.Express;
let login: string;

function gate(req: Request, res: Response, next: NextFunction): void {
  if (auth.accountForRequest(req)) next();
  else res.status(401).json({ code: 'not_authenticated' });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fork-route-'));
  world = newWorld();
  engine = createForkEngine(fakePorts(world), jsonFileStore({ path: path.join(dir, 'f.json'), empty: emptyForkState, decode: decodeForkState }));
  app = express().use(express.json()).use(gate).use('/forks', forksRouter(engine));
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  login = `Bearer ${auth.issueSessionToken({ username: 'alice', localOnly: false })}`;
});

afterEach(async () => {
  auth.__setLocalToolTokenForTests(null);
  await rm(dir, { recursive: true, force: true });
});

const asTool = (req: request.Test) => req.set('X-Hestia-Token', TOOL_TOKEN);
const asUser = (req: request.Test) => req.set('Authorization', login);

describe('/forks', () => {
  it('is a capability', () => {
    expect(API_CAPABILITIES).toContain('fork');
  });

  it('opens one only with the user\'s login', async () => {
    const refused = await asTool(request(app).post('/forks')).send({ parentSessionId: 'main' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('login_required');
    expect(await engine.list({})).toEqual([]);
    const opened = await asUser(request(app).post('/forks')).send({ parentSessionId: 'main', instruction: 'Try two columns' });
    expect(opened.status).toBe(201);
    expect(opened.body.fork).toMatchObject({ id: 'f1f1f1f1', childSessionId: 'branch-1', memory: 'native', instruction: 'Try two columns' });
  });

  it('lets either token read the list, one, and the preview', async () => {
    const opened = await asUser(request(app).post('/forks')).send({ parentSessionId: 'main' });
    const id = opened.body.fork.id as string;
    const list = await asTool(request(app).get('/forks?session=branch-1&open=1'));
    expect(list.status).toBe(200);
    expect(list.body.forks.map((fork: { id: string }) => fork.id)).toEqual([id]);
    expect((await asTool(request(app).get(`/forks/${id}`))).body.fork.id).toBe(id);
    const preview = await asTool(request(app).get('/forks/preview?parentSessionId=main&profileId=native:codex'));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ memory: 'brief', memoryReason: 'other_profile', turnsAtFork: 12, parentDirtyFiles: ['web/src/App.vue'] });
    expect((await asTool(request(app).get('/forks/nope'))).status).toBe(404);
  });

  it('starts one again only with the user\'s login, and 409s one whose CLI still runs (ADR 0030)', async () => {
    const opened = await asUser(request(app).post('/forks')).send({ parentSessionId: 'main' });
    const id = opened.body.fork.id as string;
    expect((await asTool(request(app).post(`/forks/${id}/relaunch`))).status).toBe(403);
    world.sessions.set('branch-1', { ...world.launchedSession, running: true, switching: false, launching: false });
    const running = await asUser(request(app).post(`/forks/${id}/relaunch`));
    expect(running.status).toBe(409);
    expect(running.body.code).toBe('cli_already_running');
    world.sessions.set('branch-1', { ...world.launchedSession, running: false, switching: false, launching: false, provider: null });
    const again = await asUser(request(app).post(`/forks/${id}/relaunch`));
    expect(again.status).toBe(200);
    expect(again.body.fork.startup).toMatchObject({ stage: 'workspace' });
    expect((await asUser(request(app).post('/forks/nope/relaunch'))).status).toBe(404);
  });

  it('answers what can\'t be opened with its code', async () => {
    world.parents.set('empty', { ...world.parents.get('main')!, turns: 0 });
    expect((await asUser(request(app).post('/forks')).send({ parentSessionId: 'empty' })).body.code).toBe('nothing_to_fork');
    expect((await asUser(request(app).get('/forks/preview?parentSessionId=empty'))).status).toBe(409);
    expect((await asUser(request(app).post('/forks')).send({ parentSessionId: 'nope' })).status).toBe(404);
    expect((await asUser(request(app).post('/forks')).send({ parentSessionId: 'main', profileId: 'native:agy' })).body.code).toBe('launch_profile_unavailable');
    expect((await asUser(request(app).post('/forks')).send({ parentSessionId: 'main', depth: 2 })).body.code).toBe('invalid_request');
  });

  it('asks to confirm a low quota, then opens it', async () => {
    world.quota.set('native:claude', { remainingPercent: 3, limitedUntil: null });
    const low = await asUser(request(app).post('/forks')).send({ parentSessionId: 'main' });
    expect(low.status).toBe(409);
    expect(low.body).toMatchObject({ code: 'quota_low_confirm', params: { remaining: '3' } });
    expect((await asUser(request(app).post('/forks')).send({ parentSessionId: 'main', confirmLowQuota: true })).status).toBe(201);
  });

  it('closes one only with the user\'s login, and again without harm', async () => {
    const opened = await asUser(request(app).post('/forks')).send({ parentSessionId: 'main' });
    const id = opened.body.fork.id as string;
    const refused = await asTool(request(app).post(`/forks/${id}/close`)).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('login_required');
    const first = await asUser(request(app).post(`/forks/${id}/close`)).send({});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ fork: { id, closedReason: 'user' }, outcome: { workspace: 'removed' } });
    const again = await asUser(request(app).post(`/forks/${id}/close`)).send();
    expect(again.status).toBe(200);
    expect(again.body.outcome).toMatchObject({ tmuxClosed: false, workspace: 'removed' });
  });

  it('says when its CLI wouldn\'t exit', async () => {
    const opened = await asUser(request(app).post('/forks')).send({ parentSessionId: 'main' });
    const id = opened.body.fork.id as string;
    for (let i = 0; i < 3; i++) await engine.advance();
    world.closeOutcome = { ok: false, reason: 'cli_busy' };
    const res = await asUser(request(app).post(`/forks/${id}/close`)).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'fork_still_running', params: { reason: 'cli_busy' } });
  });
});
