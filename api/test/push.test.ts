import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.fn();
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('web-push') }>();
  return { default: { ...actual.default, sendNotification } };
});

let stateDir: string;
let push: typeof import('../src/push.js');

beforeEach(async () => {
  vi.resetModules();
  sendNotification.mockReset();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-push-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  push = await import('../src/push.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
const message = { title: 't', body: 'b', url: '/session/s1', tag: 's1:reply' };

describe('push', () => {
  it('makes its key pair once, readable by this user only', async () => {
    const key = await push.publicKey();
    expect(key.length).toBeGreaterThan(40);
    expect(await push.publicKey()).toBe(key);
    expect((await stat(path.join(stateDir, 'vapid.json'))).mode & 0o777).toBe(0o600);
  });

  it('makes only one key pair when the first callers arrive together', async () => {
    const [a, b] = await Promise.all([push.publicKey(), push.publicKey()]);
    expect(b).toBe(a);
    const stored = JSON.parse(await readFile(path.join(stateDir, 'vapid.json'), 'utf8')) as { publicKey: string };
    expect(stored.publicKey).toBe(a);
  });

  it('sends to every subscribed browser, and forgets one the push service says is gone', async () => {
    await push.subscribe(subscription('https://push.example/a'));
    await push.subscribe(subscription('https://push.example/b'));
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/b')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    });

    await push.sendToAll(message);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sendNotification.mock.calls[0]![1] as string)).toEqual(message);
    const stored = JSON.parse(await readFile(path.join(stateDir, 'push-subscriptions.json'), 'utf8')) as { endpoint: string }[];
    expect(stored.map((entry) => entry.endpoint)).toEqual(['https://push.example/a']);
  });

  it('tags each browser\'s link with the host id it subscribed under, so a tap opens that host', async () => {
    await push.subscribe(subscription('https://push.example/a'), 'lab');
    await push.subscribe(subscription('https://push.example/b'));
    sendNotification.mockResolvedValue(undefined);

    await push.sendToAll(message);
    const sent = new Map(sendNotification.mock.calls.map(([sub, payload]) => [(sub as { endpoint: string }).endpoint, JSON.parse(payload as string) as { url: string }]));
    expect(sent.get('https://push.example/a')?.url).toBe('/session/s1?host=lab');
    expect(sent.get('https://push.example/b')?.url).toBe('/session/s1');
    // Only the subscription itself goes to web-push, not our bookkeeping.
    expect(sendNotification.mock.calls[0]![0]).toEqual(subscription('https://push.example/a'));
  });

  it('subscribes a browser once, and unsubscribes it', async () => {
    await push.subscribe(subscription('https://push.example/a'));
    await push.subscribe(subscription('https://push.example/a'));
    await push.unsubscribe('https://push.example/a');
    await push.sendToAll(message);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  describe('relay subscriptions (the app)', () => {
    const relay = (credential: string) => ({ endpoint: 'https://relay.example/v1/send', credential });
    const fetchMock = vi.fn();

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const stored = async () => JSON.parse(await readFile(path.join(stateDir, 'push-subscriptions.json'), 'utf8')) as Array<{ endpoint?: string; relay?: { credential: string } }>;

    it('posts the credential and the message, its link tagged with the host, to the relay', async () => {
      await push.subscribeRelay(relay('cred-a'), 'lab');
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      await push.sendToAll(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe('https://relay.example/v1/send');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ credential: 'cred-a', message: { ...message, url: '/session/s1?host=lab' } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      // No browser subscribed: the VAPID key pair isn't even made.
      await expect(stat(path.join(stateDir, 'vapid.json'))).rejects.toThrow();
    });

    it('sends to browsers and apps alike', async () => {
      await push.subscribe(subscription('https://push.example/a'));
      await push.subscribeRelay(relay('cred-a'));
      sendNotification.mockResolvedValue(undefined);
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      await push.sendToAll(message);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('subscribes a device once per credential, and unsubscribes it without touching browsers', async () => {
      await push.subscribe(subscription('https://relay.example/v1/send'));
      await push.subscribeRelay(relay('cred-a'), 'lab');
      await push.subscribeRelay(relay('cred-a'), 'lab');
      await push.subscribeRelay(relay('cred-b'));
      expect((await stored()).filter((entry) => entry.relay).map((entry) => entry.relay!.credential)).toEqual(['cred-a', 'cred-b']);

      await push.unsubscribeRelay('cred-a');
      // The browser whose endpoint happens to equal the relay's stays.
      expect((await stored()).map((entry) => entry.relay?.credential ?? entry.endpoint)).toEqual(['https://relay.example/v1/send', 'cred-b']);
    });

    it('forgets a device the relay says is gone (410), and keeps it through a relay that is down', async () => {
      await push.subscribeRelay(relay('gone'));
      await push.subscribeRelay(relay('down'));
      await push.subscribeRelay(relay('slow'));
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const { credential } = JSON.parse(init.body as string) as { credential: string };
        if (credential === 'gone') return new Response(null, { status: 410 });
        if (credential === 'down') return new Response(null, { status: 502 });
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await push.sendToAll(message);
      expect((await stored()).map((entry) => entry.relay!.credential)).toEqual(['down', 'slow']);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });
});
