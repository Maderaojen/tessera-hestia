import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECAP_RUNNER_DIR, RECAP_SETTINGS_PATH, STATE_DIR } from '../../src/config.js';
import { applyRecapSettingsPatch, decodeRecapSettings, emptyRecapSettings, recapSettingsStore, type RecapSettingsState } from '../../src/recap/settings-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'recap-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = '2026-10-05T02:00:00.000Z';

describe('the recap settings file', () => {
  it('lives in the state dir, with the runner\'s folder beside it', () => {
    expect(RECAP_SETTINGS_PATH).toBe(path.join(STATE_DIR, 'conversation-recap.json'));
    expect(RECAP_RUNNER_DIR).toBe(path.join(STATE_DIR, 'recap-runner'));
  });

  it('starts off, with nothing chosen', async () => {
    expect(await recapSettingsStore(path.join(dir, 'r.json')).load()).toEqual({
      version: 1, enabled: false, profileId: null, model: null, effort: null, backfillOld: false, enabledAt: null, pause: null,
    });
  });

  it('is saved and read back', async () => {
    const file = path.join(dir, 'r.json');
    const state: RecapSettingsState = {
      ...emptyRecapSettings(), enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabledAt: NOW,
      pause: { code: 'account_limited', until: '2026-10-05T05:00:00.000Z', at: NOW },
    };
    await recapSettingsStore(file).save(state);
    expect(await recapSettingsStore(file).load()).toEqual(state);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual(state);
  });

  it.each([
    ['not an object', 'x'],
    ['fields of the wrong type', { enabled: 'yes', profileId: 3, backfillOld: 1 }],
    ['an unknown pause', { enabled: true, pause: { code: 'tired', at: NOW } }],
  ])('falls back to the defaults for %s', (_name, raw) => {
    const decoded = decodeRecapSettings(raw);
    expect(decoded.pause).toBeNull();
    expect(decoded.profileId).toBeNull();
    expect(decoded.backfillOld).toBe(false);
  });

  it('a file that isn\'t JSON fails the load instead of passing for the defaults', async () => {
    const file = path.join(dir, 'r.json');
    await writeFile(file, '{');
    await expect(recapSettingsStore(file).load()).rejects.toThrow();
  });
});

describe('applyRecapSettingsPatch', () => {
  const on: RecapSettingsState = { ...emptyRecapSettings(), enabled: true, profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabledAt: '2026-10-01T00:00:00.000Z' };

  it('stamps enabledAt each time the recaps are turned on, and only then', () => {
    expect(applyRecapSettingsPatch(emptyRecapSettings(), { enabled: true, profileId: 'p', model: 'm' }, NOW).enabledAt).toBe(NOW);
    expect(applyRecapSettingsPatch(on, { enabled: true, backfillOld: true }, NOW).enabledAt).toBe(on.enabledAt);
    const off = applyRecapSettingsPatch(on, { enabled: false }, NOW);
    expect(off.enabledAt).toBe(on.enabledAt);
    expect(applyRecapSettingsPatch(off, { enabled: true }, '2026-10-06T00:00:00.000Z').enabledAt).toBe('2026-10-06T00:00:00.000Z');
  });

  it.each([
    ['another account lifts a gone account', 'profile_unavailable', { profileId: 'janus:x' }, null],
    ['another model lifts a refused model', 'model_rejected', { model: 'gpt-6-sol' }, null],
    ['another account lifts an account over its limit', 'account_limited', { profileId: 'janus:x' }, null],
    ['another model keeps an account over its limit', 'account_limited', { model: 'gpt-6-sol' }, 'account_limited'],
    ['another effort lifts nothing', 'model_rejected', { effort: 'high' }, 'model_rejected'],
    ['the same account again lifts nothing', 'profile_unavailable', { profileId: 'native:codex' }, 'profile_unavailable'],
  ] as const)('%s', (_name, code, patch, expected) => {
    const paused: RecapSettingsState = { ...on, pause: { code, until: null, at: NOW } };
    expect(applyRecapSettingsPatch(paused, patch, NOW).pause?.code ?? null).toBe(expected);
  });
});
