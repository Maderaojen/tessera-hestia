import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';

vi.mock('../../src/push.js', () => ({
  publicKey: vi.fn(async () => 'public-key'),
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(async () => {}),
  subscribeRelay: vi.fn(async () => {}),
  unsubscribeRelay: vi.fn(async () => {}),
}));
const push = await import('../../src/push.js');

let auth: string;
beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/push', () => {
  it('hands out the public key, only when logged in', async () => {
    const app = createApp();
    expect((await request(app).get('/api/push/key')).status).toBe(401);
    const res = await request(app).get('/api/push/key').set('Authorization', auth);
    expect(res.body).toEqual({ publicKey: 'public-key' });
  });

  it('subscribes a browser, refusing a malformed subscription', async () => {
    const app = createApp();
    const subscription = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } };
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send(subscription)).status).toBe(204);
    expect(push.subscribe).toHaveBeenCalledWith(subscription, undefined);
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send({ endpoint: 'nope' })).status).toBe(400);
  });

  it('keeps the frontend\'s id for this host, refusing one that isn\'t URL-safe', async () => {
    const app = createApp();
    const subscription = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } };
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send({ ...subscription, hostId: 'lab-1' })).status).toBe(204);
    expect(push.subscribe).toHaveBeenCalledWith(subscription, 'lab-1');
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send({ ...subscription, hostId: '../x?y' })).status).toBe(400);
  });

  it('unsubscribes a browser', async () => {
    const res = await request(createApp()).post('/api/push/subscriptions/remove').set('Authorization', auth).send({ endpoint: 'https://push.example/a' });
    expect(res.status).toBe(204);
    expect(push.unsubscribe).toHaveBeenCalledWith('https://push.example/a');
  });

  it('subscribes the app through its relay, only to an https endpoint', async () => {
    const app = createApp();
    const relay = { endpoint: 'https://relay.example/v1/send', credential: 'sealed' };
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send({ relay, hostId: 'lab-1' })).status).toBe(204);
    expect(push.subscribeRelay).toHaveBeenCalledWith(relay, 'lab-1');
    expect(push.subscribe).not.toHaveBeenCalled();
    const plain = { relay: { ...relay, endpoint: 'http://relay.example/v1/send' } };
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send(plain)).status).toBe(400);
    expect((await request(app).post('/api/push/subscriptions').set('Authorization', auth).send({ relay: { ...relay, credential: '' } })).status).toBe(400);
  });

  it('unsubscribes the app by its credential', async () => {
    const res = await request(createApp()).post('/api/push/subscriptions/remove').set('Authorization', auth).send({ credential: 'sealed' });
    expect(res.status).toBe(204);
    expect(push.unsubscribeRelay).toHaveBeenCalledWith('sealed');
    expect(push.unsubscribe).not.toHaveBeenCalled();
  });
});
