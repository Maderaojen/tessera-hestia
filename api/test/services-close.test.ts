import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../src/types.js';

vi.mock('../src/tmux.js', () => ({
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  getPaneLiveness: vi.fn(async () => 'alive'),
  sessionPresence: vi.fn(async () => 'present'),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
}));
vi.mock('../src/registry.js', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(async () => []),
  markDeadUnlessRunning: vi.fn(async () => []),
}));

const registry = await import('../src/registry.js');
const tmux = await import('../src/tmux.js');
const { closeSession } = await import('../src/services/sessions.js');
const { isClosing } = await import('../src/sync/closing.js');

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 's1', tmuxName: 'hestia-s1', cwd: '/p', projectId: 'p1', alias: null, createdAt: 'x', provider: 'claude',
    providerSessionId: 'abc', providerSessionFile: null, providerLaunchedAt: 'x', status: 'ready', turnPhase: 'idle',
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null, pendingInteraction: null,
    turns: [], turnsSourceFile: null, activeConversationId: 'c1',
    conversations: [{
      id: 'c1', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: null, providerSessionId: 'abc',
      startedAt: 'x', endedAt: null, startReason: 'launch', endReason: null, transcript: { state: 'resolved', file: '/t', identity: 'pinned_id' },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    }],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.mocked(registry.listSessions).mockResolvedValue([]);
  vi.mocked(registry.markDeadUnlessRunning).mockResolvedValue([]);
  vi.mocked(tmux.listManagedSessionNames).mockResolvedValue([]);
  vi.mocked(tmux.sessionPresence).mockResolvedValue('present');
});

describe('closeSession', () => {
  it("asks the CLI to exit, waits for it, then ends the tmux and keeps the record", async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session());
    vi.mocked(tmux.getPaneLiveness).mockResolvedValueOnce('alive').mockResolvedValueOnce('alive').mockResolvedValue('dead');
    const result = await closeSession('s1');
    expect(result.status).toBe('closed');
    expect(tmux.sendText).toHaveBeenCalledWith('hestia-s1', '/exit');
    expect(tmux.killSession).toHaveBeenCalledWith('hestia-s1');
    // Marked dead the way a tmux that died is, not removed.
    expect(registry.markDeadUnlessRunning).toHaveBeenCalled();
    expect(isClosing('s1')).toBe(false);
  });

  it('ends a session whose tmux is already gone without typing anything', async () => {
    // The pane can't be read, and tmux confirms the session is missing.
    vi.mocked(registry.getSession).mockResolvedValue(session());
    vi.mocked(tmux.getPaneLiveness).mockResolvedValue('unknown');
    vi.mocked(tmux.sessionPresence).mockResolvedValue('gone');
    expect((await closeSession('s1')).status).toBe('closed');
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKey).not.toHaveBeenCalled();
    expect(registry.markDeadUnlessRunning).toHaveBeenCalled();
  });

  it('counts the CLI as exited when its tmux disappears during the wait', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session());
    vi.mocked(tmux.getPaneLiveness).mockResolvedValueOnce('alive').mockResolvedValue('unknown');
    vi.mocked(tmux.sessionPresence).mockResolvedValue('gone');
    expect((await closeSession('s1')).status).toBe('closed');
    expect(tmux.sendText).toHaveBeenCalledWith('hestia-s1', '/exit');
  });

  it('does not take an unreadable pane for a gone tmux unless tmux says so', async () => {
    vi.useFakeTimers();
    vi.mocked(registry.getSession).mockResolvedValue(session());
    vi.mocked(tmux.getPaneLiveness).mockResolvedValue('unknown');
    vi.mocked(tmux.sessionPresence).mockResolvedValue('unknown');
    const closing = closeSession('s1');
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await closing).status).toBe('exit_unverified');
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it('interrupts a reply first where the runtime has a verified interrupt', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session({ turnPhase: 'replying' }));
    vi.mocked(tmux.getPaneLiveness).mockResolvedValueOnce('alive').mockResolvedValue('dead');
    expect((await closeSession('s1')).status).toBe('closed');
    expect(tmux.sendKey).toHaveBeenCalledWith('hestia-s1', 'Escape');
    expect(tmux.sendText).toHaveBeenCalledWith('hestia-s1', '/exit');
  });

  it('leaves the tmux alone when the CLI does not exit in time', async () => {
    vi.useFakeTimers();
    vi.mocked(registry.getSession).mockResolvedValue(session());
    vi.mocked(tmux.getPaneLiveness).mockResolvedValue('alive');
    const closing = closeSession('s1');
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await closing).status).toBe('exit_unverified');
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(isClosing('s1')).toBe(false);
  });

  it('refuses a replying CLI with no verified interrupt (Agy), unless forced', async () => {
    const agy = session({ provider: 'gemini', runtimeId: 'agy', turnPhase: 'replying' });
    agy.conversations![0] = { ...agy.conversations![0]!, provider: 'gemini', runtimeId: 'agy' };
    vi.mocked(registry.getSession).mockResolvedValue(agy);
    expect((await closeSession('s1')).status).toBe('cli_busy');
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect((await closeSession('s1', { force: true })).status).toBe('closed');
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.killSession).toHaveBeenCalledWith('hestia-s1');
  });

  it('types nothing into a start-up prompt: its Enter would answer it', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session({ startupPrompt: { kind: 'workspace_trust', detectedAt: 'x' } }));
    expect((await closeSession('s1')).status).toBe('closed');
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKey).not.toHaveBeenCalled();
  });

  it('does not run alongside a restart or switch', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session({ clearPending: { phase: 'waiting_exit' } as never }));
    expect((await closeSession('s1')).status).toBe('in_transition');
    expect(tmux.killSession).not.toHaveBeenCalled();
  });
});
