import { Router, type Response } from 'express';
import { z } from 'zod';
import { RECAP_STATUSES } from '../contract/recap.js';
import type { RecapResult, RecapScheduler } from '../recap/scheduler.js';
import { recap as defaultRecap } from '../recap/wiring.js';
import { sendError } from './errors.js';

// Conversation recaps. The
// scheduler is passed in so tests can drive one of their own.

const nullableId = z.string().trim().min(1).max(200).nullable();
const settingsPatch = z.object({
  enabled: z.boolean(),
  profileId: nullableId,
  model: nullableId,
  effort: z.string().trim().min(1).max(50).nullable(),
  backfillOld: z.boolean(),
}).partial().strict();
const statusChange = z.object({ status: z.enum(RECAP_STATUSES) }).strict();

function send<T>(res: Response, result: RecapResult<T>, status = 200): void {
  if (result.ok) {
    res.status(status).json(result.value);
    return;
  }
  sendError(res, result.status, result.code, result.message, result.params);
}

/** GET/PUT /recap/settings, GET /recap/profiles and /recap/models. */
export function recapRouter(scheduler: RecapScheduler = defaultRecap): Router {
  const router = Router();
  router.get('/settings', async (_req, res) => {
    res.json(await scheduler.getSettings());
  });
  router.put('/settings', async (req, res) => {
    const parsed = settingsPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    send(res, await scheduler.updateSettings(parsed.data));
  });
  router.get('/profiles', async (_req, res) => {
    res.json({ profiles: await scheduler.listProfiles() });
  });
  router.get('/models', async (req, res) => {
    const { profileId, refresh } = req.query;
    if (typeof profileId !== 'string' || !profileId) {
      sendError(res, 400, 'invalid_request', 'profileId is required');
      return;
    }
    send(res, await scheduler.listModels(profileId, refresh === '1'));
  });
  return router;
}

/** Mounted under /sessions: a session's recaps, asking for one, and the user's status for an item. */
export function sessionRecapRouter(scheduler: RecapScheduler = defaultRecap): Router {
  const router = Router();
  router.get('/:id/recaps', async (req, res) => {
    const recaps = await scheduler.sessionRecaps(req.params.id);
    if (!recaps) {
      sendError(res, 404, 'not_found', 'not found');
      return;
    }
    res.json(recaps);
  });
  router.post('/:id/conversations/:conversationId/recap/refresh', async (req, res) => {
    send(res, await scheduler.refresh(req.params.id, req.params.conversationId), 202);
  });
  router.patch('/:id/conversations/:conversationId/recap/items/:itemId', async (req, res) => {
    const parsed = statusChange.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    send(res, await scheduler.setItemStatus(req.params.id, req.params.conversationId, req.params.itemId, parsed.data.status));
  });
  return router;
}
