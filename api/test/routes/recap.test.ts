import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecapScheduler } from '../../src/recap/scheduler.js';
import { emptyRecapSettings, recapSettingsStore, type RecapSettingsState } from '../../src/recap/settings-store.js';
import { recapRouter, sessionRecapRouter } from '../../src/routes/recap.js';
import { addConversation, at, conversation, fakePorts, newWorld, setRecap, T0, turns, type World } from '../recap/fake-ports.js';

let dir: string;
let world: World;

const ON: RecapSettingsState = {
  ...emptyRecapSettings(), enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabledAt: at(T0),
};

async function appWith(settings: RecapSettingsState = emptyRecapSettings()): Promise<express.Express> {
  const store = recapSettingsStore(path.join(dir, 'conversation-recap.json'));
  await store.save(settings);
  const scheduler = createRecapScheduler(fakePorts(world), store);
  return express().use(express.json()).use('/recap', recapRouter(scheduler)).use('/sessions', sessionRecapRouter(scheduler));
}

const item = {
  id: 'r_a0000000', title: '深色主題', status: 'uncertain' as const, statusSource: 'auto' as const, turns: { from: 0, to: 1 },
  createdAt: at(T0), updatedAt: at(T0), statusChangedAt: null,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'recap-route-'));
  world = newWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('/recap/settings', () => {
  it('starts off, with an empty queue', async () => {
    const res = await request(await appWith()).get('/recap/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false, profileId: null, model: null, effort: null, backfillOld: false, enabledAt: null, pause: null,
      queue: { running: null, waiting: 0 },
    });
  });

  it('turns on with an account and a model it has', async () => {
    const res = await request(await appWith()).put('/recap/settings').send({ enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabledAt: expect.any(String) });
  });

  it.each([
    ['a field of the wrong type', { enabled: 'yes' }, 400, 'invalid_request'],
    ['an unknown field', { enabledAt: '2026-01-01T00:00:00.000Z' }, 400, 'invalid_request'],
    ['an empty model', { model: '' }, 400, 'invalid_request'],
    ['on without a model', { enabled: true, profileId: 'native:codex' }, 400, 'invalid_request'],
    ['an account that isn\'t offered', { enabled: true, profileId: 'native:agy', model: 'x' }, 400, 'launch_profile_unavailable'],
    ['a model the account doesn\'t have', { enabled: true, profileId: 'native:codex', model: 'gpt-x' }, 400, 'model_unknown'],
    ['an effort the model doesn\'t have', { enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'ultra' }, 400, 'invalid_request'],
  ])('refuses %s', async (_name, body, status, code) => {
    const app = await appWith();
    const res = await request(app).put('/recap/settings').send(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect((await request(app).get('/recap/settings')).body.enabled).toBe(false);
  });
});

describe('/recap/profiles and /recap/models', () => {
  it('lists the accounts a recap can run on', async () => {
    const res = await request(await appWith()).get('/recap/profiles');
    expect(res.status).toBe(200);
    expect(res.body.profiles.map((profile: { id: string }) => profile.id)).toEqual(['native:codex', 'janus:claude:personal']);
  });

  it('lists an account\'s models, without a current choice', async () => {
    const res = await request(await appWith()).get('/recap/models').query({ profileId: 'native:codex' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runtimeId: 'codex-cli', source: 'account', options: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna', efforts: expect.arrayContaining(['low']) }] });
    expect(res.body).not.toHaveProperty('current');
  });

  it.each([
    ['no profileId', {}, 400, 'invalid_request'],
    ['an account that isn\'t offered', { profileId: 'native:agy' }, 400, 'launch_profile_unavailable'],
  ])('refuses %s', async (_name, query, status, code) => {
    const res = await request(await appWith()).get('/recap/models').query(query);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it('a list the CLI can\'t give is model_list_failed', async () => {
    world.models.delete('janus:claude:personal');
    const res = await request(await appWith()).get('/recap/models').query({ profileId: 'janus:claude:personal', refresh: '1' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'model_list_failed', params: { cli: 'Claude · personal' } });
  });
});

describe('/sessions/:id/recaps', () => {
  it('lists a session\'s conversations, newest first', async () => {
    addConversation(world, conversation('s1', 'c1', turns(2), { sequence: 1 }));
    addConversation(world, conversation('s1', 'c2', turns(1), { sequence: 2, provider: null }));
    const res = await request(await appWith()).get('/sessions/s1/recaps');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      conversations: [
        { conversationId: 'c2', available: false, state: 'unavailable' },
        { conversationId: 'c1', available: true, state: 'disabled', totalTurns: 2, coveredTurns: 0, pendingTurns: 2, items: [], generator: null, error: null, pause: null },
      ],
    });
  });

  it.each([
    ['no such session', 'nope'],
    ['a session in the trash', 's1'],
  ])('is not_found for %s', async (_name, sessionId) => {
    addConversation(world, conversation('s1', 'c1', turns(2), { trashed: true }));
    const res = await request(await appWith(ON)).get(`/sessions/${sessionId}/recaps`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

describe('POST …/recap/refresh', () => {
  it('is refused while recaps are off', async () => {
    addConversation(world, conversation('s1', 'c1', turns(2)));
    const res = await request(await appWith()).post('/sessions/s1/conversations/c1/recap/refresh');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('recap_disabled');
  });

  it('queues the conversation first in line', async () => {
    addConversation(world, conversation('s1', 'c1', turns(2)));
    // Answer once the request has been taken.
    world.answers.push(() => new Promise(() => {}));
    const res = await request(await appWith(ON)).post('/sessions/s1/conversations/c1/recap/refresh');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ conversationId: 'c1', state: 'queued', totalTurns: 2 });
  });

  it.each([
    ['a conversation without a provider', { provider: null }, 409, 'recap_unavailable'],
    ['a session in the trash', { trashed: true }, 404, 'not_found'],
  ])('refuses %s', async (_name, patch, status, code) => {
    addConversation(world, conversation('s1', 'c1', turns(2), patch));
    const res = await request(await appWith(ON)).post('/sessions/s1/conversations/c1/recap/refresh');
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('PATCH …/recap/items/:itemId', () => {
  beforeEach(() => {
    const owner = addConversation(world, conversation('s1', 'c1', turns(2)));
    setRecap(world, owner, { items: [item], coveredTurns: 0 });
  });

  it('sets the user\'s status, also with recaps off', async () => {
    const res = await request(await appWith()).patch('/sessions/s1/conversations/c1/recap/items/r_a0000000').send({ status: 'accepted' });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ ...item, status: 'accepted', statusSource: 'user', statusChangedAt: expect.any(String), updatedAt: expect.any(String) }]);
  });

  it.each([
    ['an unknown status', 'r_a0000000', { status: 'done' }, 400, 'invalid_request'],
    ['another field', 'r_a0000000', { status: 'accepted', title: 'x' }, 400, 'invalid_request'],
    ['an unknown item', 'r_nope', { status: 'accepted' }, 404, 'recap_item_not_found'],
  ])('refuses %s', async (_name, itemId, body, status, code) => {
    const res = await request(await appWith()).patch(`/sessions/s1/conversations/c1/recap/items/${itemId}`).send(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it('is not_found for a session in the trash', async () => {
    addConversation(world, conversation('s1', 'c1', turns(2), { trashed: true }));
    const res = await request(await appWith()).patch('/sessions/s1/conversations/c1/recap/items/r_a0000000').send({ status: 'accepted' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});
