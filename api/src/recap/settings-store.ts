import type { ConversationRecapPause, ConversationRecapSettings } from '../contract/recap.js';
import { RECAP_SETTINGS_PATH } from '../config.js';
import { jsonFileStore, type JsonFileStore } from '@maderaojen/json-file-store';

// The recap settings and the global pause (STATE_DIR/conversation-recap.json). Each state dir has its own, so a
// dev and a stable backend never share them, and a backend that never
// turned recaps on never runs one. The queue itself isn't kept: it is
// rebuilt from the conversations and their recaps on start.

export type RecapSettingsState = ConversationRecapSettings & {
  version: 1;
  // When the recaps were last turned on.
  enabledAt: string | null;
  pause: ConversationRecapPause;
};

export function emptyRecapSettings(): RecapSettingsState {
  return { version: 1, enabled: false, profileId: null, model: null, effort: null, backfillOld: false, enabledAt: null, pause: null };
}

const PAUSE_CODES = new Set(['profile_unavailable', 'model_rejected', 'account_limited']);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Whatever is on disk, made the current shape; anything unreadable falls back to the defaults. */
export function decodeRecapSettings(raw: unknown): RecapSettingsState {
  const state = emptyRecapSettings();
  if (!raw || typeof raw !== 'object') return state;
  const r = raw as Record<string, unknown>;
  const pause = r.pause as Record<string, unknown> | null | undefined;
  return {
    ...state,
    enabled: r.enabled === true,
    profileId: stringOrNull(r.profileId),
    model: stringOrNull(r.model),
    effort: stringOrNull(r.effort),
    backfillOld: r.backfillOld === true,
    enabledAt: stringOrNull(r.enabledAt),
    pause: pause && typeof pause === 'object' && PAUSE_CODES.has(pause.code as string) && typeof pause.at === 'string'
      ? { code: pause.code as NonNullable<ConversationRecapPause>['code'], until: stringOrNull(pause.until), at: pause.at }
      : null,
  };
}

export function recapSettingsStore(path: string = RECAP_SETTINGS_PATH): JsonFileStore<RecapSettingsState> {
  return jsonFileStore({ path, empty: emptyRecapSettings, decode: decodeRecapSettings });
}

/**
 * The settings with `patch` applied (already validated). Turning recaps on
 * stamps enabledAt; picking another account or model lifts a pause that was
 * about the old one (a gone account, a refused model, an account over its
 * limit). Nothing ever picks another account by itself.
 */
export function applyRecapSettingsPatch(state: RecapSettingsState, patch: Partial<ConversationRecapSettings>, now: string): RecapSettingsState {
  const next: RecapSettingsState = { ...state, ...patch };
  if (next.enabled && !state.enabled) next.enabledAt = now;
  const accountChanged = next.profileId !== state.profileId;
  const modelChanged = next.model !== state.model;
  if (accountChanged || (modelChanged && state.pause?.code !== 'account_limited')) next.pause = null;
  return next;
}
