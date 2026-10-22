import type { ModelOption } from './contract/models.js';
import type { RuntimeDriver } from './runtimes/types.js';
import type { LaunchProfileSnapshot } from './types.js';

// The models an account can use, as its CLI lists them (the runtime's
// ModelSupport). Asking spawns the CLI (Codex's app-server, `agy models`),
// so a list is kept per runtime and account for a while, shared by
// switching a running CLI's model (routes/models.ts) and choosing the
// recaps' model (recap/).

const LIST_TTL_MS = 10 * 60_000;
const lists = new Map<string, { options: ModelOption[]; fetchedAt: string; expiresAt: number }>();

/** The account's models; `refresh` asks the CLI again instead of using a list from the last LIST_TTL_MS. */
export async function listModels(runtime: RuntimeDriver, profile: LaunchProfileSnapshot, refresh: boolean): Promise<{ options: ModelOption[]; fetchedAt: string }> {
  if (!runtime.models) throw new Error(`${runtime.label} has no model list`);
  const key = `${runtime.runtimeId}\n${profile.id}`;
  const cached = lists.get(key);
  if (cached && !refresh && cached.expiresAt > Date.now()) return cached;
  const options = await runtime.models.list(profile);
  const entry = { options, fetchedAt: new Date().toISOString(), expiresAt: Date.now() + LIST_TTL_MS };
  lists.set(key, entry);
  return entry;
}

/** For tests: forget every cached list. */
export function clearModelLists(): void {
  lists.clear();
}
