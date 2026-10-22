import { accountRuntimeFor } from '../runtimes/index.js';
import { commandOnPath, listAccounts } from './accounts.js';
import { loginExpiryAt, refreshLoginState } from './login-expiry.js';
import { mergeSnapshot, readSnapshot, writeSnapshot, type Snapshot, type SweepTrigger } from './snapshot.js';
import { baseStatus, type AccountRef, type AccountStatus } from './types.js';
import { t } from '../i18n/index.js';

// A sweep probes every account (one at a time — each Claude probe starts a
// CLI) and writes the snapshot file. It runs on the quarter hour, on
// startup when the file is stale, when the sidebar is opened on data older
// than VIEW_REFRESH_AFTER_MS, and on a manual refresh. Only one runs at a
// time; a caller arriving mid-sweep shares it.
export const SCHEDULE_INTERVAL_MS = 15 * 60_000;
export const VIEW_REFRESH_AFTER_MS = 5 * 60_000;

export type AccountStatusReport = {
  accounts: AccountStatus[];
  janusAvailable: boolean;
  fetchedAt: string | null; // when the snapshot was written
  trigger: SweepTrigger | null;
  sweeping: boolean;
};

export type Prober = (account: AccountRef) => Promise<AccountStatus>;

export async function probeAccount(account: AccountRef): Promise<AccountStatus> {
  const support = accountRuntimeFor(account.provider)?.accountStatus;
  const status: AccountStatus = !(await commandOnPath(account.launch[0], account.env.PATH))
    ? { ...baseStatus(account), state: 'not_installed', error: t('account.probe.commandNotFound', { command: account.launch[0] }) }
    : support ? await support.probe(account)
      : { ...baseStatus(account), state: 'unsupported', error: t('account.probe.unsupported') };
  // Read apart from the CLI (a file read), so it's there even when the
  // probe failed or the CLI asks for a login.
  status.login = support?.readLoginExpiry ? loginExpiryAt(await support.readLoginExpiry(account)) : null;
  return status;
}

export type SweepDeps = {
  list: () => Promise<{ accounts: AccountRef[]; janusAvailable: boolean }>;
  probe: Prober;
  read: () => Promise<Snapshot | null>;
  write: (snapshot: Snapshot) => Promise<void>;
  now: () => Date;
};

const defaultDeps: SweepDeps = { list: listAccounts, probe: probeAccount, read: readSnapshot, write: writeSnapshot, now: () => new Date() };

let running: Promise<Snapshot> | null = null;

export function isSweeping(): boolean {
  return running !== null;
}

export function sweep(trigger: SweepTrigger, deps: SweepDeps = defaultDeps): Promise<Snapshot> {
  if (!running) {
    running = (async () => {
      const { accounts, janusAvailable } = await deps.list();
      const results: AccountStatus[] = [];
      for (const account of accounts) results.push(await deps.probe(account));
      const snapshot = mergeSnapshot(results, await deps.read(), {
        sweptAt: deps.now().toISOString(), trigger, janusAvailable,
      });
      await deps.write(snapshot);
      return snapshot;
    })().finally(() => { running = null; });
  }
  return running;
}

// A login's state moves with the clock alone, so it is worked out again on
// every read (a snapshot written before `login` existed has none).
function report(snapshot: Snapshot | null, now: Date = new Date()): AccountStatusReport {
  return {
    accounts: (snapshot?.accounts ?? []).map((account) => ({ ...account, login: refreshLoginState(account.login, now) })),
    janusAvailable: snapshot?.janusAvailable ?? false,
    fetchedAt: snapshot?.sweptAt ?? null,
    trigger: snapshot?.trigger ?? null,
    sweeping: isSweeping(),
  };
}

export async function getAccountStatus(deps: SweepDeps = defaultDeps): Promise<AccountStatusReport> {
  return report(await deps.read(), deps.now());
}

function startInBackground(trigger: SweepTrigger, deps: SweepDeps): void {
  sweep(trigger, deps).catch((error: unknown) => {
    console.warn(`[account-status] ${trigger} sweep failed: ${(error as Error).message}`);
  });
}

// Sidebar view / ↻. A view only re-probes data older than
// VIEW_REFRESH_AFTER_MS; manual always does. Never waits for the sweep —
// the caller polls GET until `sweeping` clears (a full sweep can take
// longer than a proxied request should stay open).
export async function requestRefresh(force: boolean, deps: SweepDeps = defaultDeps): Promise<AccountStatusReport> {
  const snapshot = await deps.read();
  const age = snapshot ? deps.now().getTime() - Date.parse(snapshot.sweptAt) : Infinity;
  if (force || !(age < VIEW_REFRESH_AFTER_MS)) startInBackground(force ? 'manual' : 'view', deps);
  return report(snapshot, deps.now());
}

// After an account logged in again (login.ts): a sweep that starts after
// the login, never one already under way that may have read the account
// before it.
export function refreshAfterLogin(deps: SweepDeps = defaultDeps): Promise<Snapshot> {
  const after = running ? running.catch(() => undefined) : Promise.resolve();
  return after.then(() => sweep('manual', deps));
}

// Next :00 / :15 / :30 / :45 strictly after `now`.
export function msUntilNextQuarter(now: Date): number {
  const next = Math.floor(now.getTime() / SCHEDULE_INTERVAL_MS) * SCHEDULE_INTERVAL_MS + SCHEDULE_INTERVAL_MS;
  return next - now.getTime();
}

let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

export async function startAccountStatusSchedule(deps: SweepDeps = defaultDeps): Promise<void> {
  const snapshot = await deps.read();
  const age = snapshot ? deps.now().getTime() - Date.parse(snapshot.sweptAt) : Infinity;
  if (!(age < SCHEDULE_INTERVAL_MS)) startInBackground('startup', deps);
  const arm = () => {
    scheduleTimer = setTimeout(() => {
      startInBackground('schedule', deps);
      arm();
    }, msUntilNextQuarter(deps.now()));
    scheduleTimer.unref?.();
  };
  arm();
}

export function stopAccountStatusSchedule(): void {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = null;
}

export function __resetAccountStatusForTests(): void { running = null; stopAccountStatusSchedule(); }
