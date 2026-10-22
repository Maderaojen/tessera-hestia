import type { SessionActivity } from '../contract/sessions.js';
import type { SpawnClosable, SpawnWorkspace } from '../contract/workspace.js';

// Whether a branch line's or a delegation's session looks finished, so the
// session list can quietly offer closing it: its own
// worktree, not removed yet, its CLI not at work, nothing uncommitted, and
// its work merged into the branch the repo it was cut from has checked out
// — or no commit made at all. Its own rules (an open branch line, a
// delegation that is over) say whether closing is allowed at all; they are
// the caller's (`allowed`). Knows nothing of the registry or the engines:
// the watch is handed what to look at and where to write.

// Git is asked about one session at most this often; the cheap part (its
// rules, its CLI) is looked at on every round.
export const CLOSABLE_REFRESH_MS = 30_000;
// A round over every branch line's and delegate's session.
export const CLOSABLE_TICK_MS = 10_000;

// Its CLI is not at work: waiting for input, ended, or never started.
const AT_REST: readonly SessionActivity[] = ['idle', 'ended', 'not_started'];

/** One branch line's or delegate's session, as the watch sees it. */
export type ClosableChild = {
  sessionId: string;
  activity: SessionActivity;
  // What its session says now.
  current: SpawnClosable | null;
  // Its fork's or delegation's workspace; null when that record is gone.
  workspace: SpawnWorkspace | null;
  // Its own rules allow closing it now: an open, started branch line; a
  // delegation that is over (accepted, rejected, stopped).
  allowed: boolean;
  // When it was closed (its fork closed, its delegation's worktree
  // removed), and what its session says of that now.
  closedAt?: string | null;
  currentClosedAt?: string | null;
};

/** Whether git is worth asking at all: everything but git. */
export function mayBeClosable(child: Pick<ClosableChild, 'activity' | 'workspace' | 'allowed'>): boolean {
  const ws = child.workspace;
  return child.allowed
    && !!ws && ws.isolation === 'worktree' && !!ws.worktree && !!ws.repoRoot && !ws.removedAt
    && AT_REST.includes(child.activity);
}

export type ClosableGit = {
  state(workspace: SpawnWorkspace): Promise<{ clean: boolean; head: string | null }>;
  mergedInto(workspace: SpawnWorkspace, head: string | null): Promise<string | null>;
};

/** What git says of it: merged, nothing new, or (null) not finished. Throws when git fails. */
export async function inspectClosable(workspace: SpawnWorkspace, git: ClosableGit): Promise<SpawnClosable | null> {
  const { clean, head } = await git.state(workspace);
  if (!clean || !head) return null;
  if (head === workspace.baseCommit) return { reason: 'unchanged', into: null };
  const into = await git.mergedInto(workspace, head);
  return into ? { reason: 'merged', into } : null;
}

export type ClosableWatchDeps = {
  children(): Promise<ClosableChild[]>;
  inspect(workspace: SpawnWorkspace): Promise<SpawnClosable | null>;
  write(sessionId: string, closable: SpawnClosable | null): Promise<void>;
  // Writes when it was closed; optional for callers that only want `closable`.
  writeClosed?(sessionId: string, closedAt: string | null): Promise<void>;
  now(): number;
  refreshMs?: number;
};

export type ClosableWatch = {
  // One round: every child's cheap part, git for those due.
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
};

function same(a: SpawnClosable | null, b: SpawnClosable | null): boolean {
  if (!a || !b) return a === b;
  return a.reason === b.reason && a.into === b.into;
}

export function createClosableWatch(deps: ClosableWatchDeps): ClosableWatch {
  const refreshMs = deps.refreshMs ?? CLOSABLE_REFRESH_MS;
  const lastChecked = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function refresh(): Promise<void> {
    // A round still going (slow git) is never overlapped.
    if (running) return;
    running = true;
    try {
      const children = await deps.children();
      const seen = new Set<string>();
      for (const child of children) {
        seen.add(child.sessionId);
        try {
          const closedAt = child.closedAt ?? null;
          if (deps.writeClosed && closedAt !== (child.currentClosedAt ?? null)) await deps.writeClosed(child.sessionId, closedAt);
          let next: SpawnClosable | null;
          if (!mayBeClosable(child)) {
            // Cleared straight away (its CLI back at work, its rules no
            // longer allowing it), without git.
            next = null;
          } else {
            const now = deps.now();
            if (now - (lastChecked.get(child.sessionId) ?? -Infinity) < refreshMs) continue;
            lastChecked.set(child.sessionId, now);
            next = await deps.inspect(child.workspace!).catch(() => null);
          }
          if (!same(child.current, next)) await deps.write(child.sessionId, next);
        } catch (err) {
          console.warn(`[spawn] closable check for session ${child.sessionId} failed`, err);
        }
      }
      for (const id of lastChecked.keys()) if (!seen.has(id)) lastChecked.delete(id);
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void refresh().catch((err: unknown) => console.error('[spawn] closable round failed', err));
      }, CLOSABLE_TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
