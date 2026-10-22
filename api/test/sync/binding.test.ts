import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSegment, ManagedSession } from '../../src/types.js';

const locateSessionFile = vi.fn();
const parseTurns = vi.fn();
vi.mock('../../src/runtimes/index.js', () => ({
  getRuntimeDriver: (runtimeId: string) => ({ runtimeId, provider: 'claude', name: 'claude', locateSessionFile, parseTurns }),
}));
const updateConversation = vi.fn();
vi.mock('../../src/registry.js', () => ({ updateConversation: (...args: unknown[]) => updateConversation(...args) }));

const { activeConversation, ensureBinding, establishTurnBaseline, resolvedBinding, turnsBefore } = await import('../../src/sync/binding.js');

function conversation(overrides: Partial<ConversationSegment> = {}): ConversationSegment {
  return {
    id: 'c1', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: null, providerSessionId: 'p',
    startedAt: 't', endedAt: null, startReason: 'launch', endReason: null,
    transcript: { state: 'resolved', file: '/fake/t.jsonl', identity: 'pinned_id' },
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null,
    pendingInteraction: null, transcriptError: null, turns: [], ...overrides,
  };
}

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 's1', tmuxName: 'hestia-s1', cwd: '/p', projectId: 'p1', alias: null, createdAt: 't',
    provider: 'claude', providerSessionId: 'p', providerSessionFile: null, providerLaunchedAt: 't',
    status: 'ready', lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null,
    lastError: null, pendingInteraction: null, turns: [], turnsSourceFile: null,
    activeConversationId: 'c1', conversations: [conversation()], ...overrides,
  };
}

describe('sync binding', () => {
  it('binds the active conversation to its resolved transcript', () => {
    const binding = resolvedBinding(session());
    expect(binding?.file).toBe('/fake/t.jsonl');
    expect(binding?.conversation.id).toBe('c1');
    expect(binding?.adapter).toMatchObject({ runtimeId: 'claude-code', provider: 'claude', name: 'claude' });
  });

  it('refuses without a runtime provider, an active conversation, or a matching provider', () => {
    expect(activeConversation(session({ provider: null }))).toBeUndefined();
    expect(activeConversation(session({ activeConversationId: null }))).toBeUndefined();
    expect(activeConversation(session({ activeConversationId: 'gone' }))).toBeUndefined();
    expect(activeConversation(session({ conversations: [conversation({ provider: 'codex' })] }))).toBeUndefined();
  });

  it('refuses any transcript that is not positively resolved', () => {
    const unresolved = [
      { state: 'pending', file: null, identity: null },
      { state: 'ambiguous', file: null, identity: null },
      { state: 'resolved', file: null, identity: 'pinned_id' },
      { state: 'resolved', file: '/fake/t.jsonl', identity: null },
    ] as const;
    for (const transcript of unresolved) {
      expect(resolvedBinding(session({ conversations: [conversation({ transcript: { ...transcript } })] }))).toBeNull();
    }
  });
});

describe('ensureBinding', () => {
  const pending = { transcript: { state: 'pending' as const, file: null, identity: null } };
  const profile = {
    id: 'native:claude', provider: 'claude' as const, source: 'native' as const, conversationRoot: '/segment/projects',
    delegate: { kind: 'native' as const, executable: 'claude' },
  };

  beforeEach(() => {
    locateSessionFile.mockReset();
    updateConversation.mockReset();
    parseTurns.mockReset();
  });

  it('returns an existing binding without looking anything up', async () => {
    expect((await ensureBinding(session(), { withoutSessionId: false }))?.justBound).toBe(false);
    expect(locateSessionFile).not.toHaveBeenCalled();
  });

  it("looks the transcript up under the segment's profile and binds what it finds", async () => {
    const unbound = session({ conversations: [conversation({ ...pending, launchProfile: profile })] });
    locateSessionFile.mockResolvedValueOnce({ status: 'resolved', file: '/segment/projects/x.jsonl', identity: 'pinned_id' });
    updateConversation.mockImplementationOnce(async (_id, _cid, patch) => session({ conversations: [conversation({ ...patch, launchProfile: profile })] }));

    const bound = await ensureBinding(unbound, { withoutSessionId: false });

    expect(locateSessionFile).toHaveBeenCalledWith({ cwd: '/p', providerSessionId: 'p', launchedAfter: 't', conversationRoot: '/segment/projects' });
    expect(bound).toMatchObject({ justBound: true, binding: { file: '/segment/projects/x.jsonl' } });
  });

  it('records an ambiguous lookup once and binds nothing', async () => {
    const unbound = session({ conversations: [conversation(pending)] });
    locateSessionFile.mockResolvedValue({ status: 'ambiguous' });
    expect(await ensureBinding(unbound, { withoutSessionId: true })).toBeNull();
    expect(updateConversation).toHaveBeenCalledWith('s1', 'c1', {
      transcript: { state: 'ambiguous', file: null, identity: null }, transcriptError: expect.stringContaining('無法確定'),
    });
    updateConversation.mockClear();
    const recorded = session({ conversations: [conversation({
      transcript: { state: 'ambiguous', file: null, identity: null }, transcriptError: '無法確定哪份對話紀錄屬於這個 tmux，未匯入任何回覆。',
    })] });
    expect(await ensureBinding(recorded, { withoutSessionId: true })).toBeNull();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it('waits for a session id unless told it may look without one', async () => {
    const noId = session({ conversations: [conversation({ ...pending, providerSessionId: null })] });
    locateSessionFile.mockResolvedValue({ status: 'pending' });
    expect(await ensureBinding(noId, { withoutSessionId: false })).toBeNull();
    expect(locateSessionFile).not.toHaveBeenCalled();
    await ensureBinding(noId, { withoutSessionId: true });
    expect(locateSessionFile).toHaveBeenCalledTimes(1);
  });
});

describe('establishTurnBaseline', () => {
  const asked = (at: string | null) => ({ user: { text: 'q', at } });

  it('skips the turns a branch line\'s fork came with: those asked before it started', async () => {
    parseTurns.mockResolvedValueOnce([asked('2026-10-08T09:00:00.000Z'), asked('2026-10-08T09:02:43.778Z'), asked('2026-10-08T09:03:32.661Z')]);
    const forked = resolvedBinding(session({ conversations: [conversation({ startReason: 'fork', startedAt: '2026-10-08T09:03:20.000Z', transcriptTurnOffset: null })] }))!;
    expect(await establishTurnBaseline(forked)).toBe(true);
    expect(updateConversation).toHaveBeenCalledWith('s1', 'c1', { transcriptTurnOffset: 2 });
  });

  it('counts none for a fork whose transcript copied nothing (Codex)', async () => {
    parseTurns.mockResolvedValueOnce([asked('2026-10-08T09:08:53.412Z')]);
    const forked = resolvedBinding(session({ conversations: [conversation({ startReason: 'fork', startedAt: '2026-10-08T09:08:21.000Z', transcriptTurnOffset: null })] }))!;
    expect(await establishTurnBaseline(forked)).toBe(true);
    expect(updateConversation).toHaveBeenCalledWith('s1', 'c1', { transcriptTurnOffset: 0 });
  });

  it('allows for the CLI\'s clock a little ahead of the recorded start, and counts a turn with no time as before', () => {
    expect(turnsBefore([asked(null), asked('2026-10-08T09:03:16.000Z')], '2026-10-08T09:03:20.000Z')).toBe(1);
    expect(turnsBefore([asked('2026-10-08T09:00:00.000Z')], '2026-10-08T09:03:20.000Z')).toBe(1);
    expect(turnsBefore([], '2026-10-08T09:03:20.000Z')).toBe(0);
  });

  it('records the turns a recovered runtime already had, once', async () => {
    parseTurns.mockResolvedValueOnce([{}, {}, {}]);
    const recovered = resolvedBinding(session({ conversations: [conversation({ startReason: 'runtime_recovery', transcriptTurnOffset: null })] }))!;
    expect(await establishTurnBaseline(recovered)).toBe(true);
    expect(updateConversation).toHaveBeenCalledWith('s1', 'c1', { transcriptTurnOffset: 3 });
    const done = resolvedBinding(session({ conversations: [conversation({ startReason: 'runtime_recovery', transcriptTurnOffset: 3 })] }))!;
    expect(await establishTurnBaseline(done)).toBe(false);
    expect(await establishTurnBaseline(resolvedBinding(session())!)).toBe(false);
  });
});
