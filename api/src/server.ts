import { createTranscriptRetentionRouter } from './routes/transcript-retention.js';
import { turnProcessRouter } from './routes/turn-process.js';
import express, { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { accountForRequest, isLocalRequest, mediaTokenAccount, authenticateStreamRequest } from './auth.js';
import { APP_WEBVIEW_ORIGINS, COMMAND_NAME, DEFAULT_CORS_ALLOWED_ORIGINS } from './config.js';
import type { ApiHealth } from './contract/meta.js';
import { createUsageAnalyticsRouter } from './usage-analytics/router.js';
import { accountStatusRouter } from './routes/account-status.js';
import { continuityDefaultsRouter, sessionContinuityRouter } from './routes/continuity.js';
import { delegationSettingsRouter, delegationsRouter, sessionDelegationRouter } from './routes/delegation.js';
import { permissionModeSettingsRouter, sessionPermissionModesRouter } from './routes/permission-modes.js';
import { forksRouter } from './routes/forks.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { fsRouter } from './routes/fs.js';
import { messagesRouter } from './routes/messages.js';
import { modelsRouter } from './routes/models.js';
import { metaRouter } from './routes/meta.js';
import { launchProfilesRouter } from './routes/launch-profiles.js';
import { notesRouter, tagsRouter } from './routes/notes.js';
import { paneRouter } from './routes/pane.js';
import { projectsRouter } from './routes/projects.js';
import { pushRouter } from './routes/push.js';
import { recapRouter, sessionRecapRouter } from './routes/recap.js';
import { repoRouter } from './routes/repo.js';
import { sessionsRouter } from './routes/sessions.js';
import { sessionFilesRouter } from './routes/session-files.js';
import { subagentsRouter } from './routes/subagents.js';
import { noteUploadsRouter, uploadsRouter } from './routes/uploads.js';
import { architectureRouter } from './routes/architecture.js';
import { sendError } from './routes/errors.js';
import { interfaceLocale, rememberInterfaceLocale } from './i18n/http.js';
import type { HestiaModule } from './module-host/types.js';

// Credentials that may ride in a URL, each opening only its own routes
// (paths relative to /api, matched case-sensitively and without a trailing
// slash, so anything Express would route more loosely is just refused):
// - ?ticket= opens a live stream (auth.ts's issueStreamTicket), since an
//   EventSource can't send the bearer header;
// - ?media= reads an upload (auth.ts's issueMediaToken), since an
//   <img> can't either.
// Neither is a substitute for a login anywhere else, and only GET.
export const STREAM_PATH = /^\/sessions\/(?:events|[^/]+\/(?:events|pane\/stream))$/;
// An image (`…/uploads/<file>`) or another file the composer attached
// (`…/uploads/<folder>/<name>`); routes/uploads.ts decides what exists.
const MEDIA_PATH = /^\/(?:sessions\/[^/]+\/uploads\/(?:[^/]+\/)?[^/]+|notes\/uploads\/[^/]+)$/;

function urlCredentialAccount(req: Request): ReturnType<typeof accountForRequest> {
  if (req.method !== 'GET') return null;
  const { ticket, media } = req.query;
  if (STREAM_PATH.test(req.path)) return authenticateStreamRequest(req, typeof ticket === 'string' ? ticket : undefined);
  if (typeof media === 'string' && MEDIA_PATH.test(req.path)) return mediaTokenAccount(media, isLocalRequest(req));
  return null;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const account = req.method === 'GET' && STREAM_PATH.test(req.path)
    ? urlCredentialAccount(req)
    : accountForRequest(req) ?? urlCredentialAccount(req);
  if (account) {
    next();
    return;
  }
  sendError(res, 401, 'not_authenticated', 'not authenticated');
}

// Frontends live on other origins than this API (the official web
// frontend, the Hestia app, a self-hosted copy), so the browser only lets
// them read its answers when CORS names their origin — an explicit
// allowlist, never a wildcard.
//
// Each backend serves whichever frontends its owner points at it, so the
// list comes from CORS_ALLOWED_ORIGINS (comma-separated; the installer
// writes it). Unset or blank (as .env.example leaves it) means config.ts's
// defaults: the app WebViews. A list replaces
// them whole. A "*" entry is dropped rather than honored: any site on the
// internet could then read this API's answers from a browser that holds a
// login.
const DEFAULT_ALLOWED_ORIGINS = DEFAULT_CORS_ALLOWED_ORIGINS;

export function allowedOrigins(env: string | undefined = process.env.CORS_ALLOWED_ORIGINS): Set<string> {
  if (env === undefined || env.trim() === '') return new Set(DEFAULT_ALLOWED_ORIGINS);
  const origins = new Set<string>();
  for (const raw of env.split(',')) {
    // An origin never has a path; tolerate the trailing slash people paste.
    const origin = raw.trim().replace(/\/+$/, '');
    if (!origin) continue;
    if (origin === '*') {
      console.warn('[cors] ignoring "*" in CORS_ALLOWED_ORIGINS — list each frontend origin explicitly');
      continue;
    }
    origins.add(origin);
  }
  return origins;
}

function corsFor(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => cors(allowed, req, res, next);
}

function cors(allowed: Set<string>, req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Logins are bearer tokens only (auth.ts), so no client needs
    // credentials mode. Other allowed web origins retain the historical
    // credential behavior; app WebViews always use bearer tokens and never need
    // cookies (including `https://localhost`, which any local site can use).
    if (!APP_WEBVIEW_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Credentials', 'true');
    // Tells any shared cache that the response varies by Origin — without
    // this, a cache could serve one origin's CORS headers to another.
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    // Authorization: the bearer token a cross-origin frontend sends
    // (routes/auth.ts's login hands it out).
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end();
    return;
  }
  next();
}

// DNS rebinding: a web page on some other site can point its own hostname
// at 127.0.0.1 and then talk to this API from the browser on this machine.
// That connection is direct loopback with no forwarding headers, so
// isLocalRequest treats it as local (local-only accounts, the local tool
// token) — but the browser still sends the page's own hostname as Host.
// So a request that counts as local must name a loopback host. Relayed
// requests are left alone: tailscale serve (or any relay) carries the
// public name (*.ts.net) and forwarding headers, so they are never treated
// as local anyway.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function hostnameOf(host: string | undefined): string {
  const value = (host ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1); // [::1]:4791
  // More than one colon and no brackets: a bare IPv6 address, no port.
  if (value.indexOf(':') !== value.lastIndexOf(':')) return value;
  return value.split(':')[0] ?? '';
}

function requireLoopbackHostWhenLocal(req: Request, res: Response, next: NextFunction): void {
  if (isLocalRequest(req) && !LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    sendError(res, 403, 'host_not_allowed', 'a local request must use a loopback Host (127.0.0.1 or localhost)');
    return;
  }
  next();
}

export type AppOptions = {
  // The optional modules loaded at startup (module-host/load.ts); none by default.
  modules?: readonly HestiaModule[];
};

// A message sent to a CLI can be long (a pasted document or log): its
// route takes up to 5 MB. Every other body keeps Express's 100 KB default.
const MESSAGE_BODY_LIMIT = '5mb';
const MESSAGE_SEND_PATH = /^\/api\/sessions\/[^/]+\/messages\/?$/;
const defaultBody = express.json();
const messageBody = express.json({ limit: MESSAGE_BODY_LIMIT });

// A body over its route's limit (body-parser's 'entity.too.large').
function isTooLarge(err: unknown): err is { type: 'entity.too.large'; limit: number } {
  return typeof err === 'object' && err !== null && (err as { type?: unknown }).type === 'entity.too.large';
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function createApp({ modules = [] }: AppOptions = {}): Express {
  const app = express();
  // First, before anything reads the body or answers CORS.
  app.use(requireLoopbackHostWhenLocal);
  app.use((req, res, next) => (req.method === 'POST' && MESSAGE_SEND_PATH.test(req.path) ? messageBody : defaultBody)(req, res, next));
  app.use(interfaceLocale);
  // Read once per app, like the rest of its configuration.
  app.use(corsFor(allowedOrigins()));

  // Every route lives under /api, owned by Express itself: whatever
  // forwards a request here (tailscale serve, the native app's SSH port
  // forward, a dev server's proxy) just passes /api/* through untouched.
  const apiRouter = Router();

  // Unprotected: a health probe needs to work before anyone's logged in,
  // and /auth/* obviously can't require the very session it's issuing. Its
  // command name tells the app which install a port is (contract/meta.ts);
  // not a secret — whoever reaches this path reaches the backend anyway.
  apiRouter.get('/health', (_req, res) => res.json({ ok: true, name: COMMAND_NAME } satisfies ApiHealth));
  apiRouter.use('/auth', authRouter);

  // Everything below this line requires a valid session — this is the
  // actual gate, not the frontend's login screen (which is only a UX
  // convenience; someone hitting the API directly would sail right past
  // that). See auth.ts for why.
  apiRouter.use(requireAuth);
  apiRouter.use(rememberInterfaceLocale);

  // Behind the login like the rest: which CLIs and version a backend runs
  // is nothing an anonymous caller needs.
  apiRouter.use('/meta', metaRouter(modules));
  apiRouter.use('/fs', fsRouter);
  apiRouter.use('/launch-profiles', launchProfilesRouter);
  apiRouter.use('/account-status', accountStatusRouter);
  apiRouter.use('/usage-analytics', createUsageAnalyticsRouter());
  apiRouter.use('/continuity', continuityDefaultsRouter());
  apiRouter.use('/recap', recapRouter());
  apiRouter.use('/delegation', delegationSettingsRouter());
  apiRouter.use('/delegations', delegationsRouter());
  apiRouter.use('/forks', forksRouter());
  apiRouter.use('/permission-modes', permissionModeSettingsRouter());
  apiRouter.use('/transcript-retention', createTranscriptRetentionRouter());
  // First: its GET /sessions/events must not be taken for a session id.
  apiRouter.use('/sessions', eventsRouter);
  apiRouter.use('/sessions', sessionsRouter);
  apiRouter.use('/sessions', messagesRouter);
  apiRouter.use('/sessions', modelsRouter);
  apiRouter.use('/sessions', paneRouter);
  apiRouter.use('/sessions', subagentsRouter);
  apiRouter.use('/sessions', turnProcessRouter);
  apiRouter.use('/sessions', sessionContinuityRouter());
  apiRouter.use('/sessions', sessionRecapRouter());
  apiRouter.use('/sessions', sessionDelegationRouter());
  apiRouter.use('/sessions', sessionPermissionModesRouter());
  apiRouter.use('/sessions', uploadsRouter);
  apiRouter.use('/sessions', sessionFilesRouter);
  apiRouter.use('/notes', noteUploadsRouter);
  apiRouter.use('/push', pushRouter);
  apiRouter.use('/projects', projectsRouter);
  apiRouter.use('/projects', notesRouter);
  // The optional modules' routes, behind the login, in the order they
  // list them: after the notes routes, before the repo routes.
  for (const module of modules) {
    for (const route of module.routes) apiRouter.use(route.path, route.router);
  }
  apiRouter.use('/projects', repoRouter);
  apiRouter.use('/tags', tagsRouter);
  // The maintainer's own architecture map (routes/architecture.ts): only
  // when a folder is configured, read when the app is made like the rest.
  const architectureDir = process.env.HESTIA_ARCHITECTURE_DIR?.trim();
  if (architectureDir) apiRouter.use('/architecture', architectureRouter(architectureDir));

  app.use('/api', apiRouter);

  // Express's own default handler replies with a stack trace whenever
  // NODE_ENV isn't 'production' — fine for a terminal, not for a JSON API
  // response that might reach a browser. Log the real error server-side,
  // send back nothing more than "something broke" either way. Recognized
  // as error-handling middleware by Express purely from having 4 params.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (isTooLarge(err)) {
      if (!res.headersSent) sendError(res, 413, 'request_too_large', `the request is larger than ${formatBytes(err.limit)}`, { limit: formatBytes(err.limit) });
      return;
    }
    console.error(err);
    if (res.headersSent) return;
    sendError(res, 500, 'internal_error', 'internal server error');
  });

  return app;
}
