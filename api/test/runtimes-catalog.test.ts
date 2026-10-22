import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeAccounts, probePath } from '../src/account-status/accounts.js';
import { probeAccount } from '../src/account-status/index.js';
import { nativeProfiles } from '../src/launch-profiles.js';
import { messageFor } from '../src/notifications.js';
import { accountRuntimeFor, isRuntimeId, janusRuntimeFor, productProviders, runtimeDrivers } from '../src/runtimes/index.js';
import type { PublicManagedSession } from '../src/session-dto.js';

// What used to be hand-written per runtime in launch-profiles.ts,
// notifications.ts and account-status/ is now read off the drivers. These
// pin the outputs those lists had, so moving them changed nothing visible.
describe('runtime catalog', () => {
  it('lists every runtime once, providers in order', () => {
    expect(runtimeDrivers().map((driver) => driver.runtimeId)).toEqual(['claude-code', 'codex-cli', 'gemini-cli', 'agy']);
    expect(productProviders()).toEqual(['claude', 'codex', 'gemini']);
    expect(['claude-code', 'codex-cli', 'gemini-cli', 'agy', 'legacy-unknown'].every(isRuntimeId)).toBe(true);
    expect(isRuntimeId('gemini')).toBe(false);
    expect(isRuntimeId('toString')).toBe(false);
    expect(isRuntimeId(undefined)).toBe(false);
  });

  it('offers the same native launch profiles as before', () => {
    expect(nativeProfiles().map(({ id, provider, runtimeId, label, executable, args }) => ({ id, provider, runtimeId, label, executable, args }))).toEqual([
      { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', label: 'Claude (原生)', executable: 'claude', args: [] },
      { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', label: 'Codex (原生)', executable: 'codex', args: [] },
      { id: 'native:gemini', provider: 'gemini', runtimeId: 'gemini-cli', label: 'Gemini CLI（相容）', executable: 'gemini', args: [] },
      { id: 'native:agy', provider: 'gemini', runtimeId: 'agy', label: 'Gemini · Agy', executable: 'agy', args: [] },
    ]);
  });

  it('lets Janus run only Claude and Codex, each under its own conversation folder', () => {
    expect(janusRuntimeFor('claude')?.janus?.conversationSubdir).toBe('projects');
    expect(janusRuntimeFor('codex')?.janus?.conversationSubdir).toBe('sessions');
    expect(janusRuntimeFor('gemini')).toBeUndefined();
  });

  it('names the CLI in notifications by its runtime label', () => {
    const base = { id: 's1', cwd: '/w/app', alias: null, turnPhase: 'idle', activity: 'idle' } as const;
    const body = (runtimeId: string | null, provider: string | null) => messageFor(
      { phase: 'replying', activity: 'busy' },
      { ...base, runtimeId, provider } as unknown as PublicManagedSession,
    )?.body;
    expect(body('codex-cli', 'codex')).toBe('Codex CLI 回覆完成');
    expect(body('gemini-cli', 'gemini')).toBe('Gemini CLI 回覆完成');
    expect(body('agy', 'gemini')).toBe('Gemini · Agy 回覆完成');
    expect(body(null, 'codex')).toBe('codex 回覆完成');
    expect(body(null, null)).toBe('CLI 回覆完成');
  });

  it("lists each provider's own default account with the same launch environment", () => {
    const PATH = probePath();
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    expect(nativeAccounts()).toEqual([
      { id: 'native:claude:default', provider: 'claude', name: 'default', source: 'native', home: path.join(os.homedir(), '.claude'), launch: ['claude'], env: { PATH, DISABLE_AUTOUPDATER: '1' }, unsetEnv: ['CLAUDE_CONFIG_DIR'] },
      { id: 'native:codex:default', provider: 'codex', name: 'default', source: 'native', home: codexHome, launch: ['codex'], env: { PATH, CODEX_HOME: codexHome }, unsetEnv: [] },
      { id: 'native:gemini:default', provider: 'gemini', name: 'default', source: 'native', home: path.join(os.homedir(), '.gemini'), launch: ['gemini'], env: { PATH }, unsetEnv: [] },
    ]);
  });

  it('probes usage only for providers whose runtime has a source', async () => {
    expect(accountRuntimeFor('claude')?.runtimeId).toBe('claude-code');
    expect(accountRuntimeFor('codex')?.runtimeId).toBe('codex-cli');
    expect(accountRuntimeFor('gemini')).toBeUndefined();
    const gemini = {
      id: 'native:gemini:default', provider: 'gemini', name: 'default', source: 'native' as const, home: '/h/.gemini',
      launch: [process.execPath], env: { PATH: '' }, unsetEnv: [],
    };
    await expect(probeAccount(gemini)).resolves.toMatchObject({ state: 'unsupported' });
  });
});
