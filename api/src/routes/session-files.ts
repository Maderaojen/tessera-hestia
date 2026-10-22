import { Router, type Request, type Response } from 'express';
import { FileGuardError } from '@maderaojen/fs-guard';
import { z } from 'zod';
import { FILE_REF_MAX_LENGTH, FILE_REFS_MAX_PATHS, type FileRefsResponse } from '../contract/session-files.js';
import * as registry from '../registry.js';
import { allowedRoots, readSessionFile, readSessionImage, resolveFileRef, SessionFileError, type AllowedRoot } from '../files/session-files.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';

// The chat's file links (docs/specs/chat-file-links.md; contract
// session-files.ts): which paths a reply mentions are files this session
// may show, and showing one. They read files from disk, so only the user's
// own login may call them, never the local tool token a CLI holds.
export const sessionFilesRouter = Router();

async function rootsFor(req: Request, res: Response): Promise<AllowedRoot[] | null> {
  const session = await registry.getSession(String(req.params.id));
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return null;
  }
  return allowedRoots(session);
}

function sendFileError(res: Response, error: unknown): void {
  if (error instanceof SessionFileError) {
    if (error.code === 'outside') sendError(res, 403, 'path_outside_project', error.message);
    else if (error.code === 'blocked') sendError(res, 403, 'path_sensitive', error.message);
    else if (error.code === 'missing' || error.code === 'not_file') sendError(res, 404, 'path_not_found', error.message);
    else if (error.code === 'too_large') sendError(res, 413, 'unsupported_media', error.message);
    else sendError(res, 415, 'unsupported_media', error.message);
    return;
  }
  if (error instanceof FileGuardError) {
    sendError(res, 404, 'path_not_found', error.message);
    return;
  }
  throw error;
}

const refsBody = z.object({ paths: z.array(z.string().min(1).max(FILE_REF_MAX_LENGTH)).max(FILE_REFS_MAX_PATHS) });

sessionFilesRouter.post('/:id/file-refs', requireLogin, async (req, res) => {
  const parsed = refsBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const roots = await rootsFor(req, res);
  if (!roots) return;
  const inputs = [...new Set(parsed.data.paths)];
  const body: FileRefsResponse = { refs: await Promise.all(inputs.map((input) => resolveFileRef(input, roots))) };
  res.json(body);
});

const fileQuery = z.object({ path: z.string().min(1).max(FILE_REF_MAX_LENGTH) });

sessionFilesRouter.get('/:id/files', requireLogin, async (req, res) => {
  const parsed = fileQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const roots = await rootsFor(req, res);
  if (!roots) return;
  try {
    res.json(await readSessionFile(parsed.data.path, roots));
  } catch (error) {
    sendFileError(res, error);
  }
});

// Images only, as bytes the app shows from a blob URL: never SVG, HTML or
// text, nothing a browser could run, and headers that keep it so if this
// URL were opened directly.
sessionFilesRouter.get('/:id/files/raw', requireLogin, async (req, res) => {
  const parsed = fileQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const roots = await rootsFor(req, res);
  if (!roots) return;
  try {
    const { type, bytes } = await readSessionImage(parsed.data.path, roots);
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  } catch (error) {
    sendFileError(res, error);
  }
});
