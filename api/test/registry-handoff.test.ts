import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stateDir: string;
let registry: typeof import('../src/registry.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-handoff-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

const t = '2026-10-04T00:00:00Z';
const CLAUDE = {
  id: 'janus:claude:work', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'janus' as const, profileName: 'work',
  home: '/h/.claude-work', conversationRoot: '/h/.claude-work/projects', delegate: { kind: 'janus' as const, executable: 'janus' },
};
const CODEX = {
  id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, source: 'native' as const,
  home: '/h/.codex', conversationRoot: '/h/.codex/sessions', delegate: { kind: 'native' as const, executable: 'codex' },
};

async function runningClaude(): Promise<{ id: string; first: string }> {
  const { id } = await registry.createSession('/p', 'proj-1');
  await registry.beginPendingLaunch(id, { provider: 'claude', providerSessionId: 'sid-1', providerLaunchedAt: t, previousStatus: 'idle', launchProfile: CLAUDE });
  const launched = await registry.commitConversationLaunch(id, { provider: 'claude', providerSessionId: 'sid-1', providerLaunchedAt: t, launchProfile: CLAUDE }, t);
  return { id, first: launched!.activeConversationId! };
}

const attempt = (attemptId: string, conversationId: string) => ({
  attemptId, conversationId, newProviderSessionId: null, launchArgv: ['codex'], startedAt: t,
  previousStatus: 'ready' as const, phase: 'waiting_exit' as const, launchStartedAt: null,
});

describe('a handoff through the /clear claim', () => {
  it('starts the new conversation on the target profile, as a provider switch', async () => {
    const { id, first } = await runningClaude();
    const claimed = await registry.beginPendingClear(id, {
      ...attempt('h1', first), provider: 'codex', runtimeId: 'codex-cli', exitProvider: 'claude', launchProfile: CODEX,
    });
    expect(claimed?.clearPending).toMatchObject({ provider: 'codex', exitProvider: 'claude', launchProfile: { id: 'native:codex' } });
    await registry.beginPendingClearLaunch(id, 'h1');
    const done = await registry.commitPendingClear(id, 'h1');
    expect(done).toMatchObject({ provider: 'codex', runtimeId: 'codex-cli', status: 'ready', launchProfile: { id: 'native:codex' } });
    const [left, started] = done!.conversations!;
    expect(left).toMatchObject({ id: first, provider: 'claude', endReason: 'provider_switch' });
    expect(started).toMatchObject({ provider: 'codex', startReason: 'provider_switch', launchProfile: { id: 'native:codex' } });
    expect(done!.activeConversationId).toBe(started!.id);
  });

  it('is refused when the CLI being left is not the one running', async () => {
    const { id, first } = await runningClaude();
    expect(await registry.beginPendingClear(id, {
      ...attempt('h1', first), provider: 'codex', runtimeId: 'codex-cli', exitProvider: 'codex', launchProfile: CODEX,
    })).toBeNull();
  });

  it('an ordinary /clear still restarts the same profile', async () => {
    const { id, first } = await runningClaude();
    await registry.beginPendingClear(id, { ...attempt('c1', first), provider: 'claude', runtimeId: 'claude-code' });
    await registry.beginPendingClearLaunch(id, 'c1');
    const done = await registry.commitPendingClear(id, 'c1');
    expect(done!.conversations!.at(-1)).toMatchObject({ provider: 'claude', startReason: 'clear', launchProfile: { id: 'janus:claude:work' } });
    expect(done!.conversations![0]).toMatchObject({ endReason: 'clear' });
  });
});
