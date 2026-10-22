import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountRef, LoginExpiry } from './types.js';

// When a Claude account's login runs out (ADR 0028). The one exception to
// "不碰 token": the CLI keeps when its login (refresh token) expires next to
// the tokens themselves, in `<config dir>/.credentials.json`, and nothing
// official prints it ahead of time except the CLI's own banner three days
// before. So we read exactly one number from that file —
// `claudeAiOauth.refreshTokenExpiresAt` (ms since epoch) — and nothing else:
// every other field is dropped with the parse, never stored, logged,
// returned or written to the snapshot. Any failure is "unknown" with no
// error text, since a JSON parse error quotes the file's content.
//
// Verified with Claude Code 2.1.296 (docs/reference/cli-version-alignment.md):
// the CLI warns "Your login expires in N day(s) · run /login to renew" when
// this is within three days and not yet passed; refreshing the access token
// doesn't move it, only a new login does.

const DAY_MS = 86_400_000;
/** The CLI's own warning window: within this, a login is `expiring`. */
export const LOGIN_EXPIRING_WITHIN_MS = 3 * DAY_MS;

export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

/**
 * `claudeAiOauth.refreshTokenExpiresAt` of the account's config dir, or
 * null when the file or the field isn't there (macOS keeps credentials in
 * the Keychain) or can't be read. The account's home is its config dir:
 * `~/.claude` for the native default, `~/.claude-<name>` for a Janus one.
 */
export async function readClaudeLoginExpiry(account: Pick<AccountRef, 'home'>): Promise<number | null> {
  try {
    return refreshExpiryFromCredentials(await readFile(path.join(account.home, CLAUDE_CREDENTIALS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** The one field, out of the credentials file's text. Never throws. */
export function refreshExpiryFromCredentials(text: string): number | null {
  let value: unknown;
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: { refreshTokenExpiresAt?: unknown } } | null;
    value = parsed?.claudeAiOauth?.refreshTokenExpiresAt;
  } catch {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The reading as the API shows it, its state as of `now`. */
export function loginExpiryAt(expiresAtMs: number | null, now: Date = new Date()): LoginExpiry {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) return { expiresAt: null, state: 'unknown' };
  const left = expiresAtMs - now.getTime();
  const state = left <= 0 ? 'expired' : left <= LOGIN_EXPIRING_WITHIN_MS ? 'expiring' : 'ok';
  return { expiresAt: new Date(expiresAtMs).toISOString(), state };
}

/** A stored reading's state again as of `now` (it changes with time alone). */
export function refreshLoginState(login: LoginExpiry | null | undefined, now: Date = new Date()): LoginExpiry | null {
  if (!login) return null;
  return loginExpiryAt(login.expiresAt ? Date.parse(login.expiresAt) : null, now);
}
