import { getAccountStatus } from '../../account-status/index.js';
import { accountLimitedUntil } from '../../continuity/wiring.js';
import { getLaunchProfileCatalog, type LaunchProfile } from '../../launch-profiles.js';
import { getRuntimeDriver, getRuntimeDriverForProvider, type RuntimeDriver } from '../../runtimes/index.js';
import { snapshotLaunchProfile } from '../../runtimes/launch.js';
import { type LaunchProfileSnapshot } from '../../types.js';
import { quotaAccountIdFor } from '../../session-dto.js';
import { isCliProcessorRuntimeId } from './runtimes.js';

// Which launch profiles a CLI processor can run on, and whether the
// account behind one is over its usage limit.

// The windows an account counts as over its limit on, as continuity reads them.
const LIMIT_WINDOWS = new Set(['five_hour', 'seven_day']);

/** The profile's runtime, when it is one a CLI processor runs on (Codex, Claude Code). */
export function cliProcessorRuntimeOf(profile: LaunchProfile): RuntimeDriver | null {
  const runtimeId = profile.runtimeId ?? getRuntimeDriverForProvider(profile.provider).runtimeId;
  const driver = isCliProcessorRuntimeId(runtimeId) ? getRuntimeDriver(runtimeId) : undefined;
  return driver && driver.provider === profile.provider ? driver : null;
}

export async function cliProcessorProfile(profileId: string): Promise<{ profile: LaunchProfile; driver: RuntimeDriver; snapshot: LaunchProfileSnapshot } | null> {
  const profile = (await getLaunchProfileCatalog()).profiles.find((candidate) => candidate.id === profileId);
  const driver = profile ? cliProcessorRuntimeOf(profile) : null;
  return profile && driver ? { profile, driver, snapshot: snapshotLaunchProfile(driver, profile) } : null;
}

// Over its limit: from a hit continuity saw on the account, else from the
// account-status snapshot showing a 5-hour or 7-day window used up (one
// whose reset is already past doesn't count).
export async function accountLimit(snapshot: LaunchProfileSnapshot): Promise<{ until: string | null } | null> {
  const until = await accountLimitedUntil(snapshot);
  if (until) return { until };
  const accountId = quotaAccountIdFor({ provider: snapshot.provider, runtimeId: snapshot.runtimeId ?? null, status: 'ready', launchProfile: snapshot });
  if (!accountId) return null;
  const account = (await getAccountStatus()).accounts.find((candidate) => candidate.id === accountId);
  if (!account || (account.state !== 'ok' && !account.stale)) return null;
  const now = Date.now();
  const spent = account.windows.filter((window) => LIMIT_WINDOWS.has(window.id) && window.remainingPercent <= 0
    && (!window.resetsAt || Date.parse(window.resetsAt) > now));
  if (!spent.length) return null;
  const resets = spent.map((window) => window.resetsAt);
  return { until: resets.every((at) => at !== null) ? resets.sort().at(-1)! : null };
}
