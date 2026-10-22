import { Router } from 'express';
import { z } from 'zod';
import * as push from '../push.js';
import { sendError } from './errors.js';

// Turning notifications on and off for a browser or the app (Settings →
// 通知). The app subscribes through a relay (push.ts), announced to clients
// as the native_push capability.
export const pushRouter = Router();

pushRouter.get('/key', async (_req, res) => {
  res.json({ publicKey: await push.publicKey() });
});

// The frontend's own id for this host (push.ts's StoredSubscription).
// Kept to URL-safe characters: it goes into every notification's link.
const hostIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional();

const subscriptionSchema = z.union([
  z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
    hostId: hostIdSchema,
  }),
  z.object({
    relay: z.object({
      // Only https: this backend posts every notification there.
      endpoint: z.string().url().refine((url) => url.startsWith('https://'), 'relay endpoint must be https'),
      credential: z.string().min(1).max(2048),
    }),
    hostId: hostIdSchema,
  }),
]);

pushRouter.post('/subscriptions', async (req, res) => {
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  if ('relay' in parsed.data) {
    await push.subscribeRelay(parsed.data.relay, parsed.data.hostId);
  } else {
    const { hostId, ...subscription } = parsed.data;
    await push.subscribe(subscription, hostId);
  }
  res.status(204).end();
});

const removalSchema = z.union([
  z.object({ endpoint: z.string().min(1) }),
  z.object({ credential: z.string().min(1) }),
]);

pushRouter.post('/subscriptions/remove', async (req, res) => {
  const parsed = removalSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  if ('credential' in parsed.data) await push.unsubscribeRelay(parsed.data.credential);
  else await push.unsubscribe(parsed.data.endpoint);
  res.status(204).end();
});
