import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchProfileSnapshot, ManagedSession } from '../src/types.js';

vi.mock('../src/tmux.js', () => ({
  sessionPresence: vi.fn(async () => 'present'),
  respawnPane: vi.fn(async () => {}),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
}));
vi.mock('../src/launch-profiles.js', () => ({ getLaunchProfileCatalog: vi.fn() }));
vi.mock('../src/runtimes/command-check.js', () => ({ checkCommandAvailable: vi.fn(async () => 'found') }));

let stateDir: string;
let registry: typeof import('../src/registry.js');
let transitions: typeof import('../src/services/transitions.js');
let catalog: typeof import('../src/launch-profiles.js');
let commandCheck: typeof import('../src/runtimes/command-check.js');
let tmux: typeof import('../src/tmux.js');
let source: ManagedSession;
const at = '2026-10-09T00:00:00Z';
const profile: LaunchProfileSnapshot = {
  id: 'native:agy', provider: 'gemini', runtimeId: 'agy', source: 'native',
  delegate: { kind: 'native', executable: 'agy' },
};
const target = { id: 'native:claude', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'native' as const, label: 'Claude', executable: 'claude', args: [] };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-handoff-source-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
  transitions = await import('../src/services/transitions.js');
  catalog = await import('../src/launch-profiles.js');
  commandCheck = await import('../src/runtimes/command-check.js');
  tmux = await import('../src/tmux.js');
  vi.mocked(catalog.getLaunchProfileCatalog).mockResolvedValue({ profiles: [target], discoveredAt: at, janus: { available: false, error: null } });
  vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValue('found');
  const created = await registry.createSession('/project', 'project-1');
  await registry.beginPendingLaunch(created.id, { provider: 'gemini', providerSessionId: 'old-native', providerLaunchedAt: at, previousStatus: 'idle', launchProfile: profile });
  await registry.commitConversationLaunch(created.id, { provider: 'gemini', providerSessionId: 'old-native', providerLaunchedAt: at, launchProfile: profile }, at);
  source = (await registry.updateSession(created.id, { turnPhase: 'replying' }))!;
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

async function replaceSource(): Promise<ManagedSession> {
  const old = source.conversations![0]!;
  return (await registry.updateSession(source.id, {
    activeConversationId: 'replacement', providerSessionId: 'replacement-native',
    conversations: [
      { ...old, endedAt: at, endReason: 'clear' },
      { ...old, id: 'replacement', sequence: 2, providerSessionId: 'replacement-native' },
    ],
  }))!;
}

function expectNoDispatch(): void {
  expect(tmux.respawnPane).not.toHaveBeenCalled();
  expect(tmux.sendKey).not.toHaveBeenCalled();
  expect(tmux.sendText).not.toHaveBeenCalled();
  expect(tmux.sendCommandLine).not.toHaveBeenCalled();
}

// Real registry claims protect dispatch across stale snapshots and
// asynchronous preflight; only tmux and command discovery are faked.
describe('handoff source ownership', () => {
  it('refuses a stale handoff even when wiring supplies the replacement session', async () => {
    const replacement = await replaceSource();
    const result = await transitions.handOff(replacement, target.id, { force: true, expectedConversationId: source.activeConversationId! });
    expect(result).toMatchObject({ ok: false, code: 'clear_state_changed' });
    expectNoDispatch();
    expect(await registry.getSession(source.id)).toEqual(replacement);
  });

  it.each(['catalog', 'command'] as const)('refuses when the source changes during the %s await', async (during) => {
    let replacement: ManagedSession | undefined;
    if (during === 'catalog') {
      vi.mocked(catalog.getLaunchProfileCatalog).mockImplementationOnce(async () => {
        replacement = await replaceSource();
        return { profiles: [target], discoveredAt: at, janus: { available: false, error: null } };
      });
    } else {
      vi.mocked(commandCheck.checkCommandAvailable).mockImplementationOnce(async () => {
        replacement = await replaceSource();
        return 'found';
      });
    }
    const result = await transitions.handOff(source, target.id, { force: true, expectedConversationId: source.activeConversationId! });
    expect(result).toMatchObject({ ok: false, code: 'clear_state_changed' });
    expectNoDispatch();
    expect(await registry.getSession(source.id)).toEqual(replacement);
  });

  it.each(['ended', 'switching'] as const)('refuses if the source becomes %s during preflight', async (change) => {
    let changed: ManagedSession | undefined;
    vi.mocked(commandCheck.checkCommandAvailable).mockImplementationOnce(async () => {
      changed = (await registry.updateSession(source.id, change === 'ended'
        ? { conversations: [{ ...source.conversations![0]!, endedAt: at, endReason: 'clear' }] }
        : { status: 'launching' }))!;
      return 'found';
    });
    const result = await transitions.handOff(source, target.id, { force: true, expectedConversationId: source.activeConversationId! });
    expect(result).toMatchObject({ ok: false, code: 'clear_state_changed' });
    expectNoDispatch();
    expect(await registry.getSession(source.id)).toEqual(changed);
  });

  it('forces the same source successfully after its atomic claim', async () => {
    const result = await transitions.handOff(source, target.id, { force: true, expectedConversationId: source.activeConversationId! });
    expect(result.ok).toBe(true);
    expect(tmux.respawnPane).toHaveBeenCalledOnce();
    expect(tmux.sendKey).not.toHaveBeenCalled();
    const claimed = await registry.getSession(source.id);
    expect(claimed?.clearPending).toMatchObject({ conversationId: source.activeConversationId, exitProvider: 'gemini', provider: 'claude' });
    expect(claimed?.activeConversationId).toBe(source.activeConversationId);
  });
});
