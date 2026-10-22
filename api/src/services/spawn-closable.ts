import type { Delegation } from '../contract/delegation.js';
import type { Fork } from '../contract/fork.js';
import { allows } from '../delegation/policy.js';
import { delegation } from '../delegation/wiring.js';
import { fork } from '../fork/wiring.js';
import * as registry from '../registry.js';
import { createClosableWatch, inspectClosable, type ClosableChild, type ClosableWatch } from '../spawn/closable.js';
import { mergedInto, workspaceState } from '../spawn/workspace.js';
import { deriveSessionActivity, type ManagedSession } from '../types.js';

// Where spawn/closable.ts meets the registry, the branch lines and the
// delegations: every session that is one's, with what its own rules say,
// and its `closable` written back when it changes.

/** Each branch line's and delegate's session, with its record's workspace and whether its rules allow closing it now. */
export function closableChildren(sessions: readonly ManagedSession[], forks: readonly Fork[], delegations: readonly Delegation[]): ClosableChild[] {
  const forkById = new Map(forks.map((item) => [item.id, item]));
  const delegationById = new Map(delegations.map((item) => [item.id, item]));
  return sessions.filter((session) => session.forkOrigin || session.delegationOrigin).map((session): ClosableChild => {
    const base = { sessionId: session.id, activity: deriveSessionActivity(session), current: session.closable ?? null, currentClosedAt: session.spawnClosedAt ?? null };
    if (session.forkOrigin) {
      const own = forkById.get(session.forkOrigin.forkId);
      // An open branch line whose start is over (not one that failed).
      const allowed = !!own && own.childSessionId === session.id && !own.closedAt && !own.startup && !own.failedAt;
      return { ...base, workspace: own?.workspace ?? null, allowed, closedAt: own?.closedAt ?? null };
    }
    const own = delegationById.get(session.delegationOrigin!.delegationId);
    // Over, so its cleanup is allowed — never one still waiting for the
    // user's verdict (待驗收), which stays in 需要你處理.
    const allowed = !!own && own.childSessionId === session.id && allows(own.state, 'cleanup');
    return { ...base, workspace: own?.workspace ?? null, allowed, closedAt: own?.workspace.removedAt ?? null };
  });
}

export const spawnClosable: ClosableWatch = createClosableWatch({
  async children() {
    const sessions = await registry.listSessions();
    if (!sessions.some((session) => session.forkOrigin || session.delegationOrigin)) return [];
    const [forks, delegations] = await Promise.all([fork.list({}), delegation.list({})]);
    return closableChildren(sessions, forks, delegations);
  },
  inspect: (workspace) => inspectClosable(workspace, { state: workspaceState, mergedInto }),
  async write(sessionId, closable) {
    await registry.updateSession(sessionId, { closable });
  },
  async writeClosed(sessionId, spawnClosedAt) {
    await registry.updateSession(sessionId, { spawnClosedAt });
  },
  now: () => Date.now(),
});

/** A round now, not waiting for the next tick (after a close or cleanup); never throws. */
export function refreshSpawnState(): void {
  void spawnClosable.refresh().catch((err: unknown) => console.error('[spawn] closable round failed', err));
}
