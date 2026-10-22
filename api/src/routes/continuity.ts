import { Router, type Response } from 'express';
import { z } from 'zod';
import { CONTINUITY_MODES, HANDOFF_CONFIRMS, HANDOFF_SOURCES } from '../contract/continuity.js';
import type { Continuity, ContinuityResult } from '../continuity/engine.js';
import { continuity as defaultContinuity } from '../continuity/wiring.js';
import * as registry from '../registry.js';
import { readHandoffBrief } from '../continuity/brief-file.js';
import { knownHandoffs, lookUpHandoff } from '../continuity/brief-lookup.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';
import { PERMISSION_MODES } from '../contract/permissions.js';
import { permissionModeAllowed } from './permission-modes.js';

// Carrying a conversation on after a usage limit.
// The engine is passed in so tests can drive one of their own.
//
// The settings (the defaults, and a session's own) are read with either
// token but changed only with the user's login (routes/login-guard.ts): an
// LLM in a tmux, holding the local tool token, may not change how its own
// usage limit is handled. Starting, confirming or cancelling a handoff is
// an action on the session, not a setting, and takes either token.

const fields = {
  mode: z.enum(CONTINUITY_MODES as [string, ...string[]]),
  resumePrompt: z.string().trim().min(1).max(2000),
  resumeDelaySeconds: z.number().int().min(0).max(3600),
  maxAutoResumesPerDay: z.number().int().min(0).max(50),
  chain: z.array(z.string().min(1).max(200)).max(20),
  softRemainingPercent: z.number().int().min(0).max(100),
  hardRemainingPercent: z.number().int().min(0).max(100),
  handoffSource: z.enum(HANDOFF_SOURCES as [string, ...string[]]),
  handoffConfirm: z.enum(HANDOFF_CONFIRMS as [string, ...string[]]),
  selfBriefTimeoutSeconds: z.number().int().min(30).max(1800),
};

const defaultsPatch = z.object(Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()]))).strict();
const sessionPatch = z.object(Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.nullable().optional()]))).strict();
const handoffRequest = z.object({
  toProfileId: z.string().min(1).optional(),
  interrupt: z.boolean().optional(),
  briefBy: z.enum(['current', 'incoming']).optional(),
  afterReport: z.enum(['wait', 'continue']).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
}).strict();

const relaunchRequest = z.object({
  briefFile: z.string().min(1).max(1000),
  toProfileId: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
}).strict();

function thresholdsInOrder(patch: Record<string, unknown>): boolean {
  const { softRemainingPercent: soft, hardRemainingPercent: hard } = patch;
  return typeof soft !== 'number' || typeof hard !== 'number' || hard <= soft;
}

function sendResult(res: Response, result: ContinuityResult): void {
  if (result.ok) {
    res.json(result.view);
    return;
  }
  sendError(res, result.status, result.code, result.message, result.params);
}

/** GET/PUT /continuity: the defaults every session follows unless it chose otherwise. */
export function continuityDefaultsRouter(engine: Continuity = defaultContinuity): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json({ defaults: await engine.getDefaults() });
  });
  router.put('/', requireLogin, async (req, res) => {
    const parsed = defaultsPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const merged = { ...(await engine.getDefaults()), ...parsed.data };
    if (!thresholdsInOrder(merged)) {
      sendError(res, 400, 'invalid_request', 'hardRemainingPercent must not be above softRemainingPercent');
      return;
    }
    res.json({ defaults: await engine.setDefaults(parsed.data) });
  });
  return router;
}

/** Mounted under /sessions: one session's policy, pending carry-on, handoff and history. */
export function sessionContinuityRouter(engine: Continuity = defaultContinuity): Router {
  const router = Router();
  router.use('/:id/continuity', async (req, res, next) => {
    if (await registry.getSession(req.params.id)) {
      next();
      return;
    }
    sendError(res, 404, 'not_found', 'not found');
  });
  router.get('/:id/continuity', async (req, res) => {
    res.json(await engine.getSession(req.params.id));
  });
  router.put('/:id/continuity', requireLogin, async (req, res) => {
    const parsed = sessionPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const current = (await engine.getSession(String(req.params.id))).effective;
    const merged = { ...current, ...Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== null)) };
    if (!thresholdsInOrder(merged)) {
      sendError(res, 400, 'invalid_request', 'hardRemainingPercent must not be above softRemainingPercent');
      return;
    }
    res.json(await engine.setSession(String(req.params.id), parsed.data));
  });
  router.delete('/:id/continuity/pending', async (req, res) => {
    res.json(await engine.cancelPending(req.params.id));
  });
  router.post('/:id/continuity/handoff', async (req, res) => {
    const parsed = handoffRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    // Starting one takes either token; choosing its permission mode only the login (ADR 0027).
    if (!permissionModeAllowed(req, parsed.data.permissionMode, res)) return;
    sendResult(res, await engine.startHandoff(req.params.id, parsed.data));
  });
  router.post('/:id/continuity/handoff/confirm', async (req, res) => {
    sendResult(res, await engine.confirmHandoff(req.params.id));
  });
  // A handoff brief, by the handoff's id: only one of this session's handoffs, only from its folder's
  // .hestia/handoffs, and only for the user's own login — an LLM in a tmux
  // reads its own files itself.
  router.get('/:id/continuity/handoffs/:handoffId/brief', requireLogin, async (req, res) => {
    const session = await registry.getSession(String(req.params.id));
    if (!session) {
      sendError(res, 404, 'not_found', 'not found');
      return;
    }
    const continuity = await engine.getSession(session.id);
    const known = knownHandoffs({ current: continuity.handoff, segments: (session.conversations ?? []).map((conversation) => conversation.handoff), history: continuity.history });
    const found = lookUpHandoff(known, String(req.params.handoffId));
    if (found.kind === 'invalid') {
      sendError(res, 400, 'invalid_request', 'not a handoff id');
      return;
    }
    if (found.kind === 'unknown') {
      sendError(res, 404, 'not_found', 'no such handoff in this session');
      return;
    }
    if (found.kind === 'ambiguous') {
      sendError(res, 409, 'handoff_brief_ambiguous', 'that short id fits more than one of this session\'s handoffs');
      return;
    }
    const brief = await readHandoffBrief(session.cwd, { briefFile: found.briefFile, shortId: found.shortId });
    if (!brief.ok) {
      if (brief.reason === 'missing') sendError(res, 404, 'handoff_brief_missing', 'the brief is no longer there');
      else sendError(res, 409, 'handoff_brief_unsafe', 'the brief is not a plain file in the session\'s .hestia/handoffs');
      return;
    }
    res.json({ handoffId: found.handoffId, file: brief.file, content: brief.content, truncated: brief.truncated, size: brief.size, modifiedAt: brief.modifiedAt });
  });
  router.post('/:id/continuity/handoff/dismiss', async (req, res) => {
    sendResult(res, await engine.dismissHandoff(req.params.id));
  });
  router.post('/:id/continuity/handoff/force-switch', async (req, res) => {
    sendResult(res, await engine.forceHandoffSwitch(req.params.id));
  });
  router.post('/:id/continuity/handoff/interrupt', async (req, res) => {
    sendResult(res, await engine.interruptHandoff(req.params.id));
  });
  router.post('/:id/continuity/handoff/skip-brief', async (req, res) => {
    sendResult(res, await engine.skipHandoffBrief(req.params.id));
  });
  router.delete('/:id/continuity/handoff', async (req, res) => {
    res.json(await engine.cancelHandoff(req.params.id));
  });
  // A handoff whose CLI never took over (ADR 0030): start it again with the
  // same brief, or forget it. Either token, as starting one; choosing the
  // permission mode only the login.
  router.post('/:id/continuity/handoff/relaunch', async (req, res) => {
    const parsed = relaunchRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    if (!permissionModeAllowed(req, parsed.data.permissionMode, res)) return;
    sendResult(res, await engine.relaunchHandoff(req.params.id, parsed.data));
  });
  router.delete('/:id/continuity/handoff/failed', async (req, res) => {
    res.json(await engine.dismissFailedHandoff(req.params.id));
  });
  return router;
}
