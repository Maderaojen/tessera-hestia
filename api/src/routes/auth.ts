import os from 'node:os';
import { requireLogin } from './login-guard.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  persistSessionRevocations,
  listLoginSessions,
  revokeLoginSession,
  isLocalRequest,
  isLoginLocked,
  loginSource,
  issueSessionToken,
  issueMediaToken,
  issuePairingCode,
  issueStreamTicket,
  isLocalToolRequest,
  recordLoginFailure,
  recordLoginSuccess,
  pairingStatus,
  redeemPairingCode,
  revokePairing,
  cancelPairingCode,
  revokeToken,
  sessionAccountForRequest,
  sessionForRequest,
  sessionTokensOf,
  verifyCredentials,
} from '../auth.js';
import { MEDIA_TOKEN_TTL_MS, PAIRING_CODE_TTL_MS, STREAM_TICKET_TTL_MS } from '../config.js';
import { sendError } from './errors.js';

export const authRouter = Router();

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

authRouter.post('/login', async (req, res) => {
  const source = loginSource(req);
  if (isLoginLocked(source)) {
    sendError(res, 429, 'too_many_attempts', 'too many failed attempts — try again later');
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'credentials_required', 'username and password are required');
    return;
  }
  // Charged as a failure before verifying, taken back on success: the check
  // is async now, so without this a burst of parallel guesses would all get
  // past isLoginLocked above before the first one's failure was counted.
  recordLoginFailure(source);
  const account = await verifyCredentials(parsed.data.username, parsed.data.password);
  // A local-only account from outside answers exactly like a wrong
  // password: nothing tells a remote caller the account exists.
  if (!account || (account.localOnly && !isLocalRequest(req))) {
    sendError(res, 401, 'invalid_credentials', 'incorrect username or password');
    return;
  }
  recordLoginSuccess(source);
  const token = issueSessionToken(account);
  // The token goes in the body only, and comes back as `Authorization:
  // Bearer`. Never as a cookie: a browser would attach it to requests any
  // other site makes too (a form posted from anywhere needs no preflight),
  // and only an allowed origin (CORS, server.ts) can read this body.
  res.json({ ok: true, token });
});

// A pairing code for `hestia pair` (auth.ts's issuePairingCode):
// only the local tool, over a direct local connection, can ask — a phone
// that's logged in can't mint more ways in.
authRouter.post('/pairing-code', (req, res) => {
  if (!isLocalToolRequest(req)) {
    sendError(res, 401, 'not_authenticated', 'not authenticated');
    return;
  }
  res.json({ code: issuePairingCode(), expiresInMs: PAIRING_CODE_TTL_MS });
});

// What became of a code `hestia pair` showed (auth.ts's pairingStatus),
// and taking back the login a phone got with it: only the local tool,
// like asking for one — it holds the code already.
const pairingCodeSchema = z.object({ code: z.string().min(1).max(64) });

authRouter.post('/pairing-code/status', (req, res) => {
  if (!isLocalToolRequest(req)) {
    sendError(res, 401, 'not_authenticated', 'not authenticated');
    return;
  }
  const parsed = pairingCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'code is required');
    return;
  }
  res.json(pairingStatus(parsed.data.code));
});

// Taking back a code before anyone used it (auth.ts's cancelPairingCode).
authRouter.post('/pairing-code/cancel', (req, res) => {
  if (!isLocalToolRequest(req)) {
    sendError(res, 401, 'not_authenticated', 'not authenticated');
    return;
  }
  const parsed = pairingCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'code is required');
    return;
  }
  res.json({ ok: true, cancelled: cancelPairingCode(parsed.data.code) });
});

authRouter.post('/pairing-code/revoke', async (req, res) => {
  if (!isLocalToolRequest(req)) {
    sendError(res, 401, 'not_authenticated', 'not authenticated');
    return;
  }
  const parsed = pairingCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'code is required');
    return;
  }
  const revoked = revokePairing(parsed.data.code);
  if (revoked) await persistSessionRevocations();
  res.json({ ok: true, revoked });
});

// A scanned pairing code, traded once for a login token of the main
// account — answered like POST /login. A wrong code counts against the
// same lockout as a wrong password. `device` is what the phone calls
// itself, only shown back to `hestia pair`.
const pairSchema = z.object({ code: z.string().min(1).max(64), device: z.string().max(200).optional() });

authRouter.post('/pair', (req, res) => {
  const source = loginSource(req);
  if (isLoginLocked(source)) {
    sendError(res, 429, 'too_many_attempts', 'too many failed attempts — try again later');
    return;
  }
  const parsed = pairSchema.safeParse(req.body);
  const token = parsed.success ? redeemPairingCode(parsed.data.code, parsed.data.device) : null;
  if (!token) {
    recordLoginFailure(source);
    sendError(res, 401, 'invalid_pairing_code', 'the pairing code is wrong, used or expired');
    return;
  }
  recordLoginSuccess(source);
  res.json({ ok: true, token });
});

authRouter.post('/logout', async (req, res) => {
  let revoked = false;
  for (const token of sessionTokensOf(req)) revoked = revokeToken(token) || revoked;
  if (revoked) await persistSessionRevocations();
  res.json({ ok: true });
});

// Who is logged in, and on which host, only once the caller is: the
// frontend's account menu names the backend it talks to (a frontend may
// one day talk to several). Nothing about the account is shown to anyone
// who isn't logged in.
authRouter.get('/status', (req, res) => {
  const account = sessionAccountForRequest(req);
  if (!account) {
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, username: account.username, host: os.hostname() });
});

// A one-use ticket for opening one live stream (EventSource can't send the
// bearer header; see auth.ts's issueStreamTicket). Asked for with the
// caller's normal credentials, so it's never a way in by itself.
authRouter.post('/stream-ticket', (req, res) => {
  const ticket = issueStreamTicket(req);
  if (!ticket) {
    sendError(res, 401, 'not_authenticated', 'not authenticated');
    return;
  }
  res.json({ ticket, expiresInMs: STREAM_TICKET_TTL_MS });
});

// A token for loading uploaded images with a plain <img> (see auth.ts's
// issueMediaToken). Only for a login token: it's tied to that
// login so logging out ends it.
authRouter.post('/media-token', (req, res) => {
  const session = sessionForRequest(req);
  if (!session) {
    sendError(res, 401, 'not_authenticated', 'not authenticated');
    return;
  }
  res.json({ token: issueMediaToken(session.token, session.account), expiresInMs: MEDIA_TOKEN_TTL_MS });
});

// Session IDs are separate from credential digests and never authenticate.
authRouter.get('/sessions', requireLogin, (req, res) => {
  const session = sessionForRequest(req)!;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sessions: listLoginSessions(session.token, session.account) });
});

authRouter.delete('/sessions/:id', requireLogin, async (req, res) => {
  const parsed = z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.params.id);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'invalid session id');
    return;
  }
  const revoked = revokeLoginSession(parsed.data, sessionForRequest(req)!.account);
  if (revoked) await persistSessionRevocations();
  res.json({ ok: true, revoked });
});
