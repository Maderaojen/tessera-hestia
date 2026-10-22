// Delegates' sessions made before they recorded their delegation
// (ManagedSession.delegationOrigin): filled in once from the delegations,
// at start-up. Only adds the field where it is missing, so running it again
// changes nothing.

import type { Delegation } from '../contract/delegation.js';
import type { ManagedSession } from '../types.js';

export type OriginBackfillPorts = {
  delegations(): Promise<Delegation[]>;
  // Trashed sessions too: one restored later still knows where it came from.
  getSession(id: string): Promise<ManagedSession | undefined>;
  updateSession(id: string, patch: Partial<ManagedSession>): Promise<ManagedSession | undefined>;
};

/** How many sessions it filled in. */
export async function backfillDelegationOrigins(ports: OriginBackfillPorts): Promise<number> {
  // Oldest first: a session two delegations point at (never expected) keeps
  // the one that made it.
  const delegations = [...await ports.delegations()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const filled = new Set<string>();
  for (const delegation of delegations) {
    const sessionId = delegation.childSessionId;
    if (!sessionId || filled.has(sessionId)) continue;
    const session = await ports.getSession(sessionId);
    if (!session || session.delegationOrigin) continue;
    await ports.updateSession(sessionId, {
      delegationOrigin: {
        delegationId: delegation.id,
        fromSessionId: delegation.parentSessionId,
        fromConversationId: delegation.parentConversationId,
      },
    });
    filled.add(sessionId);
  }
  return filled.size;
}
