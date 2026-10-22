import type { Fork } from '../contract/fork.js';
import type { PermissionMode } from '../contract/permissions.js';
import type { RepoFileChange } from '../contract/repo.js';
import type { SpawnWorkspace } from '../contract/workspace.js';
import type { CloseOutcome } from '../spawn/session.js';
import type { SpawnPorts } from '../spawn/ports.js';
import type { RemovalRefusal } from '../spawn/workspace.js';
import type { UpstreamView } from '../upstream/view.js';
import type { QuotaReading } from './policy.js';

// Everything fork/ reads from or does to the rest of the app. The real
// implementations are in wiring.ts; tests pass their own.

/** The main line, as a branch line needs it. */
export type ForkParentView = {
  cwd: string;
  projectId: string;
  tmuxName: string;
  // Its alias, else its tmux name.
  title: string;
  // Its active conversation; null when it has none.
  conversationId: string | null;
  // Turns stored in that conversation.
  turns: number;
  profileId: string | null;
  profileLabel: string | null;
  // Why its conversation can't be forked natively (runtimes/conversation-blocks.ts conversationForkBlocked).
  forkBlocked: 'runtime_unsupported' | 'conversation_unforkable' | null;
};

export type { UpstreamView } from '../upstream/view.js';

export type ProfileInfo = { id: string; label: string };

export type ForkPorts = SpawnPorts & {
  now(): Date;
  // A short id for a new branch line, and an id for its session.
  newId(): string;
  newSessionId(): string;

  readParent(sessionId: string): Promise<ForkParentView | null>;
  readUpstream(sessionId: string, conversationId: string, turnsAtFork: number): Promise<UpstreamView>;
  listProfiles(): Promise<ProfileInfo[]>;
  // The quota of the account behind a profile; unknown is null.
  readQuota(profileId: string): Promise<QuotaReading>;

  // Where it will work, read without changing anything (spawn/workspace.ts).
  planWorkspace(input: { id: string; branch: string; parentCwd: string }): Promise<SpawnWorkspace>;
  ensureWorkspace(workspace: SpawnWorkspace): Promise<void>;
  // The main line's uncommitted files, repo-wide; null outside git or when unknown.
  parentDirtyFiles(parentCwd: string): Promise<RepoFileChange[] | null>;
  // Writes the brief (and its folder's .gitignore) at fork.briefFile.
  writeBrief(fork: Fork, content: string): Promise<void>;
  // A registered session in `cwd`, in the main line's project, whose tmux
  // carries HESTIA_FORK_ID, named `alias`, recording where it was forked
  // from. One with this id already there is left as it is.
  ensureChildSession(input: { sessionId: string; cwd: string; projectId: string; fork: Fork; alias: string }): Promise<void>;
  // Starts the profile's CLI in it; with `from`, forking that conversation.
  // In `permissionMode` (absent: the setting that applies then).
  launch(
    sessionId: string, profileId: string, from: { sessionId: string; conversationId: string } | null, permissionMode?: PermissionMode,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  // The permission mode a branch line of `profileId` from tmux `sessionId`
  // gets: the user's `requested` one, else that tmux's or the global setting.
  launchPermissionMode(input: { sessionId: string; profileId: string; requested?: PermissionMode }): Promise<
    { ok: true; mode: PermissionMode } | { ok: false; code: 'permission_mode_unsupported' | 'permission_mode_unavailable'; message: string }
  >;
  // Closes its tmux as 關閉此 tmux does; `force` ends it as it is.
  closeChild(sessionId: string, force: boolean): Promise<CloseOutcome>;
  // Removing the worktree and its branch (`git branch -d`): what would be
  // refused, asked first; then doing it.
  workspaceRemovable(workspace: SpawnWorkspace): Promise<RemovalRefusal | null>;
  removeWorkspace(workspace: SpawnWorkspace): Promise<{ ok: true; removed: boolean; branchDeleted: boolean } | RemovalRefusal>;

  notify(fork: Fork, body: string): Promise<void>;
};
