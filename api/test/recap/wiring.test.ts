import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchProfile } from '../../src/launch-profiles.js';
import type { RecapScheduler } from '../../src/recap/scheduler.js';
import type { SessionEvent } from '../../src/session-stream.js';
import { type ConversationSegment, type ManagedSession } from '../../src/types.js';
import { toPublicManagedSession } from '../../src/session-dto.js';

vi.mock('../../src/registry.js', () => ({ getSession: vi.fn(), getSessionRecord: vi.fn(), listAllSessions: vi.fn(async () => []), listSessions: vi.fn(async () => []) }));
vi.mock('../../src/account-status/index.js', () => ({ getAccountStatus: vi.fn(), requestRefresh: vi.fn(async () => ({})) }));
const { recapConversationsOf, recapLaunchOptions, watchSessions } = await import('../../src/recap/wiring.js');

afterEach(() => vi.clearAllMocks());

function segment(id: string, patch: Partial<ConversationSegment> = {}): ConversationSegment {
  return {
    id, sequence: 1, kind: 'cli', provider: 'codex', runtimeId: 'codex-cli', launchProfile: null, providerSessionId: null,
    startedAt: '2026-10-05T01:00:00.000Z', endedAt: null, startReason: 'launch', endReason: null,
    transcript: { state: 'resolved', file: null, identity: null }, lastUserMessageAt: null, lastUserMessageText: null,
    deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [], ...patch,
  };
}

function session(patch: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 's1', tmuxName: 'hestia-s1', cwd: '/p', projectId: 'p1', alias: null, createdAt: '2026-10-05T01:00:00.000Z',
    provider: 'codex', providerSessionId: null, providerSessionFile: null, providerLaunchedAt: null, status: 'ready', turnPhase: 'idle',
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null, pendingInteraction: null,
    turns: [], turnsSourceFile: null, activeConversationId: 'c2',
    conversations: [segment('c1', { sequence: 1, endedAt: '2026-10-05T02:00:00.000Z' }), segment('c2', { sequence: 2 })],
    ...patch,
  };
}

const turn = (index: number, text = `第 ${index} 輪`) => ({ index, user: { text, at: null }, assistant: { text: '好', at: null } });

describe('recapConversationsOf', () => {
  it('names each conversation\'s recap and its session', () => {
    expect(recapConversationsOf(session())).toEqual([
      expect.objectContaining({ sessionId: 's1', tmuxName: 'hestia-s1', projectId: 'p1', conversationId: 'c1', provider: 'codex', sequence: 1, replying: false, trashed: false }),
      expect.objectContaining({ conversationId: 'c2', sequence: 2, replying: false }),
    ]);
  });

  it('only the active conversation of a running CLI writing a reply is replying', () => {
    expect(recapConversationsOf(session({ turnPhase: 'replying' })).map((c) => c.replying)).toEqual([false, true]);
    expect(recapConversationsOf(session({ turnPhase: 'replying', status: 'dead' })).map((c) => c.replying)).toEqual([false, false]);
  });

  it('tells whether the turn being replied to is stored yet, from when it was sent', () => {
    const at = (time: string) => `2026-10-05T${time}:00.000Z`;
    const stored = (time: string) => ({ index: 1, user: { text: '第 1 輪', at: at(time) }, assistant: { text: '好', at: at(time) } });
    const replyingTo = (lastTurnAt: string, sentAt: string | null) => recapConversationsOf(session({
      turnPhase: 'replying',
      conversations: [segment('c2', { sequence: 2, turns: [stored(lastTurnAt)], lastUserMessageAt: sentAt ? at(sentAt) : null })],
    }))[0];
    // Sent at 10:05, the last stored turn from 10:00: not imported yet.
    expect(replyingTo('10:00', '10:05')).toMatchObject({ replying: true, replyingTurnStored: false });
    expect(replyingTo('10:05', '10:05')).toMatchObject({ replying: true, replyingTurnStored: true });
    // No send time to tell by: as before, the last turn is the one being written.
    expect(replyingTo('10:00', null)).toMatchObject({ replying: true, replyingTurnStored: true });
    expect(recapConversationsOf(session())[1]).not.toHaveProperty('replyingTurnStored');
  });

  it('marks a session in the trash', () => {
    expect(recapConversationsOf(session({ deletedAt: '2026-10-05T03:00:00.000Z' } as Partial<ManagedSession>)).every((c) => c.trashed)).toBe(true);
  });
});

describe('recapLaunchOptions', () => {
  const profile = (id: string, provider: LaunchProfile['provider'], runtimeId?: LaunchProfile['runtimeId']): LaunchProfile => (
    id.startsWith('janus')
      ? { id, provider, runtimeId, label: id, source: 'janus', profileName: id.split(':')[1]!, home: '/h', conversationRoot: '/h/c', janusExecutable: '/bin/janus' }
      : { id, provider, runtimeId: runtimeId!, label: id, source: 'native', executable: '/bin/x', args: ['--secret-arg'] }
  );

  it('offers Codex and Claude Code accounts only, without their executables', () => {
    const options = recapLaunchOptions([
      profile('native:claude', 'claude', 'claude-code'),
      profile('native:codex', 'codex', 'codex-cli'),
      profile('native:gemini', 'gemini', 'gemini-cli'),
      profile('native:agy', 'gemini', 'agy'),
      profile('janus:personal', 'claude', 'claude-code'),
      profile('janus:work', 'codex'),
      profile('janus:g', 'gemini', 'agy'),
    ]);
    expect(options.map((option) => option.id)).toEqual(['native:claude', 'native:codex', 'janus:personal', 'janus:work']);
    expect(JSON.stringify(options)).not.toMatch(/\/bin|secret-arg|\/h/);
  });
});

describe('watchSessions', () => {
  function setUp() {
    let observer: ((sessionId: string, event: SessionEvent) => void) | null = null;
    const scheduler = {
      conversationChanged: vi.fn(async () => {}), sessionChanged: vi.fn(async () => {}), sessionRemoved: vi.fn(),
    } as unknown as RecapScheduler;
    watchSessions(scheduler, (fn) => {
      observer = fn;
      return () => {};
    });
    const emit = (event: SessionEvent) => observer!('s1', event);
    const update = (patch: Partial<ManagedSession>) => emit({ type: 'update', session: toPublicManagedSession(session(patch)) });
    return { scheduler, emit, update };
  }

  it('a conversation whose turns changed starts its wait over; nothing else does', () => {
    const { scheduler, update } = setUp();
    update({});
    expect(scheduler.conversationChanged).toHaveBeenCalledWith('s1', 'c2');
    vi.mocked(scheduler.conversationChanged).mockClear();
    update({ alias: 'renamed' });
    expect(scheduler.conversationChanged).not.toHaveBeenCalled();
    update({ conversations: [segment('c1'), segment('c2', { turns: [turn(0)] })] });
    expect(scheduler.conversationChanged).toHaveBeenCalledWith('s1', 'c2');
    expect(scheduler.sessionChanged).not.toHaveBeenCalled();
  });

  it('a reply starting or finishing has the plans worked out again', () => {
    const { scheduler, update } = setUp();
    update({});
    update({ turnPhase: 'replying' });
    update({ turnPhase: 'idle' });
    expect(scheduler.sessionChanged).toHaveBeenCalledTimes(2);
  });

  it('a deleted session leaves the queue; a restored one is planned again', () => {
    const { scheduler, emit, update } = setUp();
    update({});
    emit({ type: 'deleted' });
    expect(scheduler.sessionRemoved).toHaveBeenCalledWith('s1');
    emit({ type: 'restored', session: toPublicManagedSession(session()) });
    expect(scheduler.sessionChanged).toHaveBeenCalledWith('s1');
  });
});
