import type { NextFunction, Request, Response } from 'express';
import { sessionAccountForRequest } from '../auth.js';
import { sendError } from './errors.js';

// For what only the user may decide (ADR 0015 決策 5, 10): accepting or
// rejecting delivered work, and changing what an LLM may do. Behind
// server.ts's requireAuth, which also lets the local tool token in (the
// `hestia` command, and so any LLM in a tmux); this lets only a login
// through. A guardrail against a well-meaning LLM, not a security boundary:
// it runs as the same user.
export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (sessionAccountForRequest(req)) {
    next();
    return;
  }
  sendError(res, 403, 'login_required', 'only the user\'s own login can do this, not the local tool token');
}

/** Whether the request carries the user's own login (not the local tool token). */
export function isLoginRequest(req: Request): boolean {
  return !!sessionAccountForRequest(req);
}
