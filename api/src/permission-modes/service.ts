import { jsonFileStore, type JsonFileStore } from '@maderaojen/json-file-store';
import { PERMISSION_MODES_PATH } from '../config.js';
import type {
  GlobalPermissionMode, PermissionMode, PermissionModeSettingsPatch, PermissionModeSettingsResponse,
  PermissionModeUnavailability, SessionPermissionModesPatch, SessionPermissionModesResponse,
} from '../contract/permissions.js';
import type { RuntimeId } from '../contract/runtimes.js';
import { getLaunchProfileCatalog } from '../launch-profiles.js';
import { getRuntimeDriver, getRuntimeDriverForProvider, runtimeDrivers } from '../runtimes/index.js';
import { supportedPermissionModes, unavailablePermissionModes, usablePermissionModes } from '../runtimes/launch.js';
import { refreshCodexSandboxIfStale } from './codex-sandbox.js';
import {
  decodePermissionModeState, effectiveMode, emptyPermissionModeState, resolveLaunchMode,
  type LaunchModeResult, type PermissionModeState,
} from './policy.js';

// The launch permission mode settings (STATE_DIR/permission-modes.json) and
// what a launch resolves from them. Each state dir has its own, so dev and
// stable never share them.

export type PermissionModeService = {
  getSettings(): Promise<PermissionModeSettingsResponse>;
  setDefaults(patch: PermissionModeSettingsPatch): Promise<SettingsResult<PermissionModeSettingsResponse>>;
  getSession(sessionId: string): Promise<SessionPermissionModesResponse>;
  setSession(sessionId: string, patch: SessionPermissionModesPatch): Promise<SettingsResult<SessionPermissionModesResponse>>;
  // The mode a launch of `runtimeId` in tmux `sessionId` starts in.
  launchMode(input: { sessionId: string | null; runtimeId: RuntimeId; requested?: PermissionMode; llm?: boolean }): Promise<LaunchModeResult>;
  // As launchMode, for a launch-catalog profile (its runtime looked up).
  launchModeForProfile(input: { sessionId: string | null; profileId: string; requested?: PermissionMode; llm?: boolean }): Promise<LaunchModeResult>;
};

export type SettingsResult<T> = { ok: true; view: T } | { ok: false; status: 400; code: 'invalid_request' | 'permission_mode_unsupported' | 'permission_mode_unavailable'; message: string; params?: Record<string, string> };

type SettingsRefusal = Extract<SettingsResult<unknown>, { ok: false }>;
const bad = (code: SettingsRefusal['code'], message: string, params: Record<string, string>): SettingsRefusal => (
  { ok: false, status: 400, code, message, params }
);

function supportedByRuntime(): Partial<Record<RuntimeId, PermissionMode[]>> {
  return Object.fromEntries(runtimeDrivers().map((driver) => [driver.runtimeId, supportedPermissionModes(driver)]));
}

function unavailableByRuntime(): PermissionModeUnavailability {
  return Object.fromEntries(runtimeDrivers()
    .map((driver) => [driver.runtimeId, unavailablePermissionModes(driver)] as const)
    .filter(([, modes]) => Object.keys(modes).length));
}

// The modes a launch of this runtime can use on this host now.
function supportedFor(runtimeId: RuntimeId): PermissionMode[] {
  const driver = getRuntimeDriver(runtimeId);
  return driver ? usablePermissionModes(driver) : ['cli_default'];
}

function unavailableFor(runtimeId: RuntimeId): PermissionMode[] {
  const driver = getRuntimeDriver(runtimeId);
  return driver ? Object.keys(unavailablePermissionModes(driver)) as PermissionMode[] : [];
}

// A mode chosen for a runtime: refused when it has no flags for it, or this host can't use it now.
function modeRefusal(runtimeId: RuntimeId, mode: PermissionMode): SettingsRefusal | null {
  if (unavailableFor(runtimeId).includes(mode)) {
    return bad('permission_mode_unavailable', `${runtimeId}'s ${mode} mode can't be used on this host now`, { runtimeId, mode });
  }
  if (!supportedFor(runtimeId).includes(mode)) return bad('permission_mode_unsupported', `${runtimeId} can't be started in ${mode} mode`, { runtimeId, mode });
  return null;
}

const settingsView = (state: PermissionModeState): PermissionModeSettingsResponse => (
  { defaults: { ...state.defaults }, supported: supportedByRuntime(), unavailable: unavailableByRuntime() }
);

function sessionView(state: PermissionModeState, sessionId: string): SessionPermissionModesResponse {
  const supported = supportedByRuntime();
  const effective: Partial<Record<RuntimeId, PermissionMode>> = {};
  for (const runtimeId of Object.keys(supported) as RuntimeId[]) {
    effective[runtimeId] = effectiveMode(state, sessionId, runtimeId, supportedFor(runtimeId));
  }
  return { override: { ...(state.sessions[sessionId] ?? {}) }, effective, defaults: { ...state.defaults }, supported, unavailable: unavailableByRuntime() };
}

/**
 * `beforeRead`: brings what the host can use up to date before the
 * settings are read (the Codex sandbox probe, when its answer is stale).
 */
export function createPermissionModeService(
  store: JsonFileStore<PermissionModeState>, options: { beforeRead?: () => Promise<void> } = {},
): PermissionModeService {
  const fresh = () => (options.beforeRead ?? (async () => undefined))().catch(() => undefined);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const service: PermissionModeService = {
    async getSettings() {
      await fresh();
      return settingsView(await store.load());
    },
    setDefaults(patch) {
      return serial(async () => {
        const state = await store.load();
        const next = { ...state.defaults };
        for (const [runtimeId, mode] of Object.entries(patch.defaults) as [RuntimeId, GlobalPermissionMode | null][]) {
          if (mode === null || mode === 'cli_default') {
            delete next[runtimeId];
            continue;
          }
          // The route's schema already refuses yolo; this is the rule itself.
          if ((mode as PermissionMode) === 'yolo') {
            return bad('invalid_request', 'yolo can only be chosen per tmux or per launch, never as a global default', { runtimeId });
          }
          const refused = modeRefusal(runtimeId, mode);
          if (refused) return refused;
          next[runtimeId] = mode;
        }
        state.defaults = next;
        await store.save(state);
        return { ok: true as const, view: settingsView(state) };
      });
    },
    async getSession(sessionId) {
      await fresh();
      return sessionView(await store.load(), sessionId);
    },
    setSession(sessionId, patch) {
      return serial(async () => {
        const state = await store.load();
        const own = { ...(state.sessions[sessionId] ?? {}) };
        for (const [runtimeId, mode] of Object.entries(patch.override) as [RuntimeId, PermissionMode | null][]) {
          if (mode === null) {
            delete own[runtimeId];
            continue;
          }
          const refused = modeRefusal(runtimeId, mode);
          if (refused) return refused;
          own[runtimeId] = mode;
        }
        if (Object.keys(own).length) state.sessions[sessionId] = own;
        else delete state.sessions[sessionId];
        await store.save(state);
        return { ok: true as const, view: sessionView(state, sessionId) };
      });
    },
    async launchMode(input) {
      return resolveLaunchMode({
        ...input, state: await store.load(), supported: supportedFor(input.runtimeId), unavailable: unavailableFor(input.runtimeId),
      });
    },
    async launchModeForProfile({ profileId, ...rest }) {
      const profile = (await getLaunchProfileCatalog()).profiles.find((candidate) => candidate.id === profileId);
      // An unknown profile is refused by the launch itself.
      if (!profile) return { ok: true, mode: 'cli_default' };
      const runtimeId = profile.runtimeId ?? getRuntimeDriverForProvider(profile.provider).runtimeId;
      return service.launchMode({ ...rest, runtimeId });
    },
  };
  return service;
}

export const permissionModeStore = jsonFileStore({ path: PERMISSION_MODES_PATH, empty: emptyPermissionModeState, decode: decodePermissionModeState });

export const permissionModes: PermissionModeService = createPermissionModeService(permissionModeStore, {
  beforeRead: () => refreshCodexSandboxIfStale(),
});
