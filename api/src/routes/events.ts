import { Router, type Request } from 'express';
import type { ConversationRecapEvent } from '../contract/recap.js';
import { observeRecap } from '../recap/events.js';
import * as registry from '../registry.js';
import * as sessionStream from '../session-stream.js';
import type { SessionListEvent } from '../contract/sessions.js';
import { toPublicManagedSession, toSessionDto, withoutLegacyFields } from '../session-dto.js';
import { openSse } from './sse.js';
import { sendError } from './errors.js';

export const eventsRouter = Router();

// Event types a client asks for on top of the session events, as
// `?include=recap` (comma-separated). Only a client that knows a type gets
// it: clients from before the trash take an event they don't know on the
// list stream for a deleted session.
function included(req: Request): Set<string> {
  const values = ([] as unknown[]).concat(req.query.include ?? []);
  return new Set(values.flatMap((value) => (typeof value === 'string' ? value.split(',').map((part) => part.trim()) : [])));
}

// Every session, for the session lists (contract v1): the whole list on
// connect, then each change as it is published — what the lists used to
// poll GET /sessions for every few seconds. Subscribed before the list is
// read, and whatever arrives meanwhile is sent after it, so no change falls
// between the two. An EventSource reconnects on its own and gets a fresh
// snapshot, so nothing missed while disconnected stays missed.
// Mounted ahead of the per-session routes (server.ts): /sessions/events
// would otherwise read as a session id.
eventsRouter.get('/events', async (req, res) => {
  const send = openSse(req, res);
  let backlog: (SessionListEvent | ConversationRecapEvent)[] | null = [];
  const forward = (next: SessionListEvent | ConversationRecapEvent) => {
    if (backlog) backlog.push(next);
    else send(next);
  };
  const unsubscribe = sessionStream.observeAll((sessionId, event) => {
    forward(event.type === 'deleted'
      ? { type: 'deleted', sessionId }
      : { type: event.type, session: withoutLegacyFields(event.session) });
  });
  const unsubscribeRecap = included(req).has('recap') ? observeRecap(forward) : () => {};
  req.on('close', () => {
    unsubscribe();
    unsubscribeRecap();
  });
  const sessions = await registry.listSessions();
  send({ type: 'snapshot', sessions: sessions.map(toSessionDto) } satisfies SessionListEvent);
  for (const event of backlog) send(event);
  backlog = null;
});

// Push-based replacement for the frontend polling GET /sessions/:id on a
// timer: subscribes to registry.updateSession's own publish call (see
// session-stream.ts), so a state change reaches the client the moment the
// backend itself notices it, without an extra frontend-side poll interval
// stacked on top. Sends the current state immediately on connect, then
// again only on each real change.
eventsRouter.get('/:id/events', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }

  const send = openSse(req, res);
  send({ type: 'update', session: toPublicManagedSession(session) });

  const unsubscribe = sessionStream.subscribe(session.id, (event) => {
    send(event);
    if (event.type === 'deleted') res.end();
  });
  const unsubscribeRecap = included(req).has('recap')
    ? observeRecap((event) => { if (event.sessionId === session.id) send(event); })
    : () => {};
  req.on('close', () => {
    unsubscribe();
    unsubscribeRecap();
  });
});
