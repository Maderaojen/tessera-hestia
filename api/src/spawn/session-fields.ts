import type { SessionDelegationOrigin, SessionForkOrigin, SpawnClosable } from '../contract/index.js';

// What a branch line's or a delegate's session carries on its record
// (types.ts ManagedSession): where it came from, and whether it looks
// finished or was closed. Written by the fork, delegation and spawn code
// only; the session's own lifecycle never reads them to decide anything
// but whether it can be resumed (runtimes/resume.ts).
export type SpawnSessionFields = {
  // A branch line's session: where it was forked from. Written once, when
  // its tmux is made (services/sessions.ts createSession), never changed.
  forkOrigin?: SessionForkOrigin;
  // A delegate's session: the delegation it works on. Written when its tmux
  // is made (services/sessions.ts createSession), or filled in once for one
  // made before (delegation/origin-backfill.ts); never changed after.
  delegationOrigin?: SessionDelegationOrigin;
  // A branch line's or delegate's session that looks finished
  // (spawn/closable.ts); written only when it changes. Absent means no.
  closable?: SpawnClosable | null;
  // A branch line's or delegate's session that was closed (收掉): its fork
  // closed, or its delegation's worktree removed — so it can't be resumed
  // and only its record is left. Written by the closable watch
  // (services/spawn-closable.ts) when it changes; absent means no.
  spawnClosedAt?: string | null;
};
