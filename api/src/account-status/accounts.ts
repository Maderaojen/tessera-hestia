import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from '../child-env.js';
import { findJanus } from '../launch-profiles.js';
import { probePath } from '../probe-path.js';
import { accountRuntimeFor, getRuntimeDriverForProvider, productProviders } from '../runtimes/index.js';
import type { Provider } from '../types.js';
import { accountIdFor, NATIVE_ACCOUNT_NAME, type AccountRef } from './types.js';

const execFileAsync = promisify(execFile);

// `janus list --json` is the one place that knows every account on this host,
// including the provider CLIs' own default ("native", state `external`)
// homes. Janus accounts are launched exactly like sessions are (`janus run
// <name>`), native ones like a bare CLI.
type JanusRow = { source?: unknown; name?: unknown; provider?: unknown; command?: unknown; home?: unknown; state?: unknown };

export { probePath };

export function accountsFromJanusList(rows: unknown, janusExecutable: string): AccountRef[] {
  const PATH = probePath();
  if (!Array.isArray(rows)) return [];
  const accounts: AccountRef[] = [];
  const seen = new Set<string>();
  for (const raw of rows as JanusRow[]) {
    if (!raw || typeof raw !== 'object') continue;
    const { name, provider, home } = raw;
    if (typeof name !== 'string' || typeof provider !== 'string' || typeof home !== 'string') continue;
    const source = raw.source === 'native' ? 'native' : 'janus';
    const id = accountIdFor(source, provider, name);
    if (seen.has(id)) continue;
    seen.add(id);
    if (source === 'janus') {
      accounts.push({ id, provider, name, source, home, launch: [janusExecutable, 'run', name], env: { PATH, ...updateCheckOffEnv(provider) }, unsetEnv: [] });
    } else {
      const command = typeof raw.command === 'string' && raw.command ? raw.command : provider;
      accounts.push({ id, provider, name, source, home, launch: [command], env: { PATH, ...updateCheckOffEnv(provider), ...nativeEnv(provider, home) }, unsetEnv: nativeUnsetEnv(provider) });
    }
  }
  return accounts;
}

// The environment a native launch sets so the CLI uses this home (Codex:
// CODEX_HOME), as the provider's own runtime driver declares it.
function nativeEnv(provider: string, home: string): Record<string, string> {
  const runtime = accountRuntimeFor(provider);
  return runtime?.nativeLaunchEnv?.({ home }) ?? {};
}

// A probe starts the CLI too: its own update check stays off (ADR 0030).
function updateCheckOffEnv(provider: string): Record<string, string> {
  return { ...accountRuntimeFor(provider)?.updateCheckOff?.env };
}

function nativeUnsetEnv(provider: string): string[] {
  return [...(accountRuntimeFor(provider)?.accountStatus?.nativeUnsetEnv ?? [])];
}

// Each provider CLI's own default account, located where that provider's
// original runtime keeps its native data.
export function nativeAccounts(): AccountRef[] {
  const PATH = probePath();
  return productProviders().map((provider: Provider) => {
    const runtime = getRuntimeDriverForProvider(provider);
    const { home } = runtime.nativeLocations();
    return {
      id: accountIdFor('native', provider, NATIVE_ACCOUNT_NAME), provider, name: NATIVE_ACCOUNT_NAME, source: 'native' as const, home,
      launch: [runtime.nativeProfile.defaultExecutable], env: { PATH, ...updateCheckOffEnv(provider), ...nativeEnv(provider, home) }, unsetEnv: nativeUnsetEnv(provider),
    };
  });
}

export async function listAccounts(): Promise<{ accounts: AccountRef[]; janusAvailable: boolean }> {
  const janus = await findJanus();
  if (janus) {
    try {
      const { stdout } = await execFileAsync(janus, ['list', '--json'], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024, env: childEnv() });
      const accounts = accountsFromJanusList(JSON.parse(stdout), janus);
      // Janus doesn't track Gemini; still surface its native account.
      const gemini = nativeAccounts().filter((a) => !accounts.some((b) => b.provider === a.provider));
      return { accounts: [...accounts, ...gemini], janusAvailable: true };
    } catch (error) {
      console.warn(`[account-status] janus list failed: ${(error as Error).message}`);
    }
  }
  return { accounts: nativeAccounts(), janusAvailable: false };
}

export async function commandOnPath(command: string, searchPath = process.env.PATH ?? ''): Promise<boolean> {
  const candidates = path.isAbsolute(command)
    ? [command]
    : searchPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, 1); return true; } catch { /* next */ }
  }
  return false;
}
