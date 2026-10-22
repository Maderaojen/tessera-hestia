import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import {
  attachmentById, extensionFor, IMAGE_TYPES, mimeFor, NOTES_UPLOAD_FOLDER, safeUploadName, withPromptText,
} from '../attachments.js';
import { NOTE_UPLOAD_MAX_BYTES, UPLOADS_DIR } from '../config.js';
import { UPLOAD_MAX_BYTES, type UploadResponse } from '../contract/attachments.js';
import * as registry from '../registry.js';
import { sendError } from './errors.js';
import { acquireUpload, discardUpload, uploadStorage, UploadResourceError, commitUpload, cancelUpload, UPLOAD_TIMEOUT_MS } from '../upload-storage.js';

const IMAGE_MIME_TYPES: readonly string[] = IMAGE_TYPES.map((type) => type.mime);

export const uploadsRouter = Router();

// Stream files into private staging; admission is shared by both upload routes.
const multipartLimits = { files: 1, fields: 0, parts: 1, fieldNameSize: 100, fieldSize: 1024, headerPairs: 20 };
function boundedUpload(parser: ReturnType<typeof multer>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let release: (() => void) | undefined;
    try {
      release = await acquireUpload();
      const done = release;
      if (req.aborted || res.destroyed) { done(); return; }
      let stopped = false;
      const timer = setTimeout(() => { req.destroy(new Error('upload timeout')); }, UPLOAD_TIMEOUT_MS);
      timer.unref();
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        // Do not release an admission slot until an active disk write stops.
        void cancelUpload(req).catch(() => {}).finally(done);
      };
      req.once('aborted', stop);
      res.once('close', () => { if (!res.writableFinished) stop(); });
      res.once('finish', () => { clearTimeout(timer); done(); });
      parser.single('file')(req, res, (error: unknown) => {
        if (stopped || req.aborted || res.destroyed) { stop(); return; }
        if (error) { clearTimeout(timer); done(); next(error); return; }
        next();
      });
    } catch (error) { release?.(); next(error); }
  };
}
const sessionUpload = multer({
  storage: uploadStorage,
  // Browsers send a file's name as UTF-8; multer reads latin1 by default.
  defParamCharset: 'utf8',
  limits: { ...multipartLimits, fileSize: UPLOAD_MAX_BYTES },
});
const noteUpload = multer({
  storage: uploadStorage,
  limits: { ...multipartLimits, fileSize: NOTE_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    cb(null, IMAGE_MIME_TYPES.includes(file.mimetype));
  },
});

// Saves an uploaded file under <UPLOADS_DIR>/<sessionId>/ on this host —
// the same machine running tmux/the provider CLI — and answers with it as
// an attachment (attachments.ts), including the text a message puts in to
// make the CLI read it. See config.ts's own comment on why a file path is
// the only viable way to get real bytes to the model through a
// keystroke-simulation pipeline.
uploadsRouter.post('/:id/uploads', async (req, res, next) => {
  const sessionId = req.params.id as string;
  const session = await registry.getSession(sessionId);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.locals.uploadSessionId = session.id;
  next();
}, boundedUpload(sessionUpload), async (req, res) => {
  await saveUpload(req, res, res.locals.uploadSessionId as string, { anyFile: true });
});

// Saves the request's file under <UPLOADS_DIR>/<dirName>/ and answers with
// it as an attachment — plus, for PWAs cached before attachments, its path.
// An image is `<uuid><ext>`; any other file (`anyFile`) keeps its own name
// in a folder of its own, `<uuid>/<name>`.
async function saveUpload(req: Request, res: Response, dirName: string, options: { anyFile: boolean }): Promise<void> {
  const ext = req.file ? extensionFor(req.file.mimetype) : undefined;
  if (!req.file || (!ext && !options.anyFile)) {
    sendError(res, 400, 'upload_rejected', 'no file, or file rejected (must be one of: ' + IMAGE_MIME_TYPES.join(', ') + ')', {
      allowed: IMAGE_MIME_TYPES.join(', '),
    });
    return;
  }
  const id = ext ? `${dirName}/${randomUUID()}${ext}` : `${dirName}/${randomUUID()}/${safeUploadName(req.file.originalname)}`;
  const attachment = attachmentById(id);
  if (!attachment) { await discardUpload(req.file); throw new Error(`uploads can't be kept under ${dirName}`); }
  const filePath = path.join(UPLOADS_DIR, attachment.id);
  await commitUpload(req, req.file, filePath);
  res.status(201).json({ attachment: withPromptText(attachment), path: filePath } satisfies UploadResponse);
}

// Serves an uploaded image back to the browser for thumbnail rendering —
// the CLI's reference is a path on this machine, which a browser can't
// load directly. path.basename() on the param strips any directory
// components a request could smuggle in (e.g. `../../etc/passwd`), so the
// lookup can only ever resolve to a file directly inside this session's
// own upload directory, never outside it — req.params.id is itself
// unconstrained user input, but scoping the read to
// `<UPLOADS_DIR>/<id>/<basename>` means the worst a wrong/foreign id can
// do is a 404, not a path traversal.
uploadsRouter.get('/:id/uploads/:filename', async (req, res) => {
  const sessionId = req.params.id as string;
  const session = await registry.getSession(sessionId);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  sendUpload(res, sessionId, req.params.filename as string);
});

// Any other file a session's composer attached, as a download: never shown
// inline, whatever it holds. Only an id attachments.ts accepts is read.
uploadsRouter.get('/:id/uploads/:dir/:name', async (req, res) => {
  const session = await registry.getSession(req.params.id as string);
  const attachment = session ? attachmentById(`${session.id}/${req.params.dir as string}/${req.params.name as string}`) : null;
  if (!attachment || attachment.kind !== 'file' || !attachment.name) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'X-Content-Type-Options': 'nosniff',
  };
  res.sendFile(attachment.id, { root: UPLOADS_DIR, headers }, (err) => {
    if (err && !res.headersSent) sendError(res, 404, 'not_found', 'not found');
  });
});

// Sends <UPLOADS_DIR>/<dirName>/<basename of filename>, if it's one of the
// image types uploads accept.
function sendUpload(res: Response, dirName: string, requested: string): void {
  const filename = path.basename(requested);
  const mime = mimeFor(filename);
  if (!mime) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  // `root` (rather than handing sendFile an absolute path directly) does
  // double duty: it's what actually enforces the traversal boundary this
  // route promises (basename() above already guarantees `filename` has no
  // path separators, but this is belt-and-suspenders), and it's *required*
  // here for a real reason — 'send' (which sendFile delegates to) applies
  // its default dotfiles:'ignore' policy to every segment of an absolute
  // path with no root, and this host's real upload path runs through
  // `~/.config/...`; without root, that dotfile segment alone was causing
  // every request to 404 regardless of whether the file existed.
  // nosniff: the type was the uploader's claim, never checked against the
  // bytes, so a browser must not guess another one (HTML, say) from them.
  const headers = { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' };
  res.sendFile(path.join(dirName, filename), { root: UPLOADS_DIR, headers }, (err) => {
    if (err && !res.headersSent) sendError(res, 404, 'not_found', 'not found');
  });
}

// Images attached to notes, kept apart from any tmux session: a note can
// be written outside one (the inbox) and moved between projects, so its
// image belongs to neither. Mounted at /api/notes.
export const noteUploadsRouter = Router();

noteUploadsRouter.post('/uploads', boundedUpload(noteUpload), async (req, res) => {
  await saveUpload(req, res, NOTES_UPLOAD_FOLDER, { anyFile: false });
});

noteUploadsRouter.get('/uploads/:filename', (req, res) => {
  sendUpload(res, NOTES_UPLOAD_FOLDER, req.params.filename as string);
});

// A too-large file (or too many files) throws a MulterError that would
// otherwise fall through to server.ts's generic 500 handler — a clear 400
// is much more useful here than "internal server error" for something
// that's entirely the request's own fault. Recognized as error-handling
// middleware by Express purely from having 4 params, same as server.ts's
// own top-level one.
function multerErrorAsBadRequest(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof UploadResourceError) { sendError(res, err.status, err.code, err.message); return; }
  if (err instanceof MulterError) {
    sendError(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'upload_too_large' : 'invalid_request', err.message);
    return;
  }
  next(err);
}

uploadsRouter.use(multerErrorAsBadRequest);
noteUploadsRouter.use(multerErrorAsBadRequest);
