import { describe, expect, it } from 'vitest';
import { deriveSessionActivity, STUCK_HINT_TEXT, type ManagedSession } from '../src/types.js';
import { toPublicManagedSession } from '../src/session-dto.js';
import { publicTurns } from '../src/session-dto.js';

const session: ManagedSession = {
  id: 's', tmuxName: 'hestia-s', cwd: '/tmp/project', projectId: 'p', alias: null,
  createdAt: '2026-01-01T00:00:00Z', provider: 'codex', providerSessionId: null,
  providerSessionFile: '/tmp/private/rollout.jsonl', providerLaunchedAt: null, status: 'ready',
  lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null,
  pendingInteraction: null, turns: [], turnsSourceFile: null,
  launchProfile: {
    id: 'janus:abc', provider: 'codex', source: 'janus', profileName: 'work',
    home: '/secret/janus/work', conversationRoot: '/secret/janus/work/sessions',
    delegate: { kind: 'janus', executable: '/secret/bin/janus' },
  },
};

describe('toPublicManagedSession', () => {
  it('keeps launch identity while stripping launch and transcript paths', () => {
    const value = toPublicManagedSession({ ...session, providerSessionId: 'claude-secret-session-uuid' });
    expect(value).not.toHaveProperty('resumePending');
    expect(value).not.toHaveProperty('launchArgv');
    expect(value).not.toHaveProperty('providerSessionFile');
    expect(value).not.toHaveProperty('turnsSourceFile');
    expect(value).not.toHaveProperty('providerSessionId');
    expect(value.launchProfile).toEqual({ id: 'janus:abc', provider: 'codex', source: 'janus', profileName: 'work', delegate: 'janus', permissionMode: 'cli_default' });
    expect(JSON.stringify(value)).not.toContain('/tmp/private');
    expect(JSON.stringify(value)).not.toContain('/secret');
    expect(JSON.stringify(value)).not.toContain('claude-secret-session-uuid');
  });

  it('says why a conversation can\'t be continued as a code as well as the API\'s own text', () => {
    const conversation = {
      id: 'c1', sequence: 1, kind: 'cli' as const, provider: 'codex' as const, launchProfile: null, providerSessionId: null,
      startedAt: 't1', endedAt: 't2', startReason: 'launch' as const, endReason: 'cli_exit' as const,
      transcript: { state: 'resolved' as const, file: '/x', identity: 'verified_metadata' as const },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    };
    const [summary] = toPublicManagedSession({ ...session, conversations: [conversation] }).conversations;
    expect(summary?.resumeBlockedReason).toBe('codex CLI 暫不支援繼續');
    expect(summary?.resumeBlocked).toEqual({ code: 'resume_unsupported', params: { provider: 'codex' } });
  });

  it('does not expose legacy flat turns when there is no active conversation', () => {
    const value = toPublicManagedSession({ ...session, turns: [{ index: 1, user: { text: 'legacy', at: null }, assistant: { text: 'turn', at: null } }] });
    expect(value.turns).toEqual([]);
    expect(value.activeConversationId).toBeNull();
  });

  it('exposes only the clear-restarting flag, never its private launch command', () => {
    const pending = {
      attemptId: 'attempt', conversationId: 'c1', newProviderSessionId: 'uuid',
      launchArgv: ['janus', 'run', 'secret-profile', 'claude', '--session-id', 'uuid'],
      startedAt: 't1', previousStatus: 'ready' as const, phase: 'waiting_exit' as const, launchStartedAt: null,
    };
    const value = toPublicManagedSession({ ...session, clearPending: pending });
    expect(value.claudeClearPending).toBe(true);
    expect(JSON.stringify(value)).not.toContain('secret-profile');
    expect(JSON.stringify(value)).not.toContain('launchArgv');
  });

  it('serializes conversation details without transcript or launch filesystem paths', async () => {
    const { toPublicConversation } = await import('../src/session-dto.js');
    const detail = toPublicConversation({
      id: 'c1', sequence: 1, kind: 'cli', provider: 'codex', launchProfile: {
        id: 'janus:abc', provider: 'codex', source: 'janus', profileName: 'work', home: '/secret/home',
        conversationRoot: '/secret/sessions', delegate: { kind: 'janus', executable: '/secret/bin/janus' },
      }, providerSessionId: 'claude-secret-session-uuid', startedAt: 't1', endedAt: null, startReason: 'launch', endReason: null,
      transcript: { state: 'resolved', file: '/secret/sessions/rollout.jsonl', identity: 'verified_metadata' },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null,
      transcriptError: null, turns: [],
    });
    expect(JSON.stringify(detail)).not.toContain('/secret');
    expect(JSON.stringify(detail)).not.toContain('claude-secret-session-uuid');
    expect(detail).not.toHaveProperty('providerSessionId');
    expect(detail.transcript).toEqual({ state: 'resolved', identity: 'verified_metadata' });
    expect(detail.launchProfile).toEqual({ id: 'janus:abc', provider: 'codex', source: 'janus', profileName: 'work', permissionMode: 'cli_default' });
  });

  it('says which branch line a session is, and null otherwise', () => {
    const forkOrigin = { forkId: 'f1f1f1f1', fromSessionId: 'main', fromConversationId: 'c1', sharedFolder: true };
    expect(toPublicManagedSession({ ...session, forkOrigin }).fork).toEqual(forkOrigin);
    expect(toPublicManagedSession(session).fork).toBeNull();
  });

  it('says which handoff a conversation started from, without its brief\'s file', async () => {
    const { publicSegmentHandoff } = await import('../src/session-dto.js');
    const record = {
      handoffId: 'h1', trigger: 'manual' as const, fromConversationId: 'c1', briefSource: 'self' as const, source: 'self_then_mechanical' as const,
      briefNote: null, briefNoteCode: null, confirm: 'ask' as const, briefAmended: null, briefFile: '.hestia/handoffs/x-h1.md',
    };
    const shown = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'briefFile'));
    expect(publicSegmentHandoff(record)).toEqual(shown);
    expect(publicSegmentHandoff(undefined)).toBeNull();
    const withConversation = { ...session, conversations: [{ id: 'c2', sequence: 2, provider: 'codex', startedAt: '', endedAt: null, startReason: 'provider_switch', endReason: null, transcript: { state: 'resolved', file: '/secret/x.jsonl', identity: null }, transcriptError: null, turns: [], handoff: record }] } as unknown as ManagedSession;
    const summary = toPublicManagedSession(withConversation).conversations[0]!;
    expect(summary.handoff).toEqual(shown);
    expect(JSON.stringify(summary)).not.toContain('.hestia/handoffs');
  });

  it('counts the user\'s messages, follow-ups in and a handoff\'s own out, only once the transcript is resolved', async () => {
    const { HANDOFF_MESSAGES } = await import('../src/contract/continuity.js');
    const turns = [
      { index: 0, user: { text: HANDOFF_MESSAGES.briefAsk('/p/.hestia/handoffs/x.md'), at: '' }, assistant: { text: '理解了', at: '' } },
      { index: 1, user: { text: '做 X', at: '' }, followUps: [{ text: '還有 Y', at: '' }], assistant: { text: 'ok', at: '' } },
      { index: 2, user: { text: HANDOFF_MESSAGES.confirm, at: '' }, assistant: { text: 'ok', at: '' } },
    ];
    const conversation = (state: string) => ({ id: 'c2', sequence: 2, provider: 'codex', startedAt: '', endedAt: null, startReason: 'provider_switch', endReason: null, transcript: { state, file: null, identity: null }, transcriptError: null, turns });
    const summary = (state: string) => toPublicManagedSession({ ...session, conversations: [conversation(state)] } as unknown as ManagedSession).conversations[0]!;
    expect(summary('resolved')).toMatchObject({ turnsCount: 3, userMessagesCount: 2 });
    expect(summary('pending').userMessagesCount).toBeNull();
  });

  it('says which delegation a delegate\'s session works on, and null otherwise', () => {
    const delegationOrigin = { delegationId: 'ab12cd34', fromSessionId: 'main', fromConversationId: null };
    expect(toPublicManagedSession({ ...session, delegationOrigin }).delegation).toEqual(delegationOrigin);
    expect(toPublicManagedSession(session).delegation).toBeNull();
  });

  it('says whether a branch line\'s or delegate\'s session looks finished, and null otherwise', () => {
    const closable = { reason: 'merged' as const, into: 'main' };
    expect(toPublicManagedSession({ ...session, closable }).closable).toEqual(closable);
    expect(toPublicManagedSession(session).closable).toBeNull();
  });

  it('offers the CLI\'s suggested next message only while it sits idle at its prompt', () => {
    const idle = { ...session, turnPhase: 'idle' as const, cliSuggestion: 'push 同步更新 stable' };
    expect(toPublicManagedSession(idle).cliSuggestion).toBe('push 同步更新 stable');
    expect(toPublicManagedSession(session).cliSuggestion).toBeNull();
    expect(toPublicManagedSession({ ...idle, turnPhase: 'replying' }).cliSuggestion).toBeNull();
    expect(toPublicManagedSession({ ...idle, status: 'dead' }).cliSuggestion).toBeNull();
    expect(toPublicManagedSession({ ...idle, stuckSince: '2026-01-01T00:00:00Z' }).cliSuggestion).toBeNull();
    expect(toPublicManagedSession({ ...idle, startupPrompt: { kind: 'workspace_trust', detectedAt: 'x' } } as ManagedSession).cliSuggestion).toBeNull();
  });

  it('explicitly includes the public session fields but no local file paths', () => {
    expect(Object.keys(toPublicManagedSession(session)).sort()).toEqual([
      'activeConversationId', 'activity', 'actualPermissionMode', 'alias', 'backgroundAgents', 'backgroundTurn', 'claudeClearPending', 'clearPending', 'cliSuggestion', 'closable', 'conversationSwitch', 'conversations', 'createdAt', 'cwd', 'delegation', 'deliveryUnconfirmedText', 'fork', 'id', 'lastActivityAt', 'lastError', 'lastUserMessageAt',
      'lastUserMessageText', 'launchProfile', 'launchStartedAt', 'pendingInteraction', 'permissionModeChangedInTerminal', 'projectId', 'provider',
      'providerLaunchedAt', 'quotaAccountId', 'recoverable', 'sessionNumber', 'spawnClosedAt', 'startupPrompt', 'status', 'stuckSince', 'tmuxName', 'tmuxSocket', 'turnPhase', 'turns', 'undeliveredMessages', 'workspace',
    ].sort());
  });

  it('says when a launch still waiting to be confirmed was sent, and nothing else of it', () => {
    const launchPending = {
      provider: 'codex' as const, providerSessionId: null, providerLaunchedAt: '2026-10-09T06:00:00.000Z', previousStatus: 'idle' as const,
      launchProfile: { id: 'janus:w', provider: 'codex' as const, source: 'janus' as const, home: '/secret/home', delegate: { kind: 'janus' as const, executable: '/secret/bin/janus' } },
    };
    const dto = toPublicManagedSession({ ...session, status: 'launching', launchPending });
    expect(dto.launchStartedAt).toBe('2026-10-09T06:00:00.000Z');
    expect(JSON.stringify(dto)).not.toContain('/secret');
    expect(toPublicManagedSession(session).launchStartedAt).toBeNull();
  });

  it('sends when anything last happened in the active conversation, for lists to sort by', async () => {
    const { toSessionDto } = await import('../src/session-dto.js');
    const conversation = {
      id: 'c1', sequence: 1, kind: 'cli' as const, provider: 'codex' as const, launchProfile: null, providerSessionId: null,
      startedAt: 't1', endedAt: null, startReason: 'launch' as const, endReason: null,
      transcript: { state: 'resolved' as const, file: '/x', identity: 'verified_metadata' as const },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null,
      turns: [{ index: 1, user: { text: 'q', at: '2026-02-01T00:00:00Z' }, assistant: { text: 'a', at: '2026-02-01T00:01:00Z' } }],
    };
    expect(toSessionDto(session).lastActivityAt).toBe(session.createdAt);
    expect(toSessionDto({ ...session, lastUserMessageAt: '2026-01-05T00:00:00Z' }).lastActivityAt).toBe('2026-01-05T00:00:00Z');
    const withTurn = toSessionDto({ ...session, conversations: [conversation], activeConversationId: 'c1' });
    expect(withTurn.lastActivityAt).toBe('2026-02-01T00:01:00Z');
    // The contract-v1 DTO carries none of the deprecated fields.
    expect(withTurn).not.toHaveProperty('turns');
    expect(withTurn).not.toHaveProperty('status');
    expect(withTurn).not.toHaveProperty('claudeClearPending');
  });

  it('exposes a pending conversation switch as target + phase only, never its launch command', () => {
    const switching = {
      ...session,
      clearPending: {
        attemptId: 'a1', conversationId: null, targetConversationId: 'conv-1',
        newProviderSessionId: 'claude-secret-session-uuid', launchArgv: ['/secret/bin/claude', '--resume', 'claude-secret-session-uuid'],
        startedAt: 'now', previousStatus: 'ready' as const, phase: 'awaiting_force' as const, launchStartedAt: null,
      },
    };
    const dto = toPublicManagedSession(switching);
    expect(dto.conversationSwitch).toEqual({ targetConversationId: 'conv-1', phase: 'awaiting_force' });
    expect(JSON.stringify(dto)).not.toContain('/secret');
    expect(JSON.stringify(dto)).not.toContain('claude-secret-session-uuid');
    expect(toPublicManagedSession(session).conversationSwitch).toBeNull();
  });

  it('exposes only flagged sends as undelivered, and a start-up prompt as its kind plus awaiting approval', () => {
    const conversation = {
      id: 'conv-1', sequence: 1, kind: 'cli' as const, provider: 'gemini' as const, runtimeId: 'agy' as const, launchProfile: null,
      providerSessionId: null, startedAt: '2026-09-25T09:59:00.000Z', endedAt: null, startReason: 'launch' as const, endReason: null,
      transcript: { state: 'pending' as const, file: null, identity: null }, lastUserMessageAt: null, lastUserMessageText: null,
      deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
      unconfirmedSends: [
      { text: 'lost one', at: '2026-09-25T10:00:00.000Z', flagged: true },
      { text: 'still in flight', at: '2026-09-25T10:00:20.000Z', flagged: false },
      ],
    };
    const dto = toPublicManagedSession({
      ...session, status: 'ready', turnPhase: 'idle', provider: 'gemini', runtimeId: 'agy',
      activeConversationId: conversation.id, conversations: [conversation],
      startupPrompt: { kind: 'workspace_trust', detectedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(dto.undeliveredMessages).toEqual([{ text: 'lost one', sentAt: '2026-09-25T10:00:00.000Z' }]);
    expect(dto.startupPrompt).toEqual({ kind: 'workspace_trust', runtimeId: 'agy' });
    expect(dto.activity).toBe('awaiting_approval');
    expect(toPublicManagedSession(session).startupPrompt).toBeNull();
    expect(toPublicManagedSession(session).undeliveredMessages).toEqual([]);
  });

  it('names the quota account of the running CLI without exposing any path', () => {
    const claudeJanus = {
      ...session, provider: 'claude' as const, runtimeId: 'claude-code' as const, status: 'ready' as const,
      launchProfile: { id: 'janus:x', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'janus' as const, profileName: 'claude-work', home: '/private/claude-work', delegate: { kind: 'janus' as const, executable: '/opt/janus' } },
    };
    expect(toPublicManagedSession(claudeJanus).quotaAccountId).toBe('janus:claude:claude-work');
    const codexNative = {
      ...session, provider: 'codex' as const, runtimeId: 'codex-cli' as const, status: 'ready' as const,
      launchProfile: { id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, source: 'native' as const, home: '/private/codex', delegate: { kind: 'native' as const, executable: 'codex' } },
    };
    expect(toPublicManagedSession(codexNative).quotaAccountId).toBe('native:codex:default');
    expect(JSON.stringify(toPublicManagedSession(codexNative))).not.toContain('/private/codex');
  });

  it('has no quota account for Agy, a stopped CLI, or a mismatched profile', () => {
    const agy = {
      ...session, provider: 'gemini' as const, runtimeId: 'agy' as const, status: 'ready' as const,
      launchProfile: { id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const, source: 'native' as const, home: '/private/gemini', delegate: { kind: 'native' as const, executable: 'agy' } },
    };
    expect(toPublicManagedSession(agy).quotaAccountId).toBeNull();
    expect(toPublicManagedSession({ ...session, provider: null }).quotaAccountId).toBeNull();
    expect(toPublicManagedSession({ ...agy, provider: 'claude' as const, status: 'dead' as const }).quotaAccountId).toBeNull();
  });

  it('says whether a dead tmux can be recovered, from the runtime that recorded its conversation', () => {
    const profile = { id: 'native:claude', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'native' as const, home: '/h', conversationRoot: '/h/p', delegate: { kind: 'native' as const, executable: 'claude' } };
    const conversation = {
      id: 'conv-1', sequence: 1, kind: 'cli' as const, provider: 'claude' as const, runtimeId: 'claude-code' as const, launchProfile: profile,
      providerSessionId: 'sid', startedAt: 't', endedAt: null, startReason: 'launch' as const, endReason: null,
      transcript: { state: 'resolved' as const, file: '/h/p/x/sid.jsonl', identity: 'pinned_id' as const }, lastUserMessageAt: null, lastUserMessageText: null,
      deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    };
    const dead = {
      ...session, status: 'dead' as const, provider: 'claude' as const, runtimeId: 'claude-code' as const, providerSessionId: 'sid',
      launchProfile: profile, activeConversationId: 'conv-1', conversations: [conversation],
    };
    expect(toPublicManagedSession(dead).recoverable).toBe(true);
    expect(toPublicManagedSession({ ...dead, status: 'ready' }).recoverable).toBe(false);
    // A closed branch line or delegate: its folder is gone, nothing to resume in.
    expect(toPublicManagedSession({ ...dead, spawnClosedAt: '2026-10-13T00:00:00.000Z' }).recoverable).toBe(false);
    expect(toPublicManagedSession({ ...dead, spawnClosedAt: '2026-10-13T00:00:00.000Z' }).spawnClosedAt).toBe('2026-10-13T00:00:00.000Z');
    expect(toPublicManagedSession({ ...dead, conversations: [{ ...conversation, transcript: { state: 'pending', file: null, identity: null } }] }).recoverable).toBe(false);
    // A runtime that doesn't resume in place is never recoverable, even with everything recorded.
    const agyProfile = { ...profile, id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const };
    expect(toPublicManagedSession({
      ...dead, provider: 'gemini', runtimeId: 'agy', launchProfile: agyProfile,
      conversations: [{ ...conversation, provider: 'gemini', runtimeId: 'agy', launchProfile: agyProfile }],
    }).recoverable).toBe(false);
    expect(JSON.stringify(toPublicManagedSession(dead))).not.toContain('/h/p');
  });

  it('exposes the derived activity but never the raw pane observation', () => {
    const dto = toPublicManagedSession({ ...session, status: 'ready', turnPhase: 'replying', paneActivity: 'idle' });
    expect(dto.activity).toBe('idle');
    expect(dto).not.toHaveProperty('paneActivity');
    expect(toPublicManagedSession({ ...session, status: 'ready', turnPhase: 'replying', paneActivity: 'busy' }).activity).toBe('busy');
  });
});

describe('deriveSessionActivity', () => {
  const base = { status: 'ready' as ManagedSession['status'], clearPending: null, lastError: null, paneActivity: undefined } as const;
  const clearPending = {
    attemptId: 'a', conversationId: 'c1', newProviderSessionId: 'u', launchArgv: [], startedAt: 't',
    previousStatus: 'ready' as const, phase: 'waiting_exit' as const, launchStartedAt: null,
  };
  const derive = (patch: Partial<Pick<ManagedSession, 'status' | 'turnPhase' | 'clearPending' | 'lastError' | 'stuckSince' | 'paneActivity'>>) => deriveSessionActivity({ ...base, ...patch });

  it('reads each rule on its own', () => {
    expect(derive({ status: 'dead' })).toBe('ended');
    expect(derive({ status: 'launching' })).toBe('starting');
    expect(derive({ status: 'ready', clearPending })).toBe('starting');
    expect(derive({ status: 'idle' })).toBe('not_started');
    expect(derive({ status: 'ready', turnPhase: 'awaiting_approval' })).toBe('awaiting_approval');
    expect(derive({ status: 'ready', turnPhase: 'replying', stuckSince: 'T' })).toBe('stalled');
    expect(derive({ status: 'ready', turnPhase: 'replying', paneActivity: 'busy' })).toBe('busy');
    expect(derive({ status: 'ready', turnPhase: 'replying', paneActivity: 'idle' })).toBe('idle');
    expect(derive({ status: 'ready' })).toBe('idle');
  });

  it('treats a waiting session without a usable pane reading as busy (a reply is on its way)', () => {
    expect(derive({ status: 'ready', turnPhase: 'replying', paneActivity: 'unknown' })).toBe('busy');
    expect(derive({ status: 'ready', turnPhase: 'replying' })).toBe('busy'); // older records have no paneActivity
  });

  it('picks the higher-priority state when several conditions hold at once', () => {
    expect(derive({ status: 'dead', clearPending, stuckSince: 'T' })).toBe('ended');
    expect(derive({ status: 'idle', clearPending })).toBe('starting');
    expect(derive({ status: 'ready', turnPhase: 'awaiting_approval', stuckSince: 'T' })).toBe('awaiting_approval');
    expect(derive({ status: 'ready', turnPhase: 'replying', stuckSince: 'T', paneActivity: 'idle' })).toBe('stalled');
    expect(derive({ status: 'ready', paneActivity: 'busy' })).toBe('idle'); // pane only matters while waiting
  });

  it('does not mistake any error for the stuck hint, not even its old text', () => {
    expect(derive({ status: 'ready', turnPhase: 'replying', lastError: 'Transcript ownership is ambiguous', paneActivity: 'busy' })).toBe('busy');
    expect(derive({ status: 'ready', turnPhase: 'replying', lastError: STUCK_HINT_TEXT, paneActivity: 'busy' })).toBe('busy');
  });

  it('still shows the stuck hint in lastError for PWAs cached before stuckSince', () => {
    const stuck = toPublicManagedSession({ ...session, turnPhase: 'replying', stuckSince: '2026-01-01T00:00:00Z' });
    expect(stuck).toMatchObject({ activity: 'stalled', stuckSince: '2026-01-01T00:00:00Z', lastError: STUCK_HINT_TEXT });
    const failed = toPublicManagedSession({ ...session, lastError: 'launch failed', stuckSince: '2026-01-01T00:00:00Z' });
    expect(failed.lastError).toBe('launch failed');
  });
});

describe('publicTurns: messages typed in the terminal', () => {
  it('marks the ones the conversation recorded as typed there, and only those', () => {
    const turns = publicTurns([
      { index: 1, user: { text: 'from the app', at: '2026-10-14T21:00:00.000Z' }, assistant: { text: 'a', at: null } },
      { index: 2, user: { text: 'typed', at: '2026-10-14T21:59:58.720Z' }, assistant: { text: 'b', at: null } },
      { index: 3, user: { text: 'no time', at: null }, assistant: { text: 'c', at: null } },
    ], ['2026-10-14T21:59:58.720Z']);
    expect(turns.map((turn) => turn.user.fromTerminal)).toEqual([undefined, true, undefined]);
    // Without the conversation's record nothing is marked.
    expect(publicTurns([{ index: 2, user: { text: 'typed', at: '2026-10-14T21:59:58.720Z' }, assistant: { text: 'b', at: null } }]).at(0)?.user.fromTerminal).toBeUndefined();
  });
});
