import type { Provider } from '../types.js';
import { agyRuntime } from './agy.js';
import { claudeCodeRuntime } from './claude-code.js';
import { codexCliRuntime } from './codex-cli.js';
import { geminiCliRuntime } from './gemini-cli.js';
import { runtimeForProvider, type RuntimeDriver, type RuntimeId } from './types.js';

// The one list of runtimes. Its order is the order the launch catalog and
// account listing present them in.
const RUNTIMES: Record<RuntimeId, RuntimeDriver | undefined> = {
  'claude-code': claudeCodeRuntime,
  'codex-cli': codexCliRuntime,
  'gemini-cli': geminiCliRuntime,
  agy: agyRuntime,
  'legacy-unknown': undefined,
};

export function getRuntimeDriver(runtimeId: RuntimeId): RuntimeDriver | undefined {
  return RUNTIMES[runtimeId];
}

export function getRuntimeDriverForProvider(provider: Provider): RuntimeDriver {
  return RUNTIMES[runtimeForProvider(provider)]!;
}

/** Every runtime this build can drive, in presentation order. */
export function runtimeDrivers(): RuntimeDriver[] {
  return Object.values(RUNTIMES).filter((driver): driver is RuntimeDriver => driver !== undefined);
}

/** The product providers those runtimes belong to, each once, in order. */
export function productProviders(): Provider[] {
  return [...new Set(runtimeDrivers().map((driver) => driver.provider))];
}

export { isRuntimeId } from '../contract/runtimes.js';

/**
 * The runtime a Janus account of this provider runs. Janus names only the
 * product provider, so this is the one runtime of that provider Janus can
 * launch; none means Janus accounts of it aren't launchable here.
 */
export function janusRuntimeFor(provider: string): RuntimeDriver | undefined {
  return runtimeDrivers().find((driver) => driver.provider === provider && driver.janus);
}

/**
 * The runtime whose CLI reports an account's usage. Accounts belong to a
 * product provider (Janus and the native homes are per provider), so this is
 * the one runtime of that provider with a usage source, if any.
 */
export function accountRuntimeFor(provider: string): RuntimeDriver | undefined {
  return runtimeDrivers().find((driver) => driver.provider === provider && driver.accountStatus);
}

export { nativeLaunchArgs, runtimeForProvider } from './types.js';
export type { RuntimeDriver, RuntimeExitPlan, RuntimeId } from './types.js';
