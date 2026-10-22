import { describe, expect, it } from 'vitest';
import { searchPersistedSessions } from '../src/services/session-search.js';
import type { ManagedSession } from '../src/types.js';

function fixture(turns: Array<{ user: string; followUps?: string[]; assistant: string }>): ManagedSession[] {
  return [{ id: 'session-a', sessionNumber: 3, createdAt: '2025-01-01', conversations: [{
    id: 'conversation-a', sequence: 1, startedAt: '2025-01-02', turns: turns.map((turn, index) => ({
      index, user: { text: turn.user, at: null }, followUps: turn.followUps?.map((text) => ({ text, at: null })), assistant: { text: turn.assistant, at: null },
    })),
  }] }] as ManagedSession[];
}

describe('persisted conversation search', () => {
  it('matches normalized Chinese and each message part without exposing full text', () => {
    const page = searchPersistedSessions(fixture([{ user: '你好世界', followUps: ['好，再說'], assistant: '回答好'.repeat(200) }]), '好', 20);
    expect(page.results.map((hit) => [hit.part, hit.followUpIndex])).toEqual([['user', null], ['followUp', 0], ['assistant', null]]);
    expect(Array.from(page.results[2]!.snippet).length).toBeLessThanOrEqual(160);
    expect(page.nextCursor).toBeNull();
  });

  it('pages by stable message coordinate and binds cursor to query', () => {
    const sessions = fixture([{ user: 'needle', followUps: ['needle'], assistant: 'needle' }, { user: 'needle', assistant: 'needle' }]);
    const first = searchPersistedSessions(sessions, 'needle', 2);
    expect(first.results).toHaveLength(2);
    const second = searchPersistedSessions(sessions, 'needle', 2, first.nextCursor!);
    expect(second.results).toHaveLength(2);
    expect(second.results[0]?.part).toBe('assistant');
    expect(() => searchPersistedSessions(sessions, 'other', 2, first.nextCursor!)).toThrow();
  });

  it('returns a cursor after scanning 2,000 nonmatching messages', () => {
    const sessions = fixture(Array.from({ length: 1001 }, (_, i) => ({ user: i === 1000 ? 'needle' : 'other', assistant: 'other' })));
    const first = searchPersistedSessions(sessions, 'needle', 20);
    expect(first.results).toHaveLength(0);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(searchPersistedSessions(sessions, 'needle', 20, first.nextCursor!).results).toHaveLength(1);
  });

  it('returns persisted turn indexes even when they do not match array positions', () => {
    const sessions = fixture([{ user: 'needle', assistant: '' }, { user: 'needle', assistant: '' }]);
    sessions[0]!.conversations![0]!.turns[0]!.index = 7;
    sessions[0]!.conversations![0]!.turns[1]!.index = 9;
    const first = searchPersistedSessions(sessions, 'needle', 1);
    expect(first.results[0]?.turnIndex).toBe(7);
    expect(searchPersistedSessions(sessions, 'needle', 1, first.nextCursor!).results[0]?.turnIndex).toBe(9);
  });

  it('seeks directly to later pages without rereading earlier turn messages', () => {
    const sessions = fixture(Array.from({ length: 2201 }, (_, index) => ({ user: index === 2200 ? 'needle' : 'other', assistant: 'other' })));
    const first = searchPersistedSessions(sessions, 'needle', 20);
    expect(first.nextCursor).not.toBeNull();
    Object.defineProperty(sessions[0]!.conversations![0]!.turns[0]!.user, 'text', {
      get: () => { throw new Error('previous page reread'); },
    });
    const second = searchPersistedSessions(sessions, 'needle', 20, first.nextCursor!);
    expect(second.nextCursor).not.toBeNull();
    expect(searchPersistedSessions(sessions, 'needle', 20, second.nextCursor!).results[0]?.turnIndex).toBe(2200);
  });
});
