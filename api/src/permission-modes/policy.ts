import {
  GLOBAL_PERMISSION_MODES, isPermissionMode, type GlobalPermissionMode, type PermissionMode,
} from '../contract/permissions.js';
import { isRuntimeId, type RuntimeId } from '../contract/runtimes.js';

// Which launch permission mode applies:
// one launch's own choice, else the tmux's own setting, else the global
// default for that runtime, else cli_default. Pure: the state comes in.

export type PermissionModeState = {
  version: 1;
  // Never yolo: a global default can only be cli_default or auto.
  defaults: Partial<Record<RuntimeId, GlobalPermissionMode>>;
  // Per tmux (session id): its own choice per runtime, yolo included.
  sessions: Record<string, Partial<Record<RuntimeId, PermissionMode>>>;
};

export function emptyPermissionModeState(): PermissionModeState {
  return { version: 1, defaults: {}, sessions: {} };
}

const isGlobalMode = (value: unknown): value is GlobalPermissionMode =>
  typeof value === 'string' && (GLOBAL_PERMISSION_MODES as readonly string[]).includes(value);

function decodeModes<T extends PermissionMode>(raw: unknown, keep: (value: unknown) => value is T): Partial<Record<RuntimeId, T>> {
  const modes: Partial<Record<RuntimeId, T>> = {};
  if (!raw || typeof raw !== 'object') return modes;
  for (const [runtimeId, mode] of Object.entries(raw)) {
    if (isRuntimeId(runtimeId) && keep(mode) && mode !== 'cli_default') modes[runtimeId] = mode;
  }
  return modes;
}

/** Whatever is on disk, made the current shape: unknown values, and a yolo default, are dropped. */
export function decodePermissionModeState(raw: unknown): PermissionModeState {
  const state = emptyPermissionModeState();
  if (!raw || typeof raw !== 'object') return state;
  const r = raw as Record<string, unknown>;
  state.defaults = decodeModes(r.defaults, isGlobalMode);
  for (const [sessionId, own] of Object.entries(r.sessions && typeof r.sessions === 'object' ? r.sessions : {})) {
    // A tmux may choose cli_default against an auto default: kept.
    const modes: Partial<Record<RuntimeId, PermissionMode>> = {};
    for (const [runtimeId, mode] of Object.entries(own && typeof own === 'object' ? own : {})) {
      if (isRuntimeId(runtimeId) && isPermissionMode(mode)) modes[runtimeId] = mode;
    }
    if (Object.keys(modes).length) state.sessions[sessionId] = modes;
  }
  return state;
}

/**
 * The mode a launch of `runtimeId` in this tmux gets when it doesn't
 * choose one: the tmux's own, else the global default. One the runtime
 * can't start in (a setting saved before its support changed) is
 * cli_default.
 */
export function effectiveMode(
  state: PermissionModeState, sessionId: string | null, runtimeId: RuntimeId, supported: readonly PermissionMode[],
): PermissionMode {
  return effectiveModeDetail(state, sessionId, runtimeId, supported).mode;
}

/** As effectiveMode, with the saved mode it fell back from (one this host can't use now, say). */
export function effectiveModeDetail(
  state: PermissionModeState, sessionId: string | null, runtimeId: RuntimeId, supported: readonly PermissionMode[],
): { mode: PermissionMode; fallbackFrom?: PermissionMode } {
  const saved = (sessionId ? state.sessions[sessionId]?.[runtimeId] : undefined) ?? state.defaults[runtimeId] ?? 'cli_default';
  return supported.includes(saved) ? { mode: saved } : { mode: 'cli_default', fallbackFrom: saved };
}

/**
 * What an LLM's own delegation may start its delegate in: never yolo — the
 * runtime's auto when it has one, else cli_default.
 */
export function capForLlm(mode: PermissionMode, supported: readonly PermissionMode[]): PermissionMode {
  if (mode !== 'yolo') return mode;
  return supported.includes('auto') ? 'auto' : 'cli_default';
}

// `fallbackFrom`: the saved mode it couldn't use (cli_default instead).
export type LaunchModeResult =
  | { ok: true; mode: PermissionMode; fallbackFrom?: PermissionMode }
  | { ok: false; code: 'permission_mode_unsupported' | 'permission_mode_unavailable'; message: string };

/**
 * The mode a launch starts in. `requested` is the user's own choice for
 * this launch (only ever from their login); without one, the tmux's or the
 * global setting. `supported`: the modes usable on this host now;
 * `unavailable`: ones the runtime has but this host can't use (a request
 * for one is refused with its own code; a saved one starts as cli_default,
 * `fallbackFrom` saying so). `llm`: started by an LLM, so capped
 * (capForLlm).
 */
export function resolveLaunchMode(input: {
  state: PermissionModeState; sessionId: string | null; runtimeId: RuntimeId; supported: readonly PermissionMode[];
  unavailable?: readonly PermissionMode[]; requested?: PermissionMode; llm?: boolean;
}): LaunchModeResult {
  const { requested, supported } = input;
  if (requested && input.unavailable?.includes(requested)) {
    return { ok: false, code: 'permission_mode_unavailable', message: `this CLI's ${requested} mode can't be used on this host now` };
  }
  if (requested && !supported.includes(requested)) {
    return { ok: false, code: 'permission_mode_unsupported', message: `this CLI can't be started in ${requested} mode` };
  }
  const detail = requested ? { mode: requested } : effectiveModeDetail(input.state, input.sessionId, input.runtimeId, supported);
  const mode = input.llm ? capForLlm(detail.mode, supported) : detail.mode;
  return { ok: true, mode, ...('fallbackFrom' in detail && detail.fallbackFrom ? { fallbackFrom: detail.fallbackFrom } : {}) };
}
