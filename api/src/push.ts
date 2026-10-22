import webpush from 'web-push';
import { PUSH_SUBSCRIPTIONS_PATH, VAPID_KEYS_PATH } from './config.js';
import { jsonFileStore } from '@maderaojen/json-file-store';

// Notifications to the browsers and apps that turned them on (Settings →
// 通知). Browsers get Web Push: the VAPID key pair is made on first use and
// kept in the state directory, readable by this user only; the public half
// is what browsers subscribe with. The iOS/Android app can't take Web Push;
// it subscribes through a relay instead: an
// https endpoint and an opaque credential, posted back with each message.
// This backend knows no relay of its own; the app says where it is.

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
// hostId: what the subscribing frontend calls this backend in its own host
// list. A frontend can talk to several backends, so a notification's link
// carries it (see linkFor) for a tap to open this host's chat, not
// whichever host the app happens to be on. Absent for subscriptions made
// before frontends had hosts.
export type RelaySubscription = { endpoint: string; credential: string };
type Bookkeeping = { createdAt: string; hostId?: string };
// Web Push entries keep the shape they always had; a relay one sits under
// `relay`, identified by its credential (the relay seals the same device
// token to the same credential, so re-subscribing doesn't pile up).
type StoredSubscription = (PushSubscription & Bookkeeping) | ({ relay: RelaySubscription } & Bookkeeping);
export type PushMessage = { title: string; body: string; url: string; tag: string };

// Push services need a contact for the sender; nothing is ever sent to it.
const VAPID_SUBJECT = 'mailto:hestia@localhost';

type VapidKeys = { publicKey: string; privateKey: string };

// Both files are readable by this user only: one holds the private key,
// the other each browser's push credentials.
const keysFile = jsonFileStore<VapidKeys | null>({ path: VAPID_KEYS_PATH, empty: () => null, mode: 0o600 });
const subscriptionsFile = jsonFileStore<StoredSubscription[]>({ path: PUSH_SUBSCRIPTIONS_PATH, empty: () => [], mode: 0o600 });
// Shared by concurrent first callers, so only one key pair is ever made.
let keysReady: Promise<VapidKeys> | null = null;

async function loadOrCreateKeys(): Promise<VapidKeys> {
  const stored = await keysFile.load();
  if (stored) return stored;
  const created = webpush.generateVAPIDKeys();
  await keysFile.save(created);
  return created;
}

function vapidKeys(): Promise<VapidKeys> {
  keysReady ??= loadOrCreateKeys().catch((err: unknown) => {
    keysReady = null; // a failed read or write is retried next time
    throw err;
  });
  return keysReady;
}

let subscriptions: StoredSubscription[] = [];

async function loadSubscriptions(): Promise<StoredSubscription[]> {
  subscriptions = await subscriptionsFile.load();
  return subscriptions;
}

function persist(): Promise<void> {
  return subscriptionsFile.save(subscriptions);
}

export async function publicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

function isRelay(entry: StoredSubscription): entry is { relay: RelaySubscription } & Bookkeeping {
  return 'relay' in entry;
}

function identity(entry: StoredSubscription): string {
  return isRelay(entry) ? `relay:${entry.relay.credential}` : entry.endpoint;
}

async function add(entry: StoredSubscription): Promise<void> {
  const list = await loadSubscriptions();
  subscriptions = [...list.filter((existing) => identity(existing) !== identity(entry)), entry];
  await persist();
}

async function remove(id: string): Promise<void> {
  const list = await loadSubscriptions();
  subscriptions = list.filter((entry) => identity(entry) !== id);
  await persist();
}

function bookkeeping(hostId: string | undefined): Bookkeeping {
  return { createdAt: new Date().toISOString(), ...(hostId ? { hostId } : {}) };
}

export function subscribe(subscription: PushSubscription, hostId?: string): Promise<void> {
  return add({ ...subscription, ...bookkeeping(hostId) });
}

export function subscribeRelay(relay: RelaySubscription, hostId?: string): Promise<void> {
  return add({ relay: { endpoint: relay.endpoint, credential: relay.credential }, ...bookkeeping(hostId) });
}

// The message's in-app path, tagged with the host it's for.
function linkFor(url: string, hostId: string | undefined): string {
  if (!hostId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}host=${encodeURIComponent(hostId)}`;
}

export function unsubscribe(endpoint: string): Promise<void> {
  return remove(endpoint);
}

export function unsubscribeRelay(credential: string): Promise<void> {
  return remove(`relay:${credential}`);
}

// A relay that doesn't answer in this long counts as a failed send, not a
// dead subscription.
const RELAY_TIMEOUT_MS = 10_000;

// Throws on failure with the HTTP status as statusCode when there was one,
// as web-push itself does, so sendToAll treats both kinds alike.
async function sendOne(entry: StoredSubscription, payload: PushMessage, vapid: VapidKeys): Promise<void> {
  if (isRelay(entry)) {
    const response = await fetch(entry.relay.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: entry.relay.credential, message: payload }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!response.ok) throw Object.assign(new Error(`relay answered ${response.status}`), { statusCode: response.status });
    return;
  }
  await webpush.sendNotification({ endpoint: entry.endpoint, keys: entry.keys }, JSON.stringify(payload), {
    vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: 60 * 60,
  });
}

// To every subscribed browser and app. One the push service or relay says
// is gone (404/410: unsubscribed, app removed) is forgotten; any other
// failure (a timeout, a relay that's down) is left for the next message.
export async function sendToAll(message: PushMessage): Promise<void> {
  const list = await loadSubscriptions();
  if (list.length === 0) return;
  const vapid = list.some((entry) => !isRelay(entry)) ? await vapidKeys() : { publicKey: '', privateKey: '' };
  const gone = new Set<string>();
  await Promise.all(list.map(async (entry) => {
    try {
      await sendOne(entry, { ...message, url: linkFor(message.url, entry.hostId) }, vapid);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.add(identity(entry));
      else console.warn(`[push] sending to ${new URL(isRelay(entry) ? entry.relay.endpoint : entry.endpoint).host} failed`, status ?? err);
    }
  }));
  if (gone.size > 0) {
    subscriptions = (await loadSubscriptions()).filter((entry) => !gone.has(identity(entry)));
    await persist();
  }
}

export function __resetForTests(): void {
  keysFile.reset();
  subscriptionsFile.reset();
  keysReady = null;
  subscriptions = [];
}
