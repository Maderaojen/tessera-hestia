import type { Response } from 'express';
import type { TransitionResult } from '../services/transitions.js';
import { sendError } from './errors.js';
import { toPublicManagedSession } from '../session-dto.js';

// A transition's outcome (services/transitions.ts) as the response the
// routes send: the error (routes/errors.ts) with its status, or the session.
export function sendTransitionResult(res: Response, result: TransitionResult): void {
  if (!result.ok) {
    sendError(res, result.status, result.code, result.error, result.params);
    return;
  }
  res.status(result.status).json(result.session ? toPublicManagedSession(result.session) : undefined);
}
