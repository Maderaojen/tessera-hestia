import { realpath } from 'node:fs/promises';
import { DELEGATION_TERMINAL_STATUSES } from '../contract/delegation.js';
import { forkStatus } from '../contract/fork.js';
import type { SpawnWorkspace } from '../contract/workspace.js';
import { delegation } from '../delegation/wiring.js';
import { isDeniedPath } from '../files/denied-paths.js';
import { fork } from '../fork/wiring.js';
import * as projectStore from '../project-store.js';
import * as registry from '../registry.js';

// The worktrees a delegation or a branch line works in belong to its
// project for as long as they exist, without being one of its paths: a
// path is somewhere the user chose to work, kept until they remove it,
// while a worktree is the delegate's or the branch line's own, and goes
// when it is cleaned up. So they are read off their records, never stored
// with the project — and one removed (by Hestia, or by hand) simply stops
// being there.

export type SpawnRoot = {
  // The spawned session's cwd: inside its worktree, the subfolder its
  // starting session worked in.
  path: string;
  kind: 'delegation' | 'fork';
  id: string;
  title: string;
  branch: string | null;
};

/** A delegation or a branch line that works in a worktree of its own, as the git view needs it. */
export type Spawned = {
  kind: SpawnRoot['kind'];
  id: string;
  title: string;
  workspace: SpawnWorkspace;
  removed: boolean;
  // A delegation's DelegationStatus, a branch line's ForkStatus.
  status: string;
  // A delegation accepted, rejected or stopped; a branch line closed or
  // given up starting: its worktree is only waiting to be cleaned up.
  ended: boolean;
  // Its own session.
  sessionId: string | null;
  sessionIds: (string | null)[];
};

/** Every delegation and branch line with a worktree of its own, from their records. */
export async function spawned(): Promise<Spawned[]> {
  const [delegations, forks] = await Promise.all([delegation.list({}), fork.list({})]);
  return [
    ...delegations.map((d): Spawned => ({
      kind: 'delegation', id: d.id, title: d.title, workspace: d.workspace,
      removed: !!d.workspace.removedAt,
      status: d.state, ended: DELEGATION_TERMINAL_STATUSES.includes(d.state),
      sessionId: d.childSessionId,
      sessionIds: [d.childSessionId, d.parentSessionId],
    })),
    ...forks.map((f): Spawned => ({
      kind: 'fork', id: f.id, title: f.title, workspace: f.workspace,
      removed: !!f.workspace.removedAt || f.cleanup?.result === 'removed',
      status: forkStatus(f), ended: !!f.closedAt || !!f.failedAt,
      sessionId: f.childSessionId,
      sessionIds: [f.childSessionId, f.origin.sessionId],
    })),
  ].filter((entry) => entry.workspace.isolation === 'worktree' && !!entry.workspace.worktree);
}

/** The project it was started in: its own session's, or (that one gone) the session it was started from. */
export async function projectOf(entry: Spawned): Promise<string | null> {
  for (const id of entry.sessionIds) {
    if (!id) continue;
    const session = await registry.getSessionRecord(id);
    if (session) return session.projectId;
  }
  return null;
}

/** The project's delegation and branch line worktrees still on this host. */
export async function spawnRoots(projectId: string): Promise<SpawnRoot[]> {
  const roots: SpawnRoot[] = [];
  for (const entry of await spawned()) {
    if (entry.removed || (await projectOf(entry)) !== projectId) continue;
    // One made under the state dir before worktrees were kept out of it is
    // never read (denied-paths.ts); the worktree overview still lists it.
    if (isDeniedPath(entry.workspace.path)) continue;
    if (!(await realpath(entry.workspace.path).then(() => true, () => false))) continue;
    roots.push({ path: entry.workspace.path, kind: entry.kind, id: entry.id, title: entry.title, branch: entry.workspace.branch });
  }
  return roots;
}

/**
 * Takes out of every project the paths that were only ever a delegation's
 * or a branch line's worktree, which sessions opened there used to add to
 * it. Run at startup. A project left with no other path keeps it, rather
 * than having none.
 */
export async function forgetSpawnWorktreePaths(): Promise<number> {
  const worktrees = new Set<string>();
  for (const entry of await spawned()) {
    worktrees.add(entry.workspace.path);
    if (entry.workspace.worktree) worktrees.add(entry.workspace.worktree);
  }
  let removed = 0;
  for (const project of await projectStore.listProjects()) {
    const made = project.paths.filter((entry) => worktrees.has(entry.path));
    // All of them worktrees: the first stays, so the project keeps a path.
    for (const entry of made.length === project.paths.length ? made.slice(1) : made) {
      await projectStore.removeProjectPath(project.id, entry.path);
      removed += 1;
    }
  }
  return removed;
}
