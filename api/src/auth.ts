import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { promisify } from 'node:util';
import {
  GLOBAL_MAX_LOGIN_FAILURES,
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_ATTEMPTS,
  MEDIA_TOKEN_TTL_MS,
  PAIRING_CODE_TTL_MS,
  SESSION_TOKEN_IDLE_TTL_MS,
  SESSION_TOKEN_MAX_TTL_MS,
  SESSION_TOKEN_TOUCH_INTERVAL_MS,
  STREAM_TICKET_TTL_MS,
} from './config.js';
import { jsonFileStore, type JsonFileStore } from '@maderaojen/json-file-store';

// This whole file's job: nobody gets past /auth/login without the exact
// AUTH_USERNAME/AUTH_PASSWORD_HASH from .env, and every other route (except
// /health) requires a valid token from having logged in — enforced in
// server.ts's requireAuth middleware, not just hidden behind a frontend
// login screen. This backend can create tmux sessions, browse the
// filesystem, and launch CLI agents; once it's reachable from outside
// localhost (tailscale serve, or the native app's SSH port forward), that's
// not optional.

// Who a login token belongs to. localOnly: an account from
// AUTH_LOCAL_USERS, usable only from this machine (see isLocalRequest).
export type Account = { username: string; localOnly: boolean };

// Login tokens. Kept in memory and, once main.ts has called
// loadSessionTokens, mirrored to a file so a restart doesn't log every
// phone out (see there for what is and isn't written).
//
// Keyed by the token's SHA-256, not the token: a Map lookup compares keys
// with ordinary string equality, whose running time depends on how much of
// a guess matches. Hashing first means what gets compared is a digest the
// caller can't steer byte by byte, so the lookup leaks nothing usable.
//
// passwordFingerprint ties the token to the password it was issued under
// (see passwordFingerprint below); lastUsedAt drives the idle expiry
// (SESSION_TOKEN_IDLE_TTL_MS).
type SessionEntry = { account: Account; passwordFingerprint: string; createdAt: number; lastUsedAt: number };
const validTokens = new Map<string, SessionEntry>();
const pendingRevocations = new Map<string, Account>();

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SCRYPT_KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch rather than returning
  // false — comparing lengths first and short-circuiting is fine here
  // since length alone isn't a meaningful side-channel (a wrong-length
  // guess is already wrong, same as a wrong-length one that happens to
  // match — nothing about *how* it's wrong leaks anything else).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Stored as "scrypt:<saltHex>:<hashHex>" so the .env file never holds the
// plaintext password — only `npm run set-credentials` (scripts/set-credentials.ts)
// ever sees the plaintext, and only long enough to hash it.
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Async so a burst of guesses can't stall every other request: scryptSync
// blocks the event loop for the whole derivation, which made each wrong
// password a small denial of service on top of a guess.
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

// Stands in for a stored hash that doesn't exist (no such username) or
// can't be parsed, so every login attempt costs exactly one scrypt either
// way. Its salt and expected value are arbitrary: nothing is meant to match
// it, it only has to cost the same as a real verification.
const DUMMY_HASH = { salt: Buffer.alloc(SALT_LENGTH), expected: Buffer.alloc(SCRYPT_KEY_LENGTH) };

let scryptRuns = 0;

function parsePasswordHash(stored: string): { salt: Buffer; expected: Buffer } | null {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== SCRYPT_KEY_LENGTH) return null;
  return { salt, expected };
}

// Always runs scrypt exactly once — against the dummy when there's nothing
// real to check — so how long it takes says nothing about whether the
// account exists or how its hash is stored.
async function verifyPasswordHash(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored === null ? null : parsePasswordHash(stored);
  const { salt, expected } = parsed ?? DUMMY_HASH;
  scryptRuns += 1;
  const actual = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);
  return timingSafeEqual(actual, expected) && parsed !== null;
}

// How many password verifications have run, so a test can check that an
// unknown username still pays for one (wall-clock timing is too noisy to
// assert on).
export function __scryptRunsForTests(): number {
  return scryptRuns;
}

// Extra accounts that work only from this machine, for local tooling (an
// automated browser checking the UI) that should never be a way in from
// outside. AUTH_LOCAL_USERS is "name=scrypt:salt:hash", ";"-separated; like
// AUTH_PASSWORD_HASH it holds only hashes. Set it outside the project (the
// service's environment), never in the repo.
function localUsers(): { username: string; passwordHash: string }[] {
  return (process.env.AUTH_LOCAL_USERS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('=');
      return at > 0 ? { username: entry.slice(0, at).trim(), passwordHash: entry.slice(at + 1).trim() } : null;
    })
    .filter((user): user is { username: string; passwordHash: string } => !!user && !!user.username && !!user.passwordHash);
}

// The account these credentials belong to, or null. Costs the same however
// it fails: every account's name is compared (no stopping at the first
// match), and exactly one scrypt runs — against a dummy hash when no name
// matched — so the timing doesn't tell a caller whether a username, or a
// local-only account, exists.
export async function verifyCredentials(username: string, password: string): Promise<Account | null> {
  const expectedUser = process.env.AUTH_USERNAME ?? '';
  const passwordHash = process.env.AUTH_PASSWORD_HASH ?? '';
  const candidates: { account: Account; passwordHash: string }[] = [];
  // Unconfigured must mean "nobody gets in," not "anyone does" — an empty
  // .env value should never accidentally become an open door.
  if (expectedUser && passwordHash) candidates.push({ account: { username: expectedUser, localOnly: false }, passwordHash });
  for (const user of localUsers()) candidates.push({ account: { username: user.username, localOnly: true }, passwordHash: user.passwordHash });
  let match: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    const same = safeEqual(username, candidate.account.username);
    // The first match wins (the main account over a same-named local one),
    // but the loop still compares every name.
    if (same && match === null) match = candidate;
  }
  const ok = await verifyPasswordHash(password, match?.passwordHash ?? null);
  return ok && match ? match.account : null;
}

// Straight from this machine, not relayed. The API listens on loopback
// only, so every request arrives over loopback. `tailscale serve` adds
// forwarding headers, which a direct local connection doesn't have, so it
// is told apart by them. Any of these headers counts, whoever sent it: a
// relay set up by hand in front of the API (unsupported, but possible)
// must never pass as this machine.
//
// The native app's SSH port forward is the exception: sshd connects to
// the API over loopback with no such header, so a request through it looks
// local. That is no wider than what the SSH login already grants, a shell
// on this machine as this user.
const FORWARDING_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

export function isLocalRequest(req: { socket: { remoteAddress?: string | undefined }; headers: IncomingHttpHeaders }): boolean {
  const address = req.socket.remoteAddress ?? '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  return loopback && FORWARDING_HEADERS.every((header) => req.headers[header] === undefined);
}

// Who is really on the other end, for counting failed logins. Everything
// from outside arrives over loopback (see isLocalRequest), so the socket
// address alone would put every caller in one bucket, letting a few wrong
// guesses from anywhere lock everyone out. The relay names the real client,
// but only in the part of a header the relay itself wrote:
// - `tailscale serve` (Go's httputil.ReverseProxy) puts the address it saw
//   *last* in X-Forwarded-For; anything before it is the caller's own
//   invention, and trusting the first one let every guess claim a fresh
//   source and dodge the lockout.
// - CF-Connecting-IP and X-Real-IP aren't used: tailscale serve passes a
//   client's own value through untouched, so trusting either would let
//   every guess name a new source.
export function loginSource(req: { ip?: string | undefined; headers: IncomingHttpHeaders }): string {
  const joined = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(',') : value);
  const lastHop = joined(req.headers['x-forwarded-for'])?.split(',').pop()?.trim();
  return lastHop || req.ip || 'unknown';
}

// Tools on this machine (the hestia command) authenticate with a
// token made fresh each time the API starts, written to a file only this
// user can read — being able to read it is the proof. Like a local-only
// account it's accepted only from a direct local connection, sent in the
// X-Hestia-Token header.
export const LOCAL_TOOL_HEADER = 'x-hestia-token';
const LOCAL_TOOL_ACCOUNT: Account = { username: 'cli', localOnly: true };
let localToolToken: string | null = null;

export async function issueLocalToolToken(file: string): Promise<void> {
  const token = randomBytes(32).toString('hex');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  invalidateLocalToolStreams();
  localToolToken = token;
}

function localToolAccount(headers: IncomingHttpHeaders, local: boolean): Account | null {
  const sent = headers[LOCAL_TOOL_HEADER];
  if (!local || !localToolToken || typeof sent !== 'string') return null;
  return safeEqual(sent, localToolToken) ? LOCAL_TOOL_ACCOUNT : null;
}

type AuthRequest = { socket: { remoteAddress?: string | undefined }; headers: IncomingHttpHeaders };

// `Authorization: Bearer <token>` — how every client sends the token login
// handed it. Never a cookie: a browser attaches a cookie to requests other
// sites make too (a form posted from anywhere), a header only the page
// holding the token can set.
export function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? '');
  return match?.[1];
}

// The login tokens a request carries: its bearer token, if any.
export function sessionTokensOf(req: AuthRequest): string[] {
  const token = bearerToken(req.headers);
  return token ? [token] : [];
}

// The login token that authenticates this request (its bearer token), and
// its account — not the local tool token, which isn't a login.
export function sessionForRequest(req: AuthRequest): { token: string; account: Account } | null {
  const local = isLocalRequest(req);
  for (const token of sessionTokensOf(req)) {
    const account = accountForToken(token, local);
    if (account) return { token, account };
  }
  return null;
}

export function sessionAccountForRequest(req: AuthRequest): Account | null {
  return sessionForRequest(req)?.account ?? null;
}

// Who a request is from: its login token, or the local
// tool token.
// Whether this is the local tool itself (the hestia command): its
// token, over a direct local connection. Not any login, whatever its name.
export function isLocalToolRequest(req: AuthRequest): boolean {
  return localToolAccount(req.headers, isLocalRequest(req)) !== null;
}

export function accountForRequest(req: AuthRequest): Account | null {
  return sessionAccountForRequest(req) ?? localToolAccount(req.headers, isLocalRequest(req));
}

export function __setLocalToolTokenForTests(token: string | null): void {
  invalidateLocalToolStreams();
  localToolToken = token;
}

// ---------- login tokens on disk ----------
//
// What the file holds per token: its SHA-256 (the same key as validTokens —
// never the token, so reading the file doesn't let anyone in), whose it is,
// a fingerprint of the password hash it was issued under, and when it was
// made and last used. Written atomically with mode 0600, like the other
// secrets in the state dir. Stream tickets, media tokens, pairing codes and
// the local tool token are deliberately not here: they are short-lived or
// made fresh each start, and losing them on a restart costs nothing.
type StoredSessionToken = {
  digest: string;
  username: string;
  localOnly: boolean;
  passwordFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
};
const SESSION_TOKENS_FILE_VERSION = 1;

// Null until loadSessionTokens: before that nothing is written, so a write
// can never land before the saved tokens were read (and wipe them), and a
// test that only issues tokens never touches a real state dir.
let sessionTokenFile: JsonFileStore<StoredSessionToken[]> | null = null;
let lastSessionTokenWrite: Promise<void> = Promise.resolve();

// Changing the password (the installer or `npm run set-credentials`
// writes a new AUTH_PASSWORD_HASH, freshly salted even for the same
// password) should log everyone out: that's usually why it gets changed.
// So each token remembers which hash it was issued under, and at startup a
// token whose hash is no longer the account's is dropped. Only a digest of
// the hash is kept — the hash itself already lives in .env and has no
// business being copied around.
function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(`hestia-session:${passwordHash}`).digest('hex');
}

// The account's current password hash, or null when the account no longer
// exists (AUTH_USERNAME renamed, a local user removed from
// AUTH_LOCAL_USERS). The local-only flag is part of who it is: a main
// account token never turns into a local user's, or the other way round.
function currentPasswordHash(account: Account): string | null {
  if (account.localOnly) return localUsers().find((user) => user.username === account.username)?.passwordHash ?? null;
  const mainUser = process.env.AUTH_USERNAME ?? '';
  const mainHash = process.env.AUTH_PASSWORD_HASH ?? '';
  return mainUser && mainHash && account.username === mainUser ? mainHash : null;
}

function isStoredSessionToken(value: unknown): value is StoredSessionToken {
  const v = value as Partial<StoredSessionToken> | null;
  return (
    typeof v === 'object' && v !== null &&
    typeof v.digest === 'string' && /^[0-9a-f]{64}$/.test(v.digest) &&
    typeof v.username === 'string' && v.username !== '' &&
    typeof v.localOnly === 'boolean' &&
    typeof v.passwordFingerprint === 'string' &&
    Number.isFinite(v.createdAt) && Number.isFinite(v.lastUsedAt)
  );
}

// Anything but the current shape throws, and loadSessionTokens starts
// empty: a login is cheap to redo, guessing at a file we don't understand
// isn't worth it. Malformed entries in a good file are skipped one by one.
function decodeSessionTokens(raw: unknown): StoredSessionToken[] {
  const file = raw as { version?: unknown; tokens?: unknown } | null;
  if (typeof file !== 'object' || file === null || file.version !== SESSION_TOKENS_FILE_VERSION || !Array.isArray(file.tokens)) {
    throw new Error(`not a version ${SESSION_TOKENS_FILE_VERSION} login token file`);
  }
  return file.tokens.filter(isStoredSessionToken);
}

function persistSessionTokens(): void {
  if (!sessionTokenFile) return;
  const records: StoredSessionToken[] = [...validTokens].map(([key, entry]) => ({
    digest: key,
    username: entry.account.username,
    localOnly: entry.account.localOnly,
    passwordFingerprint: entry.passwordFingerprint,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  }));
  // Background issuance/touch writes log failures. Revocation routes also
  // await this original promise and fail rather than claiming durability.
  lastSessionTokenWrite = sessionTokenFile.save(records);
  void lastSessionTokenWrite.catch((err: unknown) => {
    console.error(`hestia: could not save login tokens: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// Explicit retry writes the latest state even if the token was already
// removed from memory during a failed earlier request.
export async function persistSessionRevocations(): Promise<void> {
  const pending = [...pendingRevocations.keys()];
  if (!pending.length) return;
  persistSessionTokens();
  await lastSessionTokenWrite;
  for (const key of pending) pendingRevocations.delete(key);
}

// Called once at startup, before the server listens: brings back the login
// tokens saved by earlier runs, minus those that expired, whose account is
// gone, or whose password has changed since, and from then on keeps the
// file in step. A missing file is a first start; an unreadable or
// unfamiliar one is logged and replaced — never a reason not to start.
export async function loadSessionTokens(file: string): Promise<void> {
  const store = jsonFileStore<StoredSessionToken[]>({
    path: file,
    empty: () => [],
    decode: decodeSessionTokens,
    encode: (tokens) => ({ version: SESSION_TOKENS_FILE_VERSION, tokens }),
    mode: 0o600,
  });
  let stored: StoredSessionToken[] = [];
  let rewrite = false;
  try {
    stored = await store.load();
  } catch (err) {
    console.warn(`hestia: ignoring unreadable login token file ${file} (${err instanceof Error ? err.message : String(err)}); saved logins are gone`);
    rewrite = true;
  }
  const now = Date.now();
  let restored = 0;
  for (const record of stored) {
    const account: Account = { username: record.username, localOnly: record.localOnly };
    const hash = currentPasswordHash(account);
    if (!hash || passwordFingerprint(hash) !== record.passwordFingerprint || isExpired(record, now)) {
      rewrite = true;
      continue;
    }
    // A token issued in this run before the load (none in practice) wins.
    if (validTokens.has(record.digest)) continue;
    validTokens.set(record.digest, { account, passwordFingerprint: record.passwordFingerprint, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt });
    restored += 1;
  }
  sessionTokenFile = store;
  if (rewrite) persistSessionTokens();
  const dropped = stored.length - restored;
  console.log(`hestia: restored ${restored} login token(s)${dropped > 0 ? `, dropped ${dropped} expired or no longer valid` : ''}`);
}

// Tests only: resolves once the last write started has landed (or failed).
export function __sessionTokensWrittenForTests(): Promise<void> {
  return lastSessionTokenWrite;
}

function isExpired(entry: { createdAt: number; lastUsedAt: number }, now: number): boolean {
  return now - entry.lastUsedAt >= SESSION_TOKEN_IDLE_TTL_MS || now - entry.createdAt >= SESSION_TOKEN_MAX_TTL_MS;
}

function dropSession(key: string): void {
  validTokens.delete(key);
  for (const [ticket, entry] of streamTickets) if (entry.session === key) streamTickets.delete(ticket);
  for (const close of [...(streamClosers.get(key) ?? [])]) close();
  streamClosers.delete(key);
  for (const [mediaKey, entry] of mediaTokens) if (entry.session === key) mediaTokens.delete(mediaKey);
}

// The entry behind a token digest, if it hasn't expired; an expired one is
// dropped on the spot (with its image tokens), on disk too.
function liveSession(key: string, now = Date.now()): SessionEntry | undefined {
  const entry = validTokens.get(key);
  if (!entry) return undefined;
  if (!isExpired(entry, now)) return entry;
  dropSession(key);
  persistSessionTokens();
  return undefined;
}

// Without an account: the main one (AUTH_USERNAME).
export function issueSessionToken(account: Account = { username: process.env.AUTH_USERNAME ?? '', localOnly: false }): string {
  const now = Date.now();
  // Swept here, like the other token maps: tokens of devices nobody uses
  // any more would otherwise sit in the file until the next restart.
  for (const [key, entry] of validTokens) if (isExpired(entry, now)) dropSession(key);
  const token = randomBytes(32).toString('hex');
  validTokens.set(digest(token), {
    account,
    passwordFingerprint: passwordFingerprint(currentPasswordHash(account) ?? ''),
    createdAt: now,
    lastUsedAt: now,
  });
  persistSessionTokens();
  return token;
}

// The token's account, if it's valid for a request arriving this way — a
// local-only account's token is refused from outside. An accepted use
// counts as activity for the idle expiry, recorded at most once per
// SESSION_TOKEN_TOUCH_INTERVAL_MS so requests don't each rewrite the file.
export function accountForToken(token: string | undefined, local: boolean): Account | null {
  if (token === undefined) return null;
  const now = Date.now();
  const entry = liveSession(digest(token), now);
  if (!entry || (entry.account.localOnly && !local)) return null;
  if (now - entry.lastUsedAt >= SESSION_TOKEN_TOUCH_INTERVAL_MS) {
    entry.lastUsedAt = now;
    persistSessionTokens();
  }
  return entry.account;
}

export function isValidToken(token: string | undefined): boolean {
  return token !== undefined && liveSession(digest(token)) !== undefined;
}

// Also ends every image token handed out under it (issueMediaToken).
export function revokeToken(token: string | undefined): boolean {
  if (!token) return false;
  const key = digest(token);
  const entry = validTokens.get(key);
  if (entry) pendingRevocations.set(key, entry.account);
  const pending = pendingRevocations.has(key);
  dropSession(key);
  if (entry) persistSessionTokens();
  return pending;
}

// EventSource can't send headers, so a bearer-token frontend can't
// authenticate a stream the normal way — and the long-lived token must
// never go in a URL (URLs end up in proxy logs, browser history, Referer).
// Instead it trades its token for a ticket: opaque, good for one stream
// opening only, and only for STREAM_TICKET_TTL_MS. A ticket that leaks
// from a log is already spent or expired by the time anyone reads it.
type StreamIdentity = { account: Account; session: string; localTool: boolean };
const streamTickets = new Map<string, StreamIdentity & { expiresAt: number }>();
const streamRequests = new WeakMap<object, StreamIdentity>();
const streamClosers = new Map<string, Set<() => void>>();

function streamIdentity(req: AuthRequest): StreamIdentity | null {
  const session = sessionForRequest(req);
  if (session) return { account: session.account, session: digest(session.token), localTool: false };
  if (isLocalToolRequest(req) && localToolToken) return { account: LOCAL_TOOL_ACCOUNT, session: digest(localToolToken), localTool: true };
  return null;
}

function liveStreamIdentity(identity: StreamIdentity): boolean {
  return identity.localTool
    ? localToolToken !== null && digest(localToolToken) === identity.session
    : liveSession(identity.session) !== undefined;
}

export function issueStreamTicket(req: AuthRequest): string | null {
  const identity = streamIdentity(req);
  if (!identity) return null;
  const now = Date.now();
  for (const [key, entry] of streamTickets) if (entry.expiresAt <= now) streamTickets.delete(key);
  const ticket = randomBytes(32).toString('hex');
  streamTickets.set(digest(ticket), { ...identity, expiresAt: now + STREAM_TICKET_TTL_MS });
  return ticket;
}

// Capture the parent identity when consuming a ticket. The one-use ticket
// itself no longer exists by the time the route opens its response.
export function authenticateStreamRequest(req: AuthRequest, ticket?: string): Account | null {
  let identity = streamIdentity(req);
  if (!identity && ticket !== undefined) {
    const key = digest(ticket);
    const entry = streamTickets.get(key);
    streamTickets.delete(key);
    if (entry && entry.expiresAt > Date.now() && (!entry.account.localOnly || isLocalRequest(req)) && liveStreamIdentity(entry)) identity = entry;
  }
  if (!identity) return null;
  streamRequests.set(req, identity);
  return identity.account;
}

// Every send and heartbeat rechecks expiry; revocation also closes the
// response immediately, even when there are no events to trigger a check.
export function streamAuthentication(req: object, close: () => void): { valid: () => boolean; dispose: () => void } {
  const identity = streamRequests.get(req);
  if (!identity) return { valid: () => false, dispose: () => {} };
  const closers = streamClosers.get(identity.session) ?? new Set<() => void>();
  closers.add(close);
  streamClosers.set(identity.session, closers);
  return {
    valid: () => liveStreamIdentity(identity),
    dispose: () => {
      closers.delete(close);
      if (!closers.size) streamClosers.delete(identity.session);
    },
  };
}

function publicSessionId(key: string): string {
  return createHash('sha256').update(`hestia-session-id:${key}`).digest('hex');
}

export function listLoginSessions(token: string, account: Account): import('./contract/auth.js').LoginSession[] {
  const now = Date.now();
  const sessions: import('./contract/auth.js').LoginSession[] = [];
  for (const [key, entry] of validTokens) {
    if (!liveSession(key, now) || entry.account.username !== account.username || entry.account.localOnly !== account.localOnly) continue;
    sessions.push({ id: publicSessionId(key), createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt,
      expiresAt: Math.min(entry.createdAt + SESSION_TOKEN_MAX_TTL_MS, entry.lastUsedAt + SESSION_TOKEN_IDLE_TTL_MS), current: key === digest(token) });
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export function revokeLoginSession(id: string, account: Account): boolean {
  for (const [key, entry] of validTokens) {
    if (publicSessionId(key) !== id || entry.account.username !== account.username || entry.account.localOnly !== account.localOnly) continue;
    pendingRevocations.set(key, entry.account);
    dropSession(key);
    return true;
  }
  return [...pendingRevocations].some(([key, owner]) => publicSessionId(key) === id && owner.username === account.username && owner.localOnly === account.localOnly);
}

// Pairing: how a phone logs in by scanning a QR code instead of typing the
// password. `hestia pair` on this machine asks for a code (only a
// direct local request with the local tool token can: see routes/auth.ts)
// and shows it inside the pairing link; the phone trades it once for a
// normal login token of the main account. A code is 128 random bits, good
// for PAIRING_CODE_TTL_MS and one use; guessing is also throttled by the
// login lockout. It travels in the link's #fragment, which browsers never
// send to a server, so it stays out of the frontend host's logs.
//
// `hestia pair` then waits on it (pairingStatus): once a phone has used
// it, the terminal says which device and when, so a QR code someone else
// got to first doesn't go unnoticed — and can take that login back
// (revokePairing). A used code is remembered for PAIRING_RECORD_MS for
// that, by its digest, with the digest of the login it became.
type PairingEntry = {
  expiresAt: number;
  used?: { at: number; device: string | null; session: string };
};
const pairingCodes = new Map<string, PairingEntry>();
const PAIRING_RECORD_MS = 60 * 60_000;

function sweepPairingCodes(now: number): void {
  for (const [key, entry] of pairingCodes) {
    if ((entry.used ? entry.used.at + PAIRING_RECORD_MS : entry.expiresAt) <= now) pairingCodes.delete(key);
  }
}

export function issuePairingCode(): string {
  const now = Date.now();
  sweepPairingCodes(now);
  const code = randomBytes(16).toString('base64url');
  pairingCodes.set(digest(code), { expiresAt: now + PAIRING_CODE_TTL_MS });
  return code;
}

// What a phone may call itself: printable, one line, short.
function cleanDevice(device: string | undefined): string | null {
  const text = (device ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return text || null;
}

// The login token for a good code, null otherwise; spent either way.
export function redeemPairingCode(code: string, device?: string): string | null {
  const now = Date.now();
  const entry = pairingCodes.get(digest(code));
  if (!entry || entry.used || entry.expiresAt <= now) {
    // Wrong, used or expired: nothing more to remember about it.
    if (entry && !entry.used) pairingCodes.delete(digest(code));
    return null;
  }
  const token = issueSessionToken();
  entry.used = { at: now, device: cleanDevice(device), session: digest(token) };
  return token;
}

export type PairingStatus =
  | { status: 'pending'; expiresInMs: number }
  | { status: 'used'; usedAt: number; device: string | null }
  | { status: 'expired' };

// Unknown codes read as expired: nothing tells them apart from one swept.
export function pairingStatus(code: string): PairingStatus {
  const now = Date.now();
  sweepPairingCodes(now);
  const entry = pairingCodes.get(digest(code));
  if (entry?.used) return { status: 'used', usedAt: entry.used.at, device: entry.used.device };
  if (entry && entry.expiresAt > now) return { status: 'pending', expiresInMs: entry.expiresAt - now };
  return { status: 'expired' };
}

// Takes back a code nobody has used yet (hestia connect: the QR's code once
// the phone came in over SSH instead, or the command ends early). A used
// code is left alone: ending the login it became is revokePairing's. True
// when there was an unused one to take back.
export function cancelPairingCode(code: string): boolean {
  const key = digest(code);
  const entry = pairingCodes.get(key);
  if (!entry || entry.used) return false;
  pairingCodes.delete(key);
  return true;
}

// Ends the login a used code became. False when there is none (not used,
// or no longer remembered).
export function revokePairing(code: string): boolean {
  const entry = pairingCodes.get(digest(code));
  if (!entry?.used) return false;
  const session = validTokens.get(entry.used.session);
  if (session) pendingRevocations.set(entry.used.session, session.account);
  dropSession(entry.used.session);
  return pendingRevocations.has(entry.used.session);
}

// An <img> can't send the bearer header either, and a page shows many
// images, each loaded (and reloaded) whenever the browser likes — a
// one-use ticket per image would mean a request per thumbnail. So a
// logged-in client gets a media token instead: reusable, but good only for
// reading uploaded images (server.ts's MEDIA_PATH), only for
// MEDIA_TOKEN_TTL_MS, and tied to the login it came from, so logging out
// ends it too. What it can leak (a log line holding an image URL) is some
// of the user's own pictures for a few minutes, never a way in.
const mediaTokens = new Map<string, { account: Account; expiresAt: number; session: string }>();

export function issueMediaToken(sessionToken: string, account: Account): string {
  const now = Date.now();
  for (const [key, entry] of mediaTokens) if (entry.expiresAt <= now) mediaTokens.delete(key);
  const token = randomBytes(32).toString('hex');
  mediaTokens.set(digest(token), { account, expiresAt: now + MEDIA_TOKEN_TTL_MS, session: digest(sessionToken) });
  return token;
}

// Not spent by use (see above). Same local-only rule as a login token.
export function mediaTokenAccount(token: string, local: boolean): Account | null {
  const entry = mediaTokens.get(digest(token));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  if (entry.account.localOnly && !local) return null;
  // The login it came from may have been revoked some other way.
  if (!liveSession(entry.session)) return null;
  return entry.account;
}

// scrypt already makes each guess slow, but that only throttles a single
// request's latency — nothing stopped a script from firing many guesses in
// parallel. A per-source lockout after repeated failures closes that gap
// without needing anything external (Redis, etc.) for a single-instance
// tool. Keyed by whatever the caller considers "the source" (routes/auth.ts
// passes loginSource) — behind a relay that names no client, that may collapse to one
// shared value for every real client, which only makes the lockout more
// conservative, never less safe.
const loginAttempts = new Map<string, { count: number; lockedUntil: number; lastFailure: number }>();

// Every failure in the last LOGIN_LOCKOUT_MS, whatever its source. A
// source is only an IP address, and someone with many of them (a botnet, a
// cloud account, IPv6 ranges) gets MAX_LOGIN_ATTEMPTS per address; this
// caps the total. Once it's full, every login waits until enough failures
// age out of the window — the owner too, briefly, which is the price of
// not letting a distributed guesser through.
let recentFailures: { at: number; source: string }[] = [];

// Drops what can no longer matter: failures older than the window from the
// global list, and sources that never reached the lockout and haven't
// failed within the window (without this, one wrong guess from each of
// many addresses would grow the map forever). Expired lockouts go too.
function pruneLoginAttempts(now: number): void {
  const since = now - LOGIN_LOCKOUT_MS;
  recentFailures = recentFailures.filter((failure) => failure.at > since);
  for (const [source, entry] of loginAttempts) {
    const stale = entry.lockedUntil === 0 ? entry.lastFailure <= since : entry.lockedUntil <= now;
    if (stale) loginAttempts.delete(source);
  }
}

export function __loginAttemptSourcesForTests(): number {
  return loginAttempts.size;
}

export function isLoginLocked(source: string): boolean {
  pruneLoginAttempts(Date.now());
  if (recentFailures.length >= GLOBAL_MAX_LOGIN_FAILURES) return true;
  const entry = loginAttempts.get(source);
  if (!entry) return false;
  // Not locked yet (still under MAX_LOGIN_ATTEMPTS) — lockedUntil is still
  // its 0 default, which is always "in the past". Must NOT fall through to
  // the expired-lockout cleanup below: routes/auth.ts calls isLoginLocked
  // on every request before recordLoginFailure, so deleting the entry here
  // would wipe the in-progress failure count on every single attempt and
  // the lockout would never actually engage.
  if (entry.lockedUntil === 0) return false;
  if (Date.now() < entry.lockedUntil) return true;
  loginAttempts.delete(source); // lockout expired — start counting fresh
  return false;
}

export function recordLoginFailure(source: string): void {
  const now = Date.now();
  pruneLoginAttempts(now);
  const entry = loginAttempts.get(source) ?? { count: 0, lockedUntil: 0, lastFailure: now };
  entry.count += 1;
  entry.lastFailure = now;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
  loginAttempts.set(source, entry);
  recentFailures.push({ at: now, source });
}

// Also takes back this source's failures from the global count:
// routes/auth.ts charges a login attempt as a failure before verifying it
// (see there), so a correct password must undo its own charge — and the
// owner's earlier typos from the same place were never an attack.
export function recordLoginSuccess(source: string): void {
  loginAttempts.delete(source);
  recentFailures = recentFailures.filter((failure) => failure.source !== source);
}

function invalidateLocalToolStreams(): void {
  if (!localToolToken) return;
  const key = digest(localToolToken);
  for (const close of [...(streamClosers.get(key) ?? [])]) close();
  streamClosers.delete(key);
  for (const [ticket, entry] of streamTickets) if (entry.localTool && entry.session === key) streamTickets.delete(ticket);
}
