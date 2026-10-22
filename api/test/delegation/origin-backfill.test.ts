import { describe, expect, it } from 'vitest';
import type { Delegation } from '../../src/contract/delegation.js';
import { backfillDelegationOrigins } from '../../src/delegation/origin-backfill.js';
import type { ManagedSession } from '../../src/types.js';

function delegation(id: string, patch: Partial<Delegation>): Delegation {
  return { id, createdAt: '2026-10-06T09:00:00.000Z', parentSessionId: 'p1', parentConversationId: 'c1', childSessionId: null, ...patch } as Delegation;
}

function world(delegations: Delegation[], sessions: Record<string, Partial<ManagedSession>>) {
  const store = new Map(Object.entries(sessions).map(([id, session]) => [id, { id, ...session } as ManagedSession]));
  const updates: string[] = [];
  return {
    store,
    updates,
    ports: {
      delegations: async () => delegations,
      getSession: async (id: string) => store.get(id),
      updateSession: async (id: string, patch: Partial<ManagedSession>) => {
        const current = store.get(id);
        if (!current) return undefined;
        updates.push(id);
        const next = { ...current, ...patch };
        store.set(id, next);
        return next;
      },
    },
  };
}

describe('backfillDelegationOrigins', () => {
  it('records the delegation on delegates\' sessions that lack it, and only once', async () => {
    const w = world([
      delegation('d1', { childSessionId: 'child-1' }),
      delegation('d2', { childSessionId: 'child-2', parentSessionId: null, parentConversationId: null }),
      // Proposed, never started: no session.
      delegation('d3', { childSessionId: null }),
      // Its session is gone.
      delegation('d4', { childSessionId: 'gone' }),
    ], { 'child-1': {}, 'child-2': {} });

    expect(await backfillDelegationOrigins(w.ports)).toBe(2);
    expect(w.store.get('child-1')?.delegationOrigin).toEqual({ delegationId: 'd1', fromSessionId: 'p1', fromConversationId: 'c1' });
    expect(w.store.get('child-2')?.delegationOrigin).toEqual({ delegationId: 'd2', fromSessionId: null, fromConversationId: null });

    // Again: nothing left to do.
    expect(await backfillDelegationOrigins(w.ports)).toBe(0);
    expect(w.updates).toEqual(['child-1', 'child-2']);
  });

  it('leaves one already recorded as it is, and gives a shared session the oldest delegation', async () => {
    const recorded = { delegationId: 'd0', fromSessionId: 'p0', fromConversationId: null };
    const w = world([
      delegation('newer', { childSessionId: 'child-2', createdAt: '2026-10-07T00:00:00.000Z' }),
      delegation('older', { childSessionId: 'child-2', createdAt: '2026-10-06T00:00:00.000Z' }),
      delegation('d1', { childSessionId: 'child-1' }),
    ], { 'child-1': { delegationOrigin: recorded }, 'child-2': {} });

    expect(await backfillDelegationOrigins(w.ports)).toBe(1);
    expect(w.store.get('child-1')?.delegationOrigin).toEqual(recorded);
    expect(w.store.get('child-2')?.delegationOrigin?.delegationId).toBe('older');
  });
});
