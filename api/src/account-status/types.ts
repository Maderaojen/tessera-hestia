// Per-account usage/limit status for every LLM provider account on this host.
// Each provider has its own "most official available" source (see
// docs/reference/account-status.md): Codex → the CLI's own app-server JSON-RPC,
// Claude → the CLI's own `/usage` panel. Nothing here calls undocumented
// HTTP endpoints or reads OAuth tokens; the one field read from Claude's
// credentials file is when its login expires (login-expiry.ts, ADR 0028).

export type AccountSource = 'janus' | 'native';

/**
 * The one spelling of an account id. Sessions name the account holding their
 * quota by it (types.ts quotaAccountIdFor), so both sides must agree. A
 * provider CLI's own default home is the native account named `default`.
 */
export function accountIdFor(source: AccountSource, provider: string, name: string): string {
  return `${source}:${provider}:${name}`;
}

export const NATIVE_ACCOUNT_NAME = 'default';

// One launchable account: how to start the provider's own CLI as that account.
export type AccountRef = {
  id: string;
  provider: string;
  name: string;
  source: AccountSource;
  home: string;
  // argv prefix that launches the provider CLI as this account; provider
  // specific arguments are appended by the probe.
  launch: string[];
  env: Record<string, string>;
  // Variables that must NOT leak in from our own environment (e.g. a parent
  // CLAUDE_CONFIG_DIR would silently point a native probe at another account).
  unsetEnv: string[];
};

export type AccountState =
  | 'ok'
  | 'unauthenticated'
  | 'not_installed'
  | 'unsupported'
  | 'error';

export type UsageWindow = {
  id: string; // 'five_hour' | 'seven_day' | provider-specific extras
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null; // ISO; null when the CLI didn't say or it couldn't be parsed
  resetsText: string | null; // the CLI's own wording, kept for display/debugging
};

/**
 * When the account's login runs out, as of the reading (`state` is
 * recomputed on every read). `unknown`: the CLI keeps it somewhere we
 * can't read (macOS Keychain) or not at all.
 */
export type LoginExpiryState = 'ok' | 'expiring' | 'expired' | 'unknown';
export type LoginExpiry = { expiresAt: string | null; state: LoginExpiryState };

export type Credits = { hasCredits: boolean; unlimited: boolean; balance: string | null };

export type AccountStatus = {
  id: string;
  provider: string;
  name: string;
  source: AccountSource;
  state: AccountState;
  method: 'codex-app-server' | 'claude-cli-usage' | null;
  identity: { email: string | null; plan: string | null };
  windows: UsageWindow[];
  credits: Credits | null;
  error: string | null;
  fetchedAt: string;
  // null: the provider has no login expiry we can read (only Claude does).
  login: LoginExpiry | null;
  // Set by the snapshot merge (see snapshot.ts): when this account's windows
  // were last read successfully, and whether the latest attempt failed so the
  // numbers shown are that older reading.
  lastSuccessAt: string | null;
  stale: boolean;
};

export function usageWindow(
  id: string, label: string, usedPercent: number, windowMinutes: number | null,
  resetsAt: string | null, resetsText: string | null = null,
): UsageWindow {
  const used = Math.min(100, Math.max(0, usedPercent));
  return { id, label, usedPercent: used, remainingPercent: 100 - used, windowMinutes, resetsAt, resetsText };
}

export function baseStatus(account: AccountRef, now: Date = new Date()): AccountStatus {
  return {
    id: account.id, provider: account.provider, name: account.name, source: account.source,
    state: 'error', method: null, identity: { email: null, plan: null },
    windows: [], credits: null, error: null, fetchedAt: now.toISOString(), login: null,
    lastSuccessAt: null, stale: false,
  };
}

/**
 * How a provider CLI logs an account in again with the code pasted back
 * (account-status/login.ts runs it; claude-login.ts is Claude's). Every
 * reading is of the CLI's own output, which is never kept or logged.
 */
export type AccountLoginProtocol = {
  // Arguments after the account's launch prefix.
  loginArgs(email: string | null): string[];
  statusArgs: string[];
  // The sign-in URL, once the CLI is waiting for the code; null until then.
  readPrompt(stdout: string): { url: string } | null;
  // Whether a pasted code has the shape the CLI accepts at all.
  codeLooksValid(code: string): boolean;
  // What the CLI said about the submitted code, from its output since then.
  readOutcome(stdout: string, stderr: string): 'succeeded' | 'invalid_code' | 'failed' | null;
  // The signed-in email from the status command's output.
  readEmail(stdout: string): string | null;
};
