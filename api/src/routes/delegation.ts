import { Router, type Response } from 'express';
import { z } from 'zod';
import { DELEGATION_LLM_INITIATED, DELEGATION_NOTIFY, type DelegationDetailResponse } from '../contract/delegation.js';
import type { DelegationEngine, DelegationResult, SessionSettingsResult } from '../delegation/engine.js';
import { delegation as defaultEngine } from '../delegation/wiring.js';
import { sendError } from './errors.js';
import { refreshSpawnState } from '../services/spawn-closable.js';
import { isLoginRequest, requireLogin } from './login-guard.js';
import { PERMISSION_MODES } from '../contract/permissions.js';
import { permissionModeAllowed } from './permission-modes.js';

// Delegating work to another LLM. The engine is
// passed in so tests can drive one of their own.
//
// Who may do what (ADR 0015 決策 5, 10, 14): the user (their login) starts
// one, approves or declines an LLM's proposal, sends it back, accepts,
// rejects or stops it, cleans up its worktree, and changes the settings.
// The local tool token (`hestia delegate`, so any LLM in a tmux) starts one
// as the LLM (checked against the settings), delivers from the delegate's
// own session, reviews (passes or sends back) and stops one from the
// delegating session, and reads.

const MAX_TEXT = 100_000;

const startSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  task: z.string().trim().min(1).max(MAX_TEXT),
  profileId: z.string().min(1).max(512).optional(),
  title: z.string().trim().max(200).optional(),
  isolation: z.enum(['worktree', 'shared']).optional(),
  confirmLowQuota: z.boolean().optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
}).strict();

const deliverSchema = z.object({
  fromSessionId: z.string().min(1).max(256),
  report: z.string().trim().min(1).max(MAX_TEXT),
  blocked: z.boolean().optional(),
}).strict();

const stopSchema = z.object({ fromSessionId: z.string().min(1).max(256).optional() }).strict();

const reviewSchema = z.object({
  fromSessionId: z.string().min(1).max(256).optional(),
  verdict: z.enum(['pass', 'send_back']),
  feedback: z.string().max(MAX_TEXT).optional(),
}).strict();

const cleanupSchema = z.object({ deleteBranch: z.boolean().optional() }).strict();

const preferenceFields = {
  targets: z.array(z.string().min(1).max(512)).max(20),
  llmInitiated: z.enum(DELEGATION_LLM_INITIATED as [string, ...string[]]),
  isolation: z.enum(['worktree', 'shared']),
  parentReview: z.boolean(),
  notify: z.enum(DELEGATION_NOTIFY as [string, ...string[]]),
  idleAttentionMinutes: z.number().int().min(1).max(1440),
};
const limitFields = {
  maxConcurrent: z.number().int().min(0).max(20),
  maxDepth: z.number().int().min(0).max(5),
  maxReviewRounds: z.number().int().min(0).max(10),
  minRemainingPercent: z.number().int().min(0).max(100),
};
const partial = (fields: Record<string, z.ZodTypeAny>, nullable: boolean) => z.object(Object.fromEntries(
  Object.entries(fields).map(([key, schema]) => [key, (nullable ? schema.nullable() : schema).optional()]),
)).strict();
const settingsPatch = z.object({ preferences: partial(preferenceFields, false).optional(), limits: partial(limitFields, false).optional() }).strict();
const sessionPatch = z.object({ preferences: partial(preferenceFields, true).optional(), limits: partial(limitFields, true).optional() }).strict();

const listSchema = z.object({
  session: z.string().min(1).max(256).optional(),
  active: z.enum(['0', '1']).optional(),
});

function sendResult(res: Response, result: DelegationResult, status = 200): void {
  if (result.ok) {
    res.status(status).json({ delegation: result.delegation });
    return;
  }
  sendError(res, result.status, result.code, result.message, result.params);
}

// After a cleanup, the session list is told at once (its `closable` cleared,
// `spawnClosedAt` set) rather than on the closable watch's next round.
export function delegationsRouter(engine: DelegationEngine = defaultEngine, afterCleanup: () => void = refreshSpawnState): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    res.json({ delegations: await engine.list({ sessionId: parsed.data.session, active: parsed.data.active === '1' }) });
  });

  // The user's login starts the user's; the tool token, the LLM's.
  router.post('/', async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    // `hestia delegate start` (the tool token) may not pick a permission mode (ADR 0027).
    if (!permissionModeAllowed(req, parsed.data.permissionMode, res)) return;
    sendResult(res, await engine.startDelegation(parsed.data, isLoginRequest(req) ? 'user' : 'llm'), 201);
  });

  router.get('/:id', async (req, res) => {
    const found = await engine.get(req.params.id);
    if (!found) {
      sendError(res, 404, 'not_found', 'not found');
      return;
    }
    const body: DelegationDetailResponse = { delegation: found, deliveryMergedInto: await engine.deliveryMergedInto(found) };
    res.json(body);
  });

  router.post('/:id/deliver', async (req, res) => {
    const parsed = deliverSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    sendResult(res, await engine.deliver(req.params.id, parsed.data));
  });

  // The delegating LLM (tool token) reviews from its session; the user's login only sends back.
  router.post('/:id/review', async (req, res) => {
    const id = String(req.params.id);
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const { fromSessionId, ...review } = parsed.data;
    if (isLoginRequest(req)) {
      sendResult(res, await engine.review(id, review, { by: 'user' }));
      return;
    }
    if (!fromSessionId) {
      sendError(res, 403, 'login_required', 'with the local tool token, only the delegating session can review it (give fromSessionId)');
      return;
    }
    sendResult(res, await engine.review(id, review, { by: 'parent', sessionId: fromSessionId }));
  });

  router.post('/:id/cleanup', requireLogin, async (req, res) => {
    const parsed = cleanupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const result = await engine.cleanup(String(req.params.id), parsed.data);
    if (result.ok) afterCleanup();
    sendResult(res, result);
  });

  // Its CLI quit: started again with the same brief (ADR 0030).
  router.post('/:id/relaunch', requireLogin, async (req, res) => {
    sendResult(res, await engine.relaunch(String(req.params.id)));
  });
  router.post('/:id/approve', requireLogin, async (req, res) => {
    sendResult(res, await engine.approve(String(req.params.id)));
  });
  router.post('/:id/decline', requireLogin, async (req, res) => {
    sendResult(res, await engine.decline(String(req.params.id)));
  });
  router.post('/:id/accept', requireLogin, async (req, res) => {
    sendResult(res, await engine.accept(String(req.params.id)));
  });
  router.post('/:id/reject', requireLogin, async (req, res) => {
    sendResult(res, await engine.reject(String(req.params.id)));
  });
  // The user stops any; the delegating LLM (tool token) only its own, from its session.
  router.post('/:id/stop', async (req, res) => {
    const id = String(req.params.id);
    if (isLoginRequest(req)) {
      sendResult(res, await engine.stopDelegation(id, { by: 'user' }));
      return;
    }
    const parsed = stopSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    if (!parsed.data.fromSessionId) {
      sendError(res, 403, 'login_required', 'with the local tool token, only the delegating session can stop it (give fromSessionId)');
      return;
    }
    sendResult(res, await engine.stopDelegation(id, { by: 'parent', sessionId: parsed.data.fromSessionId }));
  });

  return router;
}

/** GET/PUT /delegation: the global settings. Anyone reads them; only the user's login changes them. */
export function delegationSettingsRouter(engine: DelegationEngine = defaultEngine): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json(await engine.getSettings());
  });
  router.put('/', requireLogin, async (req, res) => {
    const parsed = settingsPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    res.json(await engine.setSettings(parsed.data));
  });
  return router;
}

function sendSessionResult(res: Response, result: SessionSettingsResult): void {
  if (result.ok) {
    res.json(result.view);
    return;
  }
  sendError(res, result.status, result.code, result.message, result.params);
}

/** Mounted under /sessions: one tmux's own delegation settings. */
export function sessionDelegationRouter(engine: DelegationEngine = defaultEngine): Router {
  const router = Router();
  router.get('/:id/delegation', async (req, res) => {
    sendSessionResult(res, await engine.getSessionSettings(String(req.params.id)));
  });
  router.put('/:id/delegation', requireLogin, async (req, res) => {
    const parsed = sessionPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    sendSessionResult(res, await engine.setSessionSettings(String(req.params.id), parsed.data));
  });
  return router;
}
