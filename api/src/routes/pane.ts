import { Router } from 'express';
import { subscribe } from '../pane-stream.js';
import * as registry from '../registry.js';
import * as tmuxCli from '../tmux.js';
import { openSse } from './sse.js';
import { sendError } from './errors.js';

export const paneRouter = Router();

// Read-only "watch the terminal" surface — never accepts input. Separate
// from /respond and /messages by design, so the viewing boundary stays
// crisp (see conversation notes / docs/reference/human-in-the-loop.md on why this
// complements, rather than replaces, structured pending-interaction
// detection: the human can just look at whatever's actually on screen).

function parsePaneQuery(req: { query: Record<string, unknown> }): { history?: number; ansi: boolean } | null {
  const linesParam = req.query.lines;
  let history: number | undefined;
  if (typeof linesParam === 'string' && linesParam.length > 0) {
    const n = Number(linesParam);
    if (!Number.isFinite(n) || n <= 0) return null;
    history = Math.floor(n);
  }
  const ansiParam = req.query.ansi;
  const ansi = ansiParam !== '0' && ansiParam !== 'false';
  return { history, ansi };
}

// Deprecated (contract v1): the terminal view uses /pane/stream. Kept only
// for older clients; see docs/reference/api-contract-v1.md.
paneRouter.get('/:id/pane', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (session.status === 'dead') {
    sendError(res, 410, 'session_dead', 'session is dead');
    return;
  }

  const parsed = parsePaneQuery(req);
  if (!parsed) {
    sendError(res, 400, 'invalid_request', 'lines must be a positive number');
    return;
  }

  try {
    const [content, size] = await Promise.all([
      tmuxCli.capturePane(session.tmuxName, parsed),
      tmuxCli.getPaneSize(session.tmuxName),
    ]);
    res.json({
      content,
      cols: size?.cols ?? 0,
      rows: size?.rows ?? 0,
      ansi: parsed.ansi,
      history: parsed.history ?? null,
      capturedAt: new Date().toISOString(),
    });
  } catch {
    sendError(res, 410, 'pane_gone', 'pane is no longer available');
  }
});

// SSE: an update event fires immediately with the current snapshot, then
// again only when the captured pane content actually changes. Several
// clients watching the same session/params share one underlying poll loop
// (see pane-stream.ts) — this endpoint starts/stops its subscription with
// the HTTP connection's own lifetime.
paneRouter.get('/:id/pane/stream', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (session.status === 'dead') {
    sendError(res, 410, 'session_dead', 'session is dead');
    return;
  }

  const parsed = parsePaneQuery(req);
  if (!parsed) {
    sendError(res, 400, 'invalid_request', 'lines must be a positive number');
    return;
  }

  const send = openSse(req, res);
  const unsubscribe = subscribe(session.tmuxName, parsed, send);
  req.on('close', unsubscribe);
});
