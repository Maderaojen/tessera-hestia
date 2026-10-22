import type { Request } from 'express';
import { accountForRequest } from '../auth.js';
import { recordSessionEvent } from '../session-events.js';
import type { TransitionResult } from '../services/transitions.js';

// Who an HTTP request came from, for the session event log: the hestia
// command on this machine (its local token), or the app as the signed-in user.
function requester(req: Request): { source: 'app' | 'cli'; actor?: string } {
  const account = accountForRequest(req);
  if (!account) return { source: 'app' };
  if (account.username === 'cli' && account.localOnly) return { source: 'cli' };
  return account.username ? { source: 'app', actor: account.username } : { source: 'app' };
}

export function recordRequestEvent(req: Request, sessionId: string, action: string, result: string, detail?: Record<string, unknown>): Promise<void> {
  return recordSessionEvent({ sessionId, action, result, ...requester(req), ...(detail ? { detail } : {}) });
}

/** A transition's outcome as the event log words it: 'ok', or the refusal's code. */
export function transitionOutcome(result: TransitionResult): string {
  return result.ok ? 'ok' : result.code;
}
