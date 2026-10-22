import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { GLOBAL_PERMISSION_MODES, PERMISSION_MODES, type PermissionMode } from '../contract/permissions.js';
import { RUNTIME_IDS } from '../contract/runtimes.js';
import * as registry from '../registry.js';
import { permissionModes as defaultService, type PermissionModeService, type SettingsResult } from '../permission-modes/service.js';
import { sendError } from './errors.js';
import { isLoginRequest, requireLogin } from './login-guard.js';

// Launch permission modes.
// Anyone reads the settings; only the user's login changes them, or picks
// a mode for one launch: an LLM holding the local tool token may not raise
// how much a CLI — its own delegate included — may do unasked.

const runtimeKeys = (values: readonly [string, ...string[]]) => z.object(Object.fromEntries(
  RUNTIME_IDS.map((runtimeId) => [runtimeId, z.enum(values).nullable().optional()]),
)).strict();

// yolo is not among the global values: refused by the schema.
const defaultsPatch = z.object({ defaults: runtimeKeys(GLOBAL_PERMISSION_MODES) }).strict();
const sessionPatch = z.object({ override: runtimeKeys(PERMISSION_MODES) }).strict();

/**
 * Whether this request may carry `permissionMode`: only with the user's
 * login. Answers 403 itself when not.
 */
export function permissionModeAllowed(req: Request, permissionMode: PermissionMode | undefined, res: Response): boolean {
  if (permissionMode === undefined || isLoginRequest(req)) return true;
  sendError(res, 403, 'login_required', 'only the user\'s own login can choose a permission mode, not the local tool token');
  return false;
}

function send<T>(res: Response, result: SettingsResult<T>): void {
  if (result.ok) {
    res.json(result.view);
    return;
  }
  sendError(res, result.status, result.code, result.message, result.params);
}

/** GET/PUT /permission-modes: each runtime's global default. */
export function permissionModeSettingsRouter(service: PermissionModeService = defaultService): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json(await service.getSettings());
  });
  router.put('/', requireLogin, async (req, res) => {
    const parsed = defaultsPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    send(res, await service.setDefaults(parsed.data as Parameters<PermissionModeService['setDefaults']>[0]));
  });
  return router;
}

/** Mounted under /sessions: one tmux's own modes. */
export function sessionPermissionModesRouter(service: PermissionModeService = defaultService): Router {
  const router = Router();
  router.use('/:id/permission-modes', async (req, res, next) => {
    if (await registry.getSession(String(req.params.id))) {
      next();
      return;
    }
    sendError(res, 404, 'not_found', 'not found');
  });
  router.get('/:id/permission-modes', async (req, res) => {
    res.json(await service.getSession(String(req.params.id)));
  });
  router.put('/:id/permission-modes', requireLogin, async (req, res) => {
    const parsed = sessionPatch.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    send(res, await service.setSession(String(req.params.id), parsed.data as Parameters<PermissionModeService['setSession']>[1]));
  });
  return router;
}
