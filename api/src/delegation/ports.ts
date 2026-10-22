import type { Delegation, DelegationIsolation, DelegationWorkspace } from '../contract/delegation.js';
import type { PermissionMode } from '../contract/permissions.js';
import type { ScreenReading } from '../launch-guard/decide.js';
import type { SendOutcome, SessionView } from '../spawn/ports.js';
import type { RemovalRefusal } from '../spawn/workspace.js';
import type { UpstreamView } from '../upstream/view.js';
import type { QuotaReading } from './policy.js';

// Everything delegation/ reads from or does to the rest of the app. The
// real implementations are in wiring.ts; tests pass their own.

/** The delegating session, as a delegation needs it. */
export type ParentView = {
  cwd: string;
  projectId: string;
  tmuxName: string;
  conversationId: string | null;
  profileId: string | null;
  profileLabel: string | null;
};

/**
 * A session's CLI as a delegation sees it: the delegate's, and the
 * delegating session's when a message waits to go to it (spawn/session.ts).
 */
export type ChildView = SessionView;

export type { SendOutcome } from '../spawn/ports.js';

export type ProfileInfo = { id: string; label: string };

export type { RemovalRefusal } from '../spawn/workspace.js';

export type DelegationPorts = {
  now(): Date;
  // A short id for a new delegation, and an id for its session.
  newId(): string;
  newSessionId(): string;

  readParent(sessionId: string): Promise<ParentView | null>;
  listProfiles(): Promise<ProfileInfo[]>;
  // The quota of the account behind a profile: the account-status snapshot,
  // and whether continuity has seen it over its limit. Unknown is null.
  readQuota(profileId: string): Promise<QuotaReading>;

  // Where the delegate will work, read without changing anything: a new
  // worktree beside the repo (or under the state dir when that isn't
  // writable), or the delegating session's own folder when it isn't in a
  // git repo or 'shared' was asked for.
  planWorkspace(input: { id: string; branch: string; parentCwd: string; isolation: DelegationIsolation }): Promise<DelegationWorkspace>;
  // Makes the planned worktree; one already there on the right branch is
  // taken as it is. Throws when that can't be done.
  ensureWorkspace(workspace: DelegationWorkspace): Promise<void>;
  // Whether the delegate's work is all committed, and its HEAD.
  workspaceState(workspace: DelegationWorkspace): Promise<{ clean: boolean; head: string | null }>;
  // The branch the repo it was cut from has checked out, once that has the
  // commit it was delivered at (`headAtDelivery`, past its base); null
  // otherwise. Throws when git fails.
  deliveryMergedInto(workspace: DelegationWorkspace): Promise<string | null>;
  // Once it is over, at the user's word: removes the worktree (only with
  // nothing uncommitted; skipped when `removedAt` says it is gone already),
  // and with `deleteBranch` its branch (only a merged one). Nothing is done
  // when either is refused. Throws when git fails.
  removeWorkspace(workspace: DelegationWorkspace, options: { deleteBranch: boolean }): Promise<
    { ok: true; removed: boolean; branchDeleted: boolean } | RemovalRefusal
  >;
  // What removeWorkspace would refuse, asked before anything is done; null when nothing.
  workspaceRemovable(workspace: DelegationWorkspace, options: { deleteBranch: boolean }): Promise<RemovalRefusal | null>;
  // Closes the delegate's tmux as the app's 關閉此 tmux does: its CLI asked
  // to exit first (`force`: closed even when the exit can't be confirmed).
  // `closed` is false when there was no tmux left to close.
  closeChild(sessionId: string, force?: boolean): Promise<{ ok: true; closed: boolean } | { ok: false; reason: 'cli_busy' | 'exit_unverified' | 'in_transition' }>;
  // Whether the delegating session's own folder has uncommitted changes
  // (which the worktree won't have); null when unknown.
  parentDirty(parentCwd: string): Promise<boolean | null>;
  // Where the delegating conversation can be read, up to its `upTo`th turn
  // (null: all of it) — never a copy of it (upstream/view.ts, ADR 0023).
  readUpstream(sessionId: string, conversationId: string, upTo: number | null): Promise<UpstreamView>;
  // Writes the brief (and its folder's .gitignore) at delegation.briefFile.
  writeBrief(delegation: Delegation, content: string): Promise<void>;
  // Writes what the delegating conversation is told about, in its own
  // folder (<cwd>/.hestia/delegations/<id>/, ignored by git); answers the
  // file's absolute path. Throws when that session is gone.
  writeParentReport(delegation: Delegation, content: string): Promise<string>;
  // Writes a send-back's feedback beside the delegate's brief
  // (feedback-<round>.md); answers its absolute path.
  writeFeedback(delegation: Delegation, round: number, content: string): Promise<string>;
  // Whether the delegating session is still on the work it delegated from
  // `conversationId`: that conversation, or one continuity handed it on to
  // (a /clear or a new conversation is other work). True when there is no
  // conversation to compare.
  sameWork(sessionId: string, conversationId: string | null): Promise<boolean>;

  // A registered session in `cwd`, in the delegating session's project,
  // whose tmux carries HESTIA_DELEGATION_ID, named `alias`, recording
  // `origin` (where the delegation was started) on it. One with this id
  // already there is left as it is.
  ensureChildSession(input: {
    sessionId: string; cwd: string; projectId: string; delegationId: string; alias: string;
    origin: { fromSessionId: string | null; fromConversationId: string | null };
  }): Promise<void>;
  // Starts the profile's CLI in it, as the app's own launch does, in
  // `permissionMode` (absent: the setting that applies then).
  launch(sessionId: string, profileId: string, permissionMode?: PermissionMode): Promise<{ ok: true } | { ok: false; reason: string }>;
  // The permission mode a delegate of `profileId` started from tmux
  // `sessionId` gets: the user's `requested` one, else that tmux's or the
  // global setting; `llm` caps it below yolo (permission-modes/policy.ts).
  launchPermissionMode(input: { sessionId: string; profileId: string; requested?: PermissionMode; llm: boolean }): Promise<
    { ok: true; mode: PermissionMode } | { ok: false; code: 'permission_mode_unsupported' | 'permission_mode_unavailable'; message: string }
  >;
  // Any session's CLI (the delegate's, or the delegating one's); null when
  // the session is gone.
  readChild(sessionId: string): Promise<ChildView | null>;
  // Answers the CLI's start-up trust prompt with "trust".
  answerTrust(sessionId: string): Promise<'answered' | 'unsure'>;
  send(sessionId: string, text: string): Promise<SendOutcome>;
  // Whether the CLI took `text` in whole as its latest user message since
  // `since` (continuity's read-back).
  checkDelivered(sessionId: string, text: string, since: string): Promise<'exact' | 'partial' | 'missing' | 'unknown'>;
  // The launch guard's looks at the CLI's screen (spawn/ports.ts).
  readScreen(sessionId: string): Promise<ScreenReading | null>;
  skipUpdate(sessionId: string): Promise<'answered' | 'not_shown' | 'unsure'>;
  // The reply to the first turn that began at or after `since`, once it is
  // over; null before.
  firstReplyAfter(sessionId: string, since: string): Promise<string | null>;
  // Continuity has a carry-on pending, or a handoff going, for this session
  // (the delegate's, or the delegating one's).
  continuityBusy(sessionId: string): Promise<boolean>;
  // When continuity carries this session on after its usage limit resets,
  // while it waits for that; null when it isn't waiting.
  limitWaitUntil(sessionId: string): Promise<string | null>;
  interrupt(sessionId: string): Promise<void>;

  notify(delegation: Delegation, body: string): Promise<void>;
};
