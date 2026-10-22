import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../src/auth.js';
import { createContinuity, decodeContinuityState, emptyContinuityState, type Continuity } from '../../src/continuity/engine.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import { fakePorts, newWorld, type World } from '../continuity/fake-ports.js';

vi.mock('../../src/registry.js', () => ({ getSession: vi.fn(), listSessions: vi.fn(async () => []) }));
const registry = await import('../../src/registry.js');
const { continuityDefaultsRouter, sessionContinuityRouter } = await import('../../src/routes/continuity.js');

let dir: string;
let world: World;
let engine: Continuity;
let app: express.Express;
let login: string;

// The routes sit behind server.ts's requireAuth (a login or the local tool
// token); the settings take only a login.
const TOOL_TOKEN = 'tool-token-for-tests';
const userPut = (url: string) => request(app).put(url).set('Authorization', login);
const toolPut = (url: string) => request(app).put(url).set('X-Hestia-Token', TOOL_TOKEN);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'continuity-route-'));
  world = newWorld();
  world.hits.set('s1', null);
  engine = createContinuity(fakePorts(world), jsonFileStore({ path: path.join(dir, 'c.json'), empty: emptyContinuityState, decode: decodeContinuityState }));
  app = express().use(express.json())
    .use('/continuity', continuityDefaultsRouter(engine))
    .use('/sessions', sessionContinuityRouter(engine));
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  login = `Bearer ${auth.issueSessionToken({ username: 'alice', localOnly: false })}`;
  vi.mocked(registry.getSession).mockImplementation(async (id: string) => (id === 's1' ? { id: 's1' } as never : undefined));
});

afterEach(async () => {
  auth.__setLocalToolTokenForTests(null);
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('/continuity', () => {
  it('starts off, with the settings for carrying on and handing off ready', async () => {
    const res = await request(app).get('/continuity');
    expect(res.body.defaults).toEqual({
      mode: 'off', resumePrompt: '額度已重置，請從剛才中斷的地方繼續。', resumeDelaySeconds: 120, maxAutoResumesPerDay: 6,
      chain: [], softRemainingPercent: 15, hardRemainingPercent: 8, handoffSource: 'self_then_mechanical', handoffConfirm: 'ask', selfBriefTimeoutSeconds: 300,
    });
  });

  it('updates part of the defaults', async () => {
    const res = await userPut('/continuity').send({ mode: 'handoff', chain: ['native:codex'], softRemainingPercent: 20 });
    expect(res.status).toBe(200);
    expect(res.body.defaults).toMatchObject({ mode: 'handoff', chain: ['native:codex'], softRemainingPercent: 20, maxAutoResumesPerDay: 6 });
  });

  it.each([
    [{ mode: 'later' }],
    [{ resumePrompt: '   ' }],
    [{ resumeDelaySeconds: -1 }],
    [{ hardRemainingPercent: 30 }],
    [{ handoffConfirm: 'maybe' }],
    [{ chain: 'native:codex' }],
    [{ somethingElse: 1 }],
  ])('rejects %j', async (body) => {
    const res = await userPut('/continuity').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('/sessions/:id/continuity', () => {
  it('shows the effective policy, nothing pending, no handoff, no history', async () => {
    const res = await request(app).get('/sessions/s1/continuity');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ override: {}, pending: null, handoff: null, history: [], effective: { mode: 'off' } });
  });

  it('sets and clears a session override', async () => {
    let res = await userPut('/sessions/s1/continuity').send({ mode: 'handoff', chain: ['native:codex'] });
    expect(res.body).toMatchObject({ override: { mode: 'handoff', chain: ['native:codex'] }, effective: { mode: 'handoff' } });
    res = await userPut('/sessions/s1/continuity').send({ mode: null });
    expect(res.body).toMatchObject({ override: { chain: ['native:codex'] }, effective: { mode: 'off' } });
  });

  it('checks the thresholds against the effective ones', async () => {
    const res = await userPut('/sessions/s1/continuity').send({ hardRemainingPercent: 20 });
    expect(res.status).toBe(400);
  });

  it('cancels whatever is pending', async () => {
    const res = await request(app).delete('/sessions/s1/continuity/pending');
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeNull();
  });

  it('404s for a session that does not exist', async () => {
    expect((await request(app).get('/sessions/nope/continuity')).status).toBe(404);
    expect((await request(app).post('/sessions/nope/continuity/handoff').send({})).status).toBe(404);
  });
});

describe('who may change the settings', () => {
  it('reads them with the tool token too, changes them only with the login', async () => {
    const tool = (req: request.Test) => req.set('X-Hestia-Token', TOOL_TOKEN);
    expect((await tool(request(app).get('/continuity'))).status).toBe(200);
    expect((await tool(request(app).get('/sessions/s1/continuity'))).status).toBe(200);
    for (const res of [await toolPut('/continuity').send({ mode: 'handoff' }), await toolPut('/sessions/s1/continuity').send({ mode: 'handoff' })]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('login_required');
    }
    expect((await engine.getDefaults()).mode).toBe('off');
    expect((await engine.getSession('s1')).override).toEqual({});
    expect((await userPut('/sessions/s1/continuity').send({ mode: 'handoff' })).status).toBe(200);
  });

  it('leaves a handoff, an action on the session, to either token', async () => {
    const res = await request(app).post('/sessions/s1/continuity/handoff').set('X-Hestia-Token', TOOL_TOKEN).send({ toProfileId: 'janus:claude:personal' });
    expect(res.status).toBe(200);
  });

  it('lets only the login choose the permission mode of the CLI taking over (ADR 0027)', async () => {
    const tool = await request(app).post('/sessions/s1/continuity/handoff').set('X-Hestia-Token', TOOL_TOKEN)
      .send({ toProfileId: 'janus:claude:personal', permissionMode: 'yolo' });
    expect(tool.status).toBe(403);
    expect(tool.body.code).toBe('login_required');
    expect((await engine.getSession('s1')).handoff).toBeNull();
    const user = await request(app).post('/sessions/s1/continuity/handoff').set('Authorization', login)
      .send({ toProfileId: 'janus:claude:personal', permissionMode: 'yolo' });
    expect(user.status).toBe(200);
    expect(user.body.handoff.permissionMode).toBe('yolo');
  });
});

describe('/sessions/:id/continuity/handoff', () => {
  it('starts one to a named profile, then cancels it', async () => {
    let res = await request(app).post('/sessions/s1/continuity/handoff').send({ toProfileId: 'native:codex' });
    expect(res.status).toBe(200);
    expect(res.body.handoff).toMatchObject({ trigger: 'manual', toProfileId: 'native:codex', stage: 'writing_brief' });
    res = await request(app).delete('/sessions/s1/continuity/handoff');
    expect(res.body.handoff).toBeNull();
  });

  it('409s with nobody in the chain to hand to', async () => {
    const res = await request(app).post('/sessions/s1/continuity/handoff').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_handoff_target');
  });

  it('409s a confirm with nothing waiting', async () => {
    const res = await request(app).post('/sessions/s1/continuity/handoff/confirm');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_not_awaiting');
  });

  it('400s an unknown profile', async () => {
    const res = await request(app).post('/sessions/s1/continuity/handoff').send({ toProfileId: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('launch_profile_unavailable');
  });

  it('takes the handoff\'s own choices', async () => {
    const res = await request(app).post('/sessions/s1/continuity/handoff').send({ toProfileId: 'native:codex', briefBy: 'incoming', afterReport: 'continue' });
    expect(res.status).toBe(200);
    expect(res.body.handoff).toMatchObject({ source: 'incoming', confirm: 'auto', briefSource: 'incoming' });
    expect(res.body.selfBrief).toEqual({ available: true, reason: null });
  });

  it.each([
    [{ briefBy: 'system' }],
    [{ afterReport: 'later' }],
  ])('400s %j', async (body) => {
    const res = await request(app).post('/sessions/s1/continuity/handoff').send({ toProfileId: 'native:codex', ...body });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('409s a dismiss with nothing reported', async () => {
    const res = await request(app).post('/sessions/s1/continuity/handoff/dismiss');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_not_awaiting');
  });

  it('relaunch: 409s with no failed handoff, 400s a bad body, and takes the permission mode only from the login (ADR 0030)', async () => {
    let res = await request(app).post('/sessions/s1/continuity/handoff/relaunch').send({ briefFile: '.hestia/handoffs/x.md' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_not_retryable');
    res = await request(app).post('/sessions/s1/continuity/handoff/relaunch').send({});
    expect(res.status).toBe(400);
    res = await request(app).post('/sessions/s1/continuity/handoff/relaunch').set('X-Hestia-Token', TOOL_TOKEN)
      .send({ briefFile: '.hestia/handoffs/x.md', permissionMode: 'yolo' });
    expect(res.status).toBe(403);
    res = await request(app).delete('/sessions/s1/continuity/handoff/failed');
    expect(res.status).toBe(200);
    expect(res.body.failedHandoff).toBeNull();
  });

  it('takes handoffSource incoming as a setting', async () => {
    const res = await userPut('/continuity').send({ handoffSource: 'incoming' });
    expect(res.status).toBe(200);
    expect(res.body.defaults.handoffSource).toBe('incoming');
  });
});

describe('GET /sessions/:id/continuity/handoffs/:handoffId/brief', () => {
  const ID = '1a2b3c4d-0000-4000-8000-000000000001';
  const OTHER = '1a2b3c4d-0000-4000-8000-0000000000ff';
  const NAME = '20261010-073000Z-1a2b3c4d.md';
  let cwd: string;
  const record = (handoffId: string, briefFile: string | null) => ({
    handoffId, trigger: 'manual', fromConversationId: 'c1', briefSource: 'self', source: 'self_then_mechanical', briefNote: null, confirm: 'ask', briefAmended: null, briefFile,
  });
  const get = (handoffId: string) => request(app).get(`/sessions/s1/continuity/handoffs/${handoffId}/brief`).set('Authorization', login);

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'brief-route-'));
    await mkdir(path.join(cwd, '.hestia', 'handoffs'), { recursive: true });
    await writeFile(path.join(cwd, '.hestia', 'handoffs', NAME), '# 交接\n目標');
    vi.mocked(registry.getSession).mockImplementation(async (id: string) => (id === 's1'
      ? { id: 's1', cwd, conversations: [{ id: 'c2', handoff: record(ID, `.hestia/handoffs/${NAME}`) }] } as never
      : undefined));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reads one of this session\'s briefs, by its full or short id', async () => {
    for (const asked of [ID, '1a2b3c4d']) {
      const res = await get(asked);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ handoffId: asked, file: `.hestia/handoffs/${NAME}`, content: '# 交接\n目標', truncated: false });
    }
  });

  it('only with the user\'s login, not the tool token an LLM in a tmux holds', async () => {
    const res = await request(app).get(`/sessions/s1/continuity/handoffs/${ID}/brief`).set('X-Hestia-Token', TOOL_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
  });

  it('404s a handoff that isn\'t this session\'s, even when its file is in the same folder', async () => {
    await writeFile(path.join(cwd, '.hestia', 'handoffs', '20261010-080000Z-9f8e7d6c.md'), 'another session\'s');
    expect((await get('9f8e7d6c-0000-4000-8000-000000000002')).status).toBe(404);
    expect((await get('9f8e7d6c')).body.code).toBe('not_found');
  });

  it('400s what isn\'t an id', async () => {
    const res = await get('..%2F..%2Fetc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('409s a short id that fits two of this session\'s handoffs', async () => {
    vi.mocked(registry.getSession).mockImplementation(async (id: string) => (id === 's1'
      ? { id: 's1', cwd, conversations: [{ id: 'c2', handoff: record(ID, `.hestia/handoffs/${NAME}`) }, { id: 'c3', handoff: record(OTHER, null) }] } as never
      : undefined));
    const res = await get('1a2b3c4d');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_brief_ambiguous');
    expect((await get(ID)).status).toBe(200);
  });

  it('404s a brief that is gone, 409s one that is a symlink', async () => {
    await rm(path.join(cwd, '.hestia', 'handoffs', NAME));
    expect((await get(ID)).body.code).toBe('handoff_brief_missing');
    await symlink('/etc/hostname', path.join(cwd, '.hestia', 'handoffs', NAME));
    const res = await get(ID);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('handoff_brief_unsafe');
  });

  it('409s a stored name that leads elsewhere', async () => {
    vi.mocked(registry.getSession).mockImplementation(async () => ({ id: 's1', cwd, conversations: [{ id: 'c2', handoff: record(ID, '.hestia/handoffs/../../x.md') }] }) as never);
    expect((await get(ID)).body.code).toBe('handoff_brief_unsafe');
  });

  it('404s a session that isn\'t there (or is in the trash)', async () => {
    const res = await request(app).get(`/sessions/nope/continuity/handoffs/${ID}/brief`).set('Authorization', login);
    expect(res.status).toBe(404);
  });
});
