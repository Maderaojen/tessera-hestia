import { readFile } from 'node:fs/promises';
import { ACCOUNT_STATUS_PATH } from '../config.js';
import { writeFileAtomic } from '@maderaojen/json-file-store';
import type { AccountStatus } from './types.js';

// The one place quota readings live. Every sweep (schedule, sidebar view,
// manual refresh) writes it; GET /api/account-status only ever reads it, so
// reading never waits on a CLI.
export const SNAPSHOT_PATH = ACCOUNT_STATUS_PATH;

export type SweepTrigger = 'schedule' | 'startup' | 'view' | 'manual';

export type Snapshot = {
  version: 1;
  sweptAt: string;
  trigger: SweepTrigger;
  janusAvailable: boolean;
  accounts: AccountStatus[];
};

export async function readSnapshot(file = SNAPSHOT_PATH): Promise<Snapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Snapshot>;
    if (parsed.version !== 1 || typeof parsed.sweptAt !== 'string' || !Array.isArray(parsed.accounts)) return null;
    return parsed as Snapshot;
  } catch {
    return null;
  }
}

// tmp + rename: a reader never sees a half-written file.
export async function writeSnapshot(snapshot: Snapshot, file = SNAPSHOT_PATH): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

// A transient failure (timeout, CLI hiccup) must not blank out an account's
// last good numbers: keep them, flag them stale, and carry the new error.
// Definitive answers — logged out, not installed, unsupported — replace
// the old reading outright.
export function mergeAccount(next: AccountStatus, previous: AccountStatus | undefined): AccountStatus {
  if (next.state === 'ok') return { ...next, lastSuccessAt: next.fetchedAt, stale: false };
  if (next.state === 'error' && previous && previous.lastSuccessAt && previous.windows.length > 0) {
    return {
      ...previous,
      state: 'ok',
      stale: true,
      error: next.error,
      fetchedAt: next.fetchedAt,
      // Read from a file apart from the probe: the new reading stands.
      login: next.login,
    };
  }
  return { ...next, lastSuccessAt: previous?.lastSuccessAt ?? null, stale: false };
}

export function mergeSnapshot(
  accounts: AccountStatus[], previous: Snapshot | null, meta: Omit<Snapshot, 'version' | 'accounts'>,
): Snapshot {
  const before = new Map((previous?.accounts ?? []).map((a) => [a.id, a]));
  return { version: 1, ...meta, accounts: accounts.map((a) => mergeAccount(a, before.get(a.id))) };
}
