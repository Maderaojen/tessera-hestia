import { Router, type Response } from 'express';
import { z } from 'zod';
import type { ForkEngine, ForkResult } from '../fork/engine.js';
import { fork as defaultEngine } from '../fork/wiring.js';
import { sendError } from './errors.js';
import { refreshSpawnState } from '../services/spawn-closable.js';
import { requireLogin } from './login-guard.js';
import { PERMISSION_MODES } from '../contract/permissions.js';

// Branch lines. The engine is passed in so tests can
// drive one of their own.
//
// Only the user opens or closes one (ADR 0023 決策 1): those take the
// user's login. Reading — the list, one, the preview — takes either token,
// so `hestia conversation show --upstream` finds where a branch line came
// from.

const MAX_TEXT = 100_000;

const startSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  profileId: z.string().min(1).max(512).optional(),
  title: z.string().trim().max(200).optional(),
  instruction: z.string().max(MAX_TEXT).optional(),
  confirmLowQuota: z.boolean().optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
}).strict();

const closeSchema = z.object({ force: z.boolean().optional() }).strict();

const listSchema = z.object({
  session: z.string().min(1).max(256).optional(),
  open: z.enum(['0', '1']).optional(),
});

const previewSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  profileId: z.string().min(1).max(512).optional(),
});

function sendResult(res: Response, result: ForkResult, status = 200): void {
  if (result.ok) {
    res.status(status).json({ fork: result.fork });
    return;
  }
  sendError(res, result.status, result.code, result.message, result.params);
}

// After a close, the session list is told at once (its `closable` cleared,
// `spawnClosedAt` set) rather than on the closable watch's next round.
export function forksRouter(engine: ForkEngine = defaultEngine, afterClose: () => void = refreshSpawnState): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    res.json({ forks: await engine.list({ sessionId: parsed.data.session, open: parsed.data.open === '1' }) });
  });

  // Before /:id, which would take "preview" for an id.
  router.get('/preview', async (req, res) => {
    const parsed = previewSchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const result = await engine.preview(parsed.data.parentSessionId, parsed.data.profileId);
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message, result.params);
      return;
    }
    res.json(result.preview);
  });

  router.post('/', requireLogin, async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    sendResult(res, await engine.startFork(parsed.data), 201);
  });

  router.get('/:id', async (req, res) => {
    const found = await engine.get(req.params.id);
    if (!found) {
      sendError(res, 404, 'not_found', 'not found');
      return;
    }
    res.json({ fork: found });
  });

  // Its CLI is gone: started again with the same brief (ADR 0030).
  router.post('/:id/relaunch', requireLogin, async (req, res) => {
    const result = await engine.relaunch(String(req.params.id));
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message, result.params);
      return;
    }
    res.json({ fork: result.fork });
  });

  router.post('/:id/close', requireLogin, async (req, res) => {
    const parsed = closeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const result = await engine.close(String(req.params.id), parsed.data);
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message, result.params);
      return;
    }
    afterClose();
    res.json({ fork: result.fork, outcome: result.outcome });
  });

  return router;
}
