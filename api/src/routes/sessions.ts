import { withTurnProcess } from '../process/service.js';
import { Router } from 'express';
import { z } from 'zod';
import * as projectStore from '../project-store.js';
import * as registry from '../registry.js';
import * as sessionService from '../services/sessions.js';
import * as transitions from '../services/transitions.js';
import { accountLimitedUntil } from '../continuity/wiring.js';
import { sendTransitionResult } from './transition-response.js';
import { recordRequestEvent, transitionOutcome } from './session-event.js';
import { toPublicConversation, toPublicManagedSession, toTrashedSessionDto } from '../session-dto.js';
import type { TrashedSessionList } from '../contract/index.js';
import { sendError } from './errors.js';
import { PERMISSION_MODES } from '../contract/permissions.js';
import { permissionModeAllowed } from './permission-modes.js';
import { InvalidSearchCursorError, searchPersistedSessions } from '../services/session-search.js';

export const sessionsRouter = Router();

// Into a project by name (joined if one has it, else created — the
// new-session flow), or straight into an existing one by id (opening a tmux
// from a project).
const createSchema = z.union([
  z.object({ cwd: z.string().min(1), projectName: z.string().trim().min(1) }),
  z.object({ cwd: z.string().min(1), projectId: z.string().min(1) }),
]);

sessionsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  let project: projectStore.Project | undefined;
  if ('projectId' in parsed.data) {
    project = parsed.data.projectId === projectStore.INBOX_PROJECT_ID ? undefined : await projectStore.getProject(parsed.data.projectId);
    if (!project) {
      sendError(res, 404, 'project_not_found', 'project not found');
      return;
    }
  } else {
    project = await projectStore.resolveOrCreateProjectByName(parsed.data.projectName);
  }
  const session = await sessionService.createSession(parsed.data.cwd, project.id);
  await recordRequestEvent(req, session.id, 'create', 'ok', { cwd: parsed.data.cwd });
  res.status(201).json(toPublicManagedSession(session));
});

sessionsRouter.get('/', async (_req, res) => {
  await sessionService.reconcileWithTmux();
  res.json((await registry.listSessions()).map(toPublicManagedSession));
});

const searchSchema = z.object({
  q: z.string().transform((value) => value.trim().normalize('NFC')).pipe(z.string().min(1).refine((value) => Array.from(value).length <= 128)),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1024).optional(),
  sessionId: z.string().min(1).max(256).optional(),
});

sessionsRouter.get('/search', async (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'invalid search parameters');
    return;
  }
  try {
    const sessions = await registry.listSessions();
    const scoped = parsed.data.sessionId ? sessions.filter((session) => session.id === parsed.data.sessionId) : sessions;
    res.json(searchPersistedSessions(scoped, parsed.data.q, parsed.data.limit, parsed.data.cursor));
  } catch (error) {
    if (!(error instanceof InvalidSearchCursorError)) throw error;
    sendError(res, 400, 'invalid_request', error.message);
  }
});

// The trash: the sessions deleted from one project (`projectId`), or from
// every project — including ones since deleted — without it. Newest
// deletion first. Before GET /:id, which would otherwise read "trash" as a
// session id.
const trashSchema = z.object({ projectId: z.string().min(1).optional() });

sessionsRouter.get('/trash', async (req, res) => {
  const parsed = trashSchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'invalid projectId');
    return;
  }
  const { projectId } = parsed.data;
  const sessions = (await registry.listTrashedSessions())
    .filter((session) => projectId === undefined || session.projectId === projectId)
    .map(toTrashedSessionDto)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  res.json({ sessions } satisfies TrashedSessionList);
});

sessionsRouter.get('/:id', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.json(toPublicManagedSession(session));
});

sessionsRouter.get('/:id/conversations/:conversationId', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const conversation = await registry.getConversation(session.id, req.params.conversationId);
  if (!conversation) {
    sendError(res, 404, 'conversation_not_found', 'conversation not found');
    return;
  }
  // Each latest turn's process, read from the transcript for this request
  // only (capability turn_process; process/service.ts).
  res.json(await withTurnProcess(session, conversation, toPublicConversation(conversation)));
});

// The app's "關閉此 tmux": the CLI is asked to exit first, then the tmux
// ends; the record stays, listed as ended (services/sessions.ts
// closeSession). When the CLI can't be asked, or didn't exit in time, the
// user decides whether to `force` it.
const closeSchema = z.object({ force: z.boolean().optional() });

sessionsRouter.post('/:id/close', async (req, res) => {
  const parsed = closeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const result = await sessionService.closeSession(req.params.id, { force: parsed.data.force });
  await recordRequestEvent(req, req.params.id, parsed.data.force ? 'close_force' : 'close', result.status);
  switch (result.status) {
    case 'closed':
      res.json(toPublicManagedSession(result.session));
      return;
    case 'not_found':
      sendError(res, 404, 'not_found', 'not found');
      return;
    case 'in_transition':
      sendError(res, 409, 'transition_in_progress', 'another launch, restart, switch or close is in progress');
      return;
    case 'cli_busy':
      sendError(res, 409, 'close_cli_busy', 'the CLI is replying and cannot be interrupted safely; close it by force, or wait');
      return;
    case 'exit_unverified':
      sendError(res, 409, 'close_exit_unverified', 'the CLI did not exit in time; close it by force, or cancel');
      return;
  }
});

// Moves the session to its project's trash (its tmux ends). Idempotent: an
// unknown or already-deleted id answers the same.
sessionsRouter.delete('/:id', async (req, res) => {
  const removed = await sessionService.removeSession(req.params.id);
  if (removed) await recordRequestEvent(req, req.params.id, 'delete', 'ok');
  res.status(204).end();
});

// Takes a session back out of the trash, as an ended tmux: nothing is
// relaunched; the user recovers it from there like any other dead session.
sessionsRouter.post('/:id/restore', async (req, res) => {
  const restored = await registry.restoreSession(req.params.id);
  await recordRequestEvent(req, req.params.id, 'restore', restored === undefined ? 'not_found' : restored === null ? 'session_not_trashed' : 'ok');
  if (restored === undefined) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (restored === null) {
    sendError(res, 409, 'session_not_trashed', 'the session is not in the trash');
    return;
  }
  res.json(toPublicManagedSession(restored));
});

// Deletes a trashed session's record for good. The dialogue archive and
// the CLI's own transcripts on disk are left alone.
sessionsRouter.post('/:id/purge', async (req, res) => {
  const purged = await registry.purgeSession(req.params.id);
  await recordRequestEvent(req, req.params.id, 'purge', purged === undefined ? 'not_found' : purged === null ? 'session_not_trashed' : 'ok');
  if (purged === undefined) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (purged === null) {
    sendError(res, 409, 'session_not_trashed', 'the session is not in the trash');
    return;
  }
  res.status(204).end();
});

// Only the user-facing alias, deliberately — nothing else about a session
// is meant to be edited after the fact through this route.
const renameSchema = z.object({ alias: z.string().trim().min(1).max(200).nullable() });

sessionsRouter.patch('/:id', async (req, res) => {
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const updated = await registry.updateSession(session.id, { alias: parsed.data.alias });
  res.json(updated ? toPublicManagedSession(updated) : undefined);
});

const launchSchema = z.object({
  profileId: z.string().min(1).max(512),
  name: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

sessionsRouter.post('/:id/launch', async (req, res) => {
  const parsed = launchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'launch_profile_invalid', 'invalid launch profile');
    return;
  }
  // Only the user picks how much a CLI may do unasked (ADR 0027).
  if (!permissionModeAllowed(req, parsed.data.permissionMode, res)) return;
  const result = await transitions.launch(req.params.id, parsed.data);
  await recordRequestEvent(req, req.params.id, 'launch', transitionOutcome(result), {
    profileId: parsed.data.profileId, permissionMode: result.ok ? result.permissionMode : parsed.data.permissionMode ?? null,
    ...(result.ok && result.permissionFallbackFrom ? { permissionFallbackFrom: result.permissionFallbackFrom } : {}),
  });
  sendTransitionResult(res, result);
});

// Give up on a launch still waiting for its startup to be confirmed.
sessionsRouter.post('/:id/launch/cancel', async (req, res) => {
  const result = await transitions.cancelLaunch(req.params.id);
  await recordRequestEvent(req, req.params.id, 'launch_cancel', transitionOutcome(result));
  sendTransitionResult(res, result);
});

// Resume the exact active conversation of this dead managed tmux, for a
// runtime that can (the session DTO's `recoverable`). Request data
// intentionally carries no provider id, executable, profile, or path: those
// are private registry snapshots.
//
// /recover-claude is the path from when only Claude could be recovered,
// still called by frontends cached before contract v1 (deprecated in batch
// 8c; see docs/reference/api-contract-v1.md).
sessionsRouter.post(['/:id/recover', '/:id/recover-claude'], async (req, res) => {
  if (Object.keys(req.body ?? {}).length !== 0) {
    sendError(res, 400, 'recovery_params_forbidden', 'recovery request must not include launch parameters');
    return;
  }
  const result = await transitions.recoverDeadSession(String(req.params.id), { accountLimitedUntil });
  await recordRequestEvent(req, String(req.params.id), 'recover', transitionOutcome(result));
  sendTransitionResult(res, result);
});

sessionsRouter.post('/:id/conversations/:conversationId/resume', async (req, res) => {
  const result = await transitions.switchConversation(req.params.id, req.params.conversationId, { accountLimitedUntil });
  await recordRequestEvent(req, req.params.id, 'switch', transitionOutcome(result), { conversationId: req.params.conversationId });
  sendTransitionResult(res, result);
});

sessionsRouter.post('/:id/conversation-switch/force', async (req, res) => {
  const result = await transitions.forceConversationSwitch(req.params.id);
  await recordRequestEvent(req, req.params.id, 'switch_force', transitionOutcome(result));
  sendTransitionResult(res, result);
});

sessionsRouter.post('/:id/conversation-switch/cancel', async (req, res) => {
  const result = await transitions.cancelConversationSwitch(req.params.id);
  await recordRequestEvent(req, req.params.id, 'switch_cancel', transitionOutcome(result));
  sendTransitionResult(res, result);
});
