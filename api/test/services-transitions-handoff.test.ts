import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../src/types.js';

// transitions.handOff: before the running CLI is asked to exit, the profile
// it hands over to must have a CLI the pane can start. /clear restarts the
// CLI already running, so it does not ask.

vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  sessionPresence: vi.fn(async () => 'present'),
  respawnPane: vi.fn(async () => {}),
}));

vi.mock('../src/registry.js', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(async () => []),
  updateSession: vi.fn(),
  beginPendingClear: vi.fn(),
  notePendingClearDelivery: vi.fn(async () => undefined),
  releaseClearAttempt: vi.fn(),
}));

vi.mock('../src/launch-profiles.js', () => ({
  getLaunchProfileCatalog: async () => ({
    profiles: [
      { id: 'native:gemini', provider: 'gemini', source: 'native', label: 'Gemini', executable: 'gemini', args: [] },
      { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', label: 'Claude', executable: 'claude', args: [] },
    ],
  }),
}));

vi.mock('../src/runtimes/command-check.js', () => ({ checkCommandAvailable: vi.fn(async () => 'found') }));

const registry = await import('../src/registry.js');
const tmuxCli = await import('../src/tmux.js');
const commandCheck = await import('../src/runtimes/command-check.js');
const transitions = await import('../src/services/transitions.js');

const claudeProfile = {
  id: 'native:claude', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'native' as const,
  delegate: { kind: 'native' as const, executable: 'claude' },
};

function running(): ManagedSession {
  return {
    id: 'sess-1', tmuxName: 'hestia-sess-1', cwd: '/some/project', projectId: 'proj-1', alias: null,
    createdAt: '2026-01-01T00:00:00Z', provider: 'claude', providerSessionId: 'abc', providerSessionFile: null,
    providerLaunchedAt: '2026-01-01T00:00:00Z', status: 'ready', lastUserMessageAt: null, lastUserMessageText: null,
    deliveryUnconfirmedText: null, lastError: null, pendingInteraction: null, turns: [], turnsSourceFile: null,
    launchProfile: claudeProfile,
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: claudeProfile,
      providerSessionId: 'abc', startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'launch', endReason: null,
      transcript: { state: 'pending', file: null, identity: null }, lastUserMessageAt: null, lastUserMessageText: null,
      deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    }],
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('handing a session over to a profile whose CLI is not installed', () => {
  it('refuses before the running CLI is asked to exit', async () => {
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValueOnce('missing');

    const result = await transitions.handOff(running(), 'native:gemini');

    expect(result).toMatchObject({ ok: false, status: 409, code: 'launch_cli_not_found', params: { command: 'gemini' } });
    expect(commandCheck.checkCommandAvailable).toHaveBeenCalledWith('gemini', { tmuxName: 'hestia-sess-1', cwd: '/some/project' });
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });

  it('hands over when the CLI is there', async () => {
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValueOnce('found');
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...running(), status: 'launching', clearPending: attempt }));

    const result = await transitions.handOff(running(), 'native:gemini');

    expect(result.ok).toBe(true);
    expect(registry.beginPendingClear).toHaveBeenCalledTimes(1);
  });

  it('does not check for /clear, which restarts the CLI already running', async () => {
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...running(), status: 'launching', clearPending: attempt }));

    const result = await transitions.clearAndRelaunch(running());

    expect(result.ok).toBe(true);
    expect(commandCheck.checkCommandAvailable).not.toHaveBeenCalled();
  });
});

// Agy has a verified /exit but no verified interrupt: mid-reply it can't be
// asked to stop, so the switch waits, unless the user forces it.
describe('handing over from a CLI replying with no verified interrupt', () => {
  const agyProfile = {
    id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const, source: 'native' as const,
    delegate: { kind: 'native' as const, executable: 'agy' },
  };
  function replyingAgy(): ManagedSession {
    const base = running();
    return {
      ...base, provider: 'gemini', launchProfile: agyProfile, turnPhase: 'replying',
      conversations: [{ ...base.conversations![0]!, provider: 'gemini', runtimeId: 'agy', launchProfile: agyProfile }],
    } as ManagedSession;
  }

  it('waits for the turn: refused, nothing sent', async () => {
    const result = await transitions.handOff(replyingAgy(), 'native:claude');
    expect(result).toMatchObject({ ok: false, status: 409, code: 'clear_interrupt_unverified' });
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
    expect(tmuxCli.respawnPane).not.toHaveBeenCalled();
  });

  it('forced, resets the pane instead of sending the CLI any key', async () => {
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValueOnce('found');
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...replyingAgy(), status: 'launching', clearPending: attempt }));

    const result = await transitions.handOff(replyingAgy(), 'native:claude', { force: true });

    expect(result.ok).toBe(true);
    expect(tmuxCli.respawnPane).toHaveBeenCalledWith('hestia-sess-1', '/some/project');
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });
});

// Launch permission modes (ADR 0027): /clear starts the CLI again the way
// it was started; a handoff starts the CLI taking over in the mode chosen
// for it, else the tmux's or the global setting — never in the mode the
// conversation being left had.
const { permissionModes } = await import('../src/permission-modes/service.js');

describe('the permission mode of the CLI started', () => {
  const yoloClaude = { ...claudeProfile, permissionMode: 'yolo' as const };
  function runningYolo(): ManagedSession {
    const base = running();
    return { ...base, launchProfile: yoloClaude, conversations: [{ ...base.conversations![0]!, launchProfile: yoloClaude }] };
  }
  const claimed = () => vi.mocked(registry.beginPendingClear).mock.calls[0]![1];

  afterEach(async () => {
    await permissionModes.setSession('sess-1', { override: { 'claude-code': null } });
  });

  it('/clear keeps the mode the conversation was started in', async () => {
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...runningYolo(), status: 'launching', clearPending: attempt }));
    const result = await transitions.clearAndRelaunch(runningYolo());
    expect(result.ok).toBe(true);
    expect(claimed().launchArgv).toContain('bypassPermissions');
  });

  it('a handoff choosing nothing does not carry an earlier one-off yolo over', async () => {
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValue('found');
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...runningYolo(), status: 'launching', clearPending: attempt }));
    const result = await transitions.handOff(runningYolo(), 'native:claude');
    expect(result).toMatchObject({ ok: true, permissionMode: 'cli_default' });
    expect(claimed().launchProfile).not.toHaveProperty('permissionMode');
    expect(claimed().launchArgv).not.toContain('--permission-mode');
  });

  it('a handoff choosing nothing follows the tmux\'s own setting for that runtime', async () => {
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValue('found');
    await permissionModes.setSession('sess-1', { override: { 'claude-code': 'auto' } });
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...running(), status: 'launching', clearPending: attempt }));
    const result = await transitions.handOff(running(), 'native:claude');
    expect(result).toMatchObject({ ok: true, permissionMode: 'auto' });
    expect(claimed().launchProfile?.permissionMode).toBe('auto');
  });

  it('a handoff starts in the mode chosen for it; one the runtime lacks is refused before anything is sent', async () => {
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValue('found');
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => ({ ...running(), status: 'launching', clearPending: attempt }));
    const result = await transitions.handOff(running(), 'native:claude', { permissionMode: 'yolo' });
    expect(result).toMatchObject({ ok: true, permissionMode: 'yolo' });
    expect(claimed().launchArgv).toContain('bypassPermissions');
    vi.mocked(registry.beginPendingClear).mockClear();
    const refused = await transitions.handOff(running(), 'native:gemini', { permissionMode: 'auto' });
    expect(refused).toMatchObject({ ok: false, code: 'permission_mode_unsupported' });
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
  });
});
