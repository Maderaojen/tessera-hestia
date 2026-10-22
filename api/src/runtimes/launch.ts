import type { PermissionMode, PermissionModeUnavailableReason } from '../contract/permissions.js';
import type { JanusProfile, LaunchProfile, NativeProfile } from '../launch-profiles.js';
import type { LaunchProfileSnapshot } from '../types.js';
import { nativeLaunchArgs, type RuntimeDriver } from './types.js';

/**
 * What a launch should start: a fresh CLI session, an existing one by ID,
 * or a new one forked from an existing one (a branch line).
 */
export type LaunchIntent =
  | { kind: 'fresh'; name?: string }
  | { kind: 'resume'; providerSessionId: string }
  | { kind: 'fork'; fromProviderSessionId: string };

export type LaunchCommand = {
  argv: string[];
  // Pinned before launch only when the runtime supports it; null means the
  // session identity has to be observed after startup.
  providerSessionId: string | null;
};

function withEnv(env: Record<string, string>, argv: string[]): string[] {
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return envArgs.length > 0 ? ['env', ...envArgs, ...argv] : argv;
}

const JANUS_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** The launch permission modes a runtime can start in: cli_default, and each one it has verified flags for. */
export function supportedPermissionModes(driver: RuntimeDriver): PermissionMode[] {
  const modes: PermissionMode[] = ['cli_default'];
  for (const mode of ['auto', 'yolo'] as const) if (driver.permissionArgs?.(mode)) modes.push(mode);
  return modes;
}

/** Of the supported modes, those this host can't use now, and why. */
export function unavailablePermissionModes(driver: RuntimeDriver): Partial<Record<PermissionMode, PermissionModeUnavailableReason>> {
  const unavailable: Partial<Record<PermissionMode, PermissionModeUnavailableReason>> = {};
  for (const mode of ['auto', 'yolo'] as const) {
    const reason = driver.permissionArgs?.(mode) ? driver.permissionModeUnavailable?.(mode) ?? null : null;
    if (reason) unavailable[mode] = reason;
  }
  return unavailable;
}

/** The modes a launch can start in on this host now. */
export function usablePermissionModes(driver: RuntimeDriver): PermissionMode[] {
  const unavailable = unavailablePermissionModes(driver);
  return supportedPermissionModes(driver).filter((mode) => !unavailable[mode]);
}

/**
 * Why `profile` can't be launched in its permission mode, or null if it
 * can: the runtime has no flags for that mode, this host can't use it now,
 * or a native profile's own args already decide permissions (two would
 * contradict each other).
 */
export function permissionModeRefusal(
  driver: RuntimeDriver, profile: LaunchProfileSnapshot,
): 'permission_mode_unsupported' | 'permission_mode_unavailable' | 'permission_mode_conflict' | null {
  const mode = profile.permissionMode ?? 'cli_default';
  if (mode === 'cli_default') return null;
  if (!driver.permissionArgs?.(mode)) return 'permission_mode_unsupported';
  if (driver.permissionModeUnavailable?.(mode)) return 'permission_mode_unavailable';
  const conflicts = [...(driver.permissionConflicts?.always ?? []), ...(mode === 'yolo' ? driver.permissionConflicts?.yoloOnly ?? [] : [])];
  const own = profile.source === 'native' ? profile.args ?? [] : [];
  return own.some((arg) => conflicts.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) ? 'permission_mode_conflict' : null;
}

/**
 * The single place that turns a runtime's own CLI arguments and a saved
 * launch profile into the command line typed into tmux. Every launch path
 * (fresh launch, app /clear relaunch, resume, fork) goes through here so profile
 * delegation, native args and runtime environment cannot drift apart.
 * Returns null for anything that cannot be launched safely.
 */
export function buildLaunchCommand(
  driver: RuntimeDriver,
  profile: LaunchProfileSnapshot,
  cwd: string,
  intent: LaunchIntent,
): LaunchCommand | null {
  if (profile.provider !== driver.provider || (profile.runtimeId ?? driver.runtimeId) !== driver.runtimeId) return null;
  let plan;
  try {
    plan = intent.kind === 'fresh'
      ? driver.buildLaunch(cwd, { name: intent.name })
      : intent.kind === 'resume'
        ? driver.buildResume?.(intent.providerSessionId, cwd)
        : driver.fork?.buildFork(intent.fromProviderSessionId, cwd);
  } catch {
    return null; // e.g. a resume or fork ID the runtime rejects
  }
  if (!plan) return null;
  if (permissionModeRefusal(driver, profile)) return null;
  const mode = profile.permissionMode ?? 'cli_default';
  const permission = mode === 'cli_default' ? [] : driver.permissionArgs!(mode)!;
  // After the CLI's own subcommand (`codex resume …`), before its options;
  // the update check is turned off on every launch (ADR 0030).
  const at = plan.argv.length > 1 && !plan.argv[1]!.startsWith('-') ? 2 : 1;
  const runtimeArgs = [...plan.argv.slice(1, at), ...permission, ...(driver.updateCheckOff?.args ?? []), ...plan.argv.slice(at)];
  const runtimeEnv = runtimeLaunchEnv(driver);
  if (profile.source === 'native' && profile.delegate.kind === 'native') {
    const env = { ...runtimeEnv, ...driver.nativeLaunchEnv?.(profile) };
    const argv = [profile.delegate.executable, ...nativeLaunchArgs(profile.args ?? [], runtimeArgs)];
    return { argv: withEnv(env, argv), providerSessionId: plan.providerSessionId };
  }
  if (
    profile.source === 'janus' && profile.delegate.kind === 'janus'
    && typeof profile.profileName === 'string' && JANUS_PROFILE_NAME.test(profile.profileName)
  ) {
    // Janus exports the profile's own home/config for the CLI it runs and
    // passes the rest of the environment through.
    const argv = [profile.delegate.executable, 'run', profile.profileName, ...runtimeArgs];
    return { argv: withEnv(runtimeEnv, argv), providerSessionId: plan.providerSessionId };
  }
  return null;
}

/**
 * The environment every run of this runtime's CLI sets, native or through
 * Janus, interactive or one of its subcommands: its launchEnv and what
 * turns off its own update check (ADR 0030).
 */
export function runtimeLaunchEnv(driver: Pick<RuntimeDriver, 'launchEnv' | 'updateCheckOff'>): Record<string, string> {
  return { ...driver.launchEnv, ...driver.updateCheckOff?.env };
}

/**
 * Freeze a catalog profile into the private snapshot a conversation keeps,
 * with the permission mode it is launched in (cli_default is left out).
 */
export function snapshotLaunchProfile(driver: RuntimeDriver, profile: LaunchProfile, permissionMode: PermissionMode = 'cli_default'): LaunchProfileSnapshot {
  const mode = permissionMode === 'cli_default' ? {} : { permissionMode };
  if (profile.source === 'janus') {
    const janus = profile as JanusProfile;
    return {
      ...mode,
      id: janus.id,
      provider: janus.provider,
      runtimeId: driver.runtimeId,
      source: 'janus',
      profileName: janus.profileName,
      home: janus.home,
      conversationRoot: janus.conversationRoot,
      delegate: { kind: 'janus', executable: janus.janusExecutable },
    };
  }
  const native = profile as NativeProfile;
  const { home, conversationRoot } = driver.nativeLocations();
  return {
    ...mode,
    id: native.id,
    provider: native.provider,
    runtimeId: driver.runtimeId,
    source: 'native',
    home,
    conversationRoot,
    args: [...native.args],
    delegate: { kind: 'native', executable: native.executable },
  };
}
