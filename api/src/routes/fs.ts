import { Router } from 'express';
import { FsBrowserError, listDirectory, searchDirectories } from '../fs-browser.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';

// The folder picker's directory listing and search. Only the user's login,
// never the local tool token (an LLM in a tmux has its own shell).
export const fsRouter = Router();
fsRouter.use(requireLogin);

fsRouter.get('/', async (req, res) => {
  const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const listing = await (typeof req.query.base === 'string' ? listDirectory(requestedPath, req.query.base) : listDirectory(requestedPath));
    res.json(listing);
  } catch (err) {
    if (err instanceof FsBrowserError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400;
      const code = err.code === 'NOT_FOUND' ? 'path_not_found' : err.code === 'FORBIDDEN' ? 'path_forbidden' : 'path_not_a_directory';
      sendError(res, status, code, err.message);
      return;
    }
    throw err;
  }
});

fsRouter.get('/search', async (req, res) => {
  const query = req.query.query;
  const requestedPath = req.query.path;
  if (typeof query !== 'string' || query.length === 0 || query.length > 1024 || typeof requestedPath !== 'string' || requestedPath.length > 4096 || query.includes('\0') || requestedPath.includes('\0')) {
    sendError(res, 400, 'invalid_request', 'Expected a path and a non-empty query'); return;
  }
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try { res.json(await searchDirectories(requestedPath, query, { signal: controller.signal })); }
  catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof FsBrowserError) { sendError(res, err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_FOUND' ? 404 : 400, err.code === 'NOT_FOUND' ? 'path_not_found' : err.code === 'FORBIDDEN' ? 'path_forbidden' : 'path_not_a_directory', err.message); return; }
    throw err;
  } finally { res.off('close', cancel); }
});
