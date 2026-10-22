import type { TurnProcessBrief } from './process.js';
import type { TextAttachment, TextRange } from './attachments.js';
import type { ErrorCode, ErrorParams } from './errors.js';
import type { BriefNoteCode, HandoffConfirm, HandoffSource, HandoffTrigger } from './continuity.js';
import type { Provider, RuntimeId } from './runtimes.js';
import type { PermissionMode, SessionActualPermissionMode } from './permissions.js';
import type { SpawnClosable } from './workspace.js';

// What the API sends about tmux sessions and their conversations. The API
// builds these in api/src/session-dto.ts (toPublicManagedSession,
// toPublicConversation), typed against these declarations so the two can't
// drift; the web app reads them as they are.

/** The CLI lifecycle (docs/decisions/0007-session-state-machine.md §1). */
export type SessionLifecycle = 'idle' | 'launching' | 'ready' | 'dead';

/**
 * The pre-split status that folded the turn phase in.
 * @deprecated Contract v1: read `activity` and `turnPhase`.
 * Still sent for PWAs cached before them; see "相容性與棄用" in
 * docs/reference/api-contract-v1.md.
 */
export type LegacySessionStatus = SessionLifecycle | 'waiting' | 'needs_interaction';

/** The phase of the current turn; null while the CLI isn't running. */
export type TurnPhase = 'idle' | 'replying' | 'awaiting_approval';

/**
 * The one "what is the CLI doing right now" state, derived by the API from
 * the lifecycle, the turn, a pending prompt or restart and the CLI's pane
 * (the rules are in types.ts). Exactly one at a time.
 */
export type SessionActivity = 'ended' | 'starting' | 'not_started' | 'awaiting_approval' | 'stalled' | 'busy' | 'idle';

/**
 * One row of a prompt the CLI shows, as read from its screen. `number` is
 * the number the CLI shows (null for a multi-select question's "Next" row).
 * `freeText`: the row the user types an answer into (its `label` is what is
 * typed there so far, '' when nothing is). `amendable`: a permission row
 * that can carry a note to the CLI along with the choice. `checked`: a
 * multi-select question's checkbox, null elsewhere.
 */
export type InteractionOption = {
  number: number | null;
  label: string;
  description: string | null;
  freeText: boolean;
  amendable: boolean;
  checked: boolean | null;
};

/**
 * A prompt the CLI is showing and waiting on, as read from its screen:
 * a tool permission, a question it asks, or the review of its answers
 * before they are submitted. `detail`: what the prompt is about (a
 * permission's command, the answers under review), '\n'-separated.
 * `steps`: a question that is one of several, each with whether it is
 * answered yet; null for a single question.
 */
export type InteractionScreen = {
  kind: 'permission' | 'question' | 'review';
  title: string;
  detail: string | null;
  options: InteractionOption[];
  multiSelect: boolean;
  steps: { label: string; answered: boolean }[] | null;
};

// `screen` (contract v1 addition): the prompt as read from the CLI's screen,
// which the app can answer (POST /sessions/:id/interaction). Absent when
// only the transcript knows of it. A prompt only the screen shows (Claude
// Code 2.1.284 writes nothing while one waits) has kind 'question' for
// AskUserQuestion, a `toolUseId` starting "pane:" and `input` null.
export type PendingInteraction = {
  kind: 'tool_permission' | 'question';
  toolUseId: string;
  toolName: string;
  input: unknown;
  detectedAt: string;
  screen?: InteractionScreen;
};

// `attachments`: the uploads a message refers to, recognized by the API
// (contract v1; absent from older APIs, and from stored turns).
// fromTerminal: typed straight into the CLI's terminal, not sent by the app.
// pastes (capability composer_attachments): the parts of `text` the app
// sent as pasted text, which a client may show as one block each.
export type UserMessage = { text: string; at: string | null; attachments?: TextAttachment[]; pastes?: TextRange[]; fromTerminal?: true };

export type Turn = {
  index: number;
  user: UserMessage;
  // Messages sent while this turn's reply was still being written, which
  // the CLI took in mid-turn rather than as turns of their own.
  followUps?: UserMessage[];
  // `interrupted`: the user stopped this reply mid-generation; `text` is
  // what had been written by then (possibly nothing). How that shows is the
  // client's call. Absent when it wasn't interrupted.
  //
  // A contract-v1 API still appends the old marker '（已中斷）' to `text`
  // of an interrupted reply, for PWAs cached before this flag; a client
  // reading `interrupted` takes that suffix off (see "相容性與棄用"
  // in docs/reference/api-contract-v1.md).
  assistant: { text: string; at: string | null; interrupted?: true };
};

// A turn as GET /sessions/:id/conversations/:id sends it: `process`
// (capability `turn_process`) is read from the transcript for the request
// and is never part of a stored turn.
export type PublicTurn = Turn & { process?: TurnProcessBrief };

/** @deprecated Contract v1: the marker appended for cached PWAs. */
export const LEGACY_INTERRUPTED_MARKER = '（已中斷）';

// 'fork': a branch line's first conversation, forked from another one's
// memory (the `fork` capability).
export type ConversationStartReason = 'launch' | 'provider_switch' | 'relaunch' | 'clear' | 'legacy_migration' | 'runtime_recovery' | 'fork';

/**
 * The handoff a conversation started from (capability `handoff_brief`;
 * docs/specs/session-timeline.md §4.1): which handoff, who wrote its brief
 * and what was asked of the CLI taking over. Its brief is read with GET
 * /sessions/:id/continuity/handoffs/:handoffId/brief. One `derived` from an
 * older handoff's briefing message knows only the id's first 8 characters,
 * and nothing else.
 */
export type SegmentHandoff = {
  handoffId: string;
  trigger: HandoffTrigger | null;
  fromConversationId: string | null;
  // Who wrote the brief's main part (ContinuityHandoff.briefSource).
  briefSource: 'self' | 'mechanical' | 'incoming' | null;
  // Who was to write it (ContinuityHandoff.source): 'self_then_mechanical'
  // with briefSource 'mechanical' means the LLM being left didn't manage;
  // briefNote says why (in the brief's words), briefNoteCode as a code the
  // app words itself (absent on records written before it).
  source: HandoffSource | null;
  briefNote: string | null;
  briefNoteCode?: BriefNoteCode | null;
  confirm: HandoffConfirm | null;
  // 'incoming' and waiting for the user: whether the CLI taking over added
  // its notes to the brief. null when not known (not yet, or it was told to
  // carry on — then it is never judged).
  briefAmended: boolean | null;
  derived?: boolean;
};
export type ConversationEndReason = 'relaunch' | 'provider_switch' | 'clear' | 'cli_exit' | 'unknown' | null;
export type TranscriptState = 'pending' | 'resolved' | 'not_found' | 'ambiguous' | 'legacy_unverified';
export type TranscriptIdentity = 'pinned_id' | 'verified_metadata' | 'claude_clear_heuristic' | null;
export type ProfileSource = 'native' | 'janus';

/** One conversation of a session, as listed on the session (no turns). */
export type ConversationSummary = {
  id: string;
  sequence: number;
  provider: Provider | null;
  runtimeId?: RuntimeId | null;
  startedAt: string;
  endedAt: string | null;
  startReason: ConversationStartReason;
  endReason: ConversationEndReason;
  transcriptState: TranscriptState;
  transcriptError: string | null;
  turnsCount: number;
  // Changes on a new turn and also when the last turn's reply grows in
  // place, which turnsCount alone can't show: the signal to reload.
  turnsFingerprint: string;
  // Why this conversation can't be continued in its tmux; null if it can.
  // `resumeBlocked` is the same as an error code (contract/errors.ts) for a
  // client to word itself; `resumeBlockedReason` is the API's own text.
  resumeBlockedReason: string | null;
  resumeBlocked?: null | { code: ErrorCode; params?: ErrorParams };
  // permissionMode: the launch permission mode it was started in
  // (permissions.ts); absent from a backend without `permission_modes`.
  launchProfile: null | { id: string; source: ProfileSource; runtimeId?: RuntimeId; profileName?: string; permissionMode?: PermissionMode };
  // The handoff this conversation started from; null when none (or not
  // known). Absent from a backend without `handoff_brief`.
  handoff?: SegmentHandoff | null;
  // How many times the user spoke (follow-ups included, a handoff's own
  // messages not): the chat's 輪. null while the transcript isn't
  // resolved. Absent from a backend without `session_timeline`.
  userMessagesCount?: number | null;
};

/** GET /sessions/:id/conversations/:conversationId. */
export type ConversationDetail = {
  id: string;
  sequence: number;
  kind: 'cli';
  provider: Provider | null;
  runtimeId?: RuntimeId | null;
  launchProfile: null | { id: string; provider: Provider; runtimeId?: RuntimeId; source: ProfileSource; profileName?: string; permissionMode?: PermissionMode };
  startedAt: string;
  endedAt: string | null;
  startReason: ConversationStartReason;
  endReason: ConversationEndReason;
  transcript: { state: TranscriptState; identity: TranscriptIdentity };
  lastUserMessageAt: string | null;
  lastUserMessageText: string | null;
  deliveryUnconfirmedText: string | null;
  pendingInteraction: PendingInteraction | null;
  transcriptError: string | null;
  turns: PublicTurn[];
  handoff?: SegmentHandoff | null;
  userMessagesCount?: number | null;
};

export type PendingPhase = 'waiting_exit' | 'awaiting_force' | 'launching';
export type PendingDelivery = 'not_sent' | 'exit_uncertain' | 'launch_uncertain' | 'confirmed';

/**
 * The git checkout the CLI is working in: the folder its transcript last
 * recorded (it follows the CLI into a worktree), else the session's own.
 */
export type SessionWorkspace = {
  // Top folder of the checkout.
  root: string;
  // null: detached HEAD.
  branch: string | null;
  // A worktree added with `git worktree add`, not the repo's main checkout.
  linkedWorktree: boolean;
  // The branch is the repo's default (origin's HEAD, else main or master).
  defaultBranch: boolean;
};

export type SessionForkOrigin = { forkId: string; fromSessionId: string; fromConversationId: string; sharedFolder: boolean };
// A delegate's session: the delegation it works on, and the session and
// conversation that delegated it (null once the delegation no longer knows).
export type SessionDelegationOrigin = { delegationId: string; fromSessionId: string | null; fromConversationId: string | null };

/**
 * A tmux session and the CLI in it. The optional fields are always sent by
 * a contract-v1 API; they are optional because clients also hold copies
 * cached from APIs that predate them.
 */
export type SessionDto = {
  id: string;
  tmuxName: string;
  // The tmux server it is on (`tmux -L <tmuxSocket> attach -t <tmuxName>`);
  // null: the default server.
  tmuxSocket?: string | null;
  cwd: string;
  projectId: string;
  alias: string | null;
  sessionNumber?: number;
  createdAt: string;
  provider: Provider | null;
  runtimeId?: RuntimeId | null;
  providerLaunchedAt: string | null;
  // When anything last happened in its active conversation: the last
  // reply (or message), else the last send, else when the tmux opened.
  // What lists sort by. Absent from APIs before contract v1.
  lastActivityAt?: string;
  // null while the CLI isn't running ('ready'): there is no turn then.
  turnPhase: TurnPhase | null;
  activity: SessionActivity;
  // How many of the CLI's own background subagents are still running —
  // possibly after its turn ended, while `activity` is already 'idle'. Only
  // an indicator: the session takes messages as usual meanwhile. Absent
  // from APIs before it (read as 0).
  backgroundAgents?: number;
  // The CLI is on a turn it started by itself — woken by a background
  // subagent's or task's result — while `activity` is 'idle'. Only an
  // indicator, like backgroundAgents. Absent from APIs before it (false).
  backgroundTurn?: boolean;
  // The permission mode the running CLI is actually in, by its own
  // transcript (ADR 0027): null while it can't be told (no CLI running, no
  // record yet, a CLI that doesn't record it). permissionModeChangedInTerminal:
  // it differs from the mode the CLI was launched in (for a CLI-default
  // launch: from the conversation's first recorded mode). Absent from APIs
  // before them (null, false).
  actualPermissionMode?: SessionActualPermissionMode | null;
  permissionModeChangedInTerminal?: boolean;
  // The next message the CLI itself suggests (Claude Code's dim ghost text
  // in its empty input box), only while it is idle at its prompt; null
  // otherwise. The app only offers it — it is never typed into the CLI
  // unless the user sends it as an ordinary message. Absent from APIs
  // before it (read as null).
  cliSuggestion?: string | null;
  // A /clear restart in progress (not a conversation switch).
  clearPending: null | { runtimeId: RuntimeId; phase: PendingPhase; delivery: PendingDelivery };
  // A switch to an earlier conversation in progress. 'awaiting_force': the
  // running CLI didn't exit — the user decides whether to force it.
  conversationSwitch: null | { targetConversationId: string; phase: PendingPhase };
  // When the launch still waiting for its startup to be confirmed was sent;
  // null when none is. Absent from backends before it was added.
  launchStartedAt?: string | null;
  lastUserMessageAt: string | null;
  lastUserMessageText: string | null;
  deliveryUnconfirmedText: string | null;
  // Sends the CLI's transcript never showed, oldest first, kept so they can
  // be put back into the composer or dismissed.
  undeliveredMessages?: { text: string; sentAt: string }[];
  // A blocking prompt the CLI opened with (e.g. Agy asking whether to trust
  // this folder). Sends are held back until it is answered.
  startupPrompt?: null | { kind: 'workspace_trust'; runtimeId?: RuntimeId };
  // The account-status id of the account the running CLI uses; null when
  // it can't be told or its quota can't be read.
  quotaAccountId?: string | null;
  // Whether POST /sessions/:id/recover can resume this dead tmux's
  // conversation.
  recoverable?: boolean;
  // null: not in a git checkout, or not looked at yet. Absent from APIs
  // before it.
  workspace?: SessionWorkspace | null;
  // A real error to show. (A contract-v1 API still puts the stuck hint's
  // text here while stuckSince is set, for PWAs cached before it; read
  // stuckSince for that.)
  lastError: string | null;
  // Since when the reply in progress has looked stuck (activity 'stalled'
  // says the same); null otherwise. Absent from APIs before contract v1.
  stuckSince?: string | null;
  pendingInteraction: PendingInteraction | null;
  activeConversationId: string | null;
  conversations: ConversationSummary[];
  // A branch line: the fork it is, and the session and conversation it was
  // forked from (GET /forks/:forkId has the rest); `sharedFolder` when it
  // works in that session's own folder. null otherwise; absent from APIs
  // before the `fork` capability.
  fork?: SessionForkOrigin | null;
  // A delegate's session: the delegation it works on and where that was
  // started (GET /delegations/:id has the rest). null otherwise; absent from
  // APIs before the `delegation_origin` capability.
  delegation?: SessionDelegationOrigin | null;
  // A branch line's or delegate's session that looks finished and may be
  // closed (workspace.ts SpawnClosable); null otherwise. Re-checked at most
  // every CLOSABLE_REFRESH_MS (30 s), so it can lag a merge a little.
  // Absent from APIs before it.
  closable?: SpawnClosable | null;
  // When this branch line or delegate was closed (收掉: its worktree gone,
  // so it can't be resumed; only its record is left); null otherwise.
  // Absent from APIs before it.
  spawnClosedAt?: string | null;
  launchProfile?: null | {
    id: string; provider: Provider; runtimeId?: RuntimeId; source: ProfileSource; profileName?: string; delegate: ProfileSource;
    permissionMode?: PermissionMode;
  };
};

/**
 * What the endpoints that predate contract v1 send: SessionDto plus fields
 * only PWAs cached before it read.
 */
export type LegacySessionDto = SessionDto & {
  /** @deprecated Contract v1: read `activity` / `turnPhase`. */
  status: LegacySessionStatus;
  /** @deprecated Use clearPending. */
  claudeClearPending: boolean;
  /**
   * @deprecated Contract v1: the active conversation's turns
   * come from GET /sessions/:id/conversations/:conversationId.
   */
  turns: Turn[];
};

/**
 * One session in a project's trash (GET /sessions/trash), with what the
 * trash lists it by: when it was deleted, and the last message of its
 * conversation (the active one's, else the latest one with any turns) cut
 * to TRASH_LAST_MESSAGE_CHARS characters; null when it has none.
 */
export type TrashedSessionDto = SessionDto & {
  deletedAt: string;
  lastMessage: { role: 'user' | 'assistant'; text: string; at: string | null } | null;
};

export const TRASH_LAST_MESSAGE_CHARS = 200;

/** GET /sessions/trash?projectId=: newest deletion first. */
export type TrashedSessionList = { sessions: TrashedSessionDto[] };

/**
 * GET /sessions/:id/events: that session's updates. `restored` (backends
 * with session_trash): the session was taken back out of the trash; a
 * client that doesn't know the type may treat it like `update`, or ignore it.
 */
export type SessionEvent =
  | { type: 'update'; session: LegacySessionDto }
  | { type: 'restored'; session: LegacySessionDto }
  | { type: 'deleted' };

/**
 * GET /sessions/events: every session, for lists. The whole list first
 * (again after every reconnect), then each change. Contract v1 only, so it
 * sends the DTO without the deprecated fields.
 */
export type SessionListEvent =
  | { type: 'snapshot'; sessions: SessionDto[] }
  | { type: 'update'; session: SessionDto }
  // Backends with session_trash: taken back out of the trash. Unlike an
  // update, it lifts a deletion the client has seen; a client must ignore
  // an event type it doesn't know.
  | { type: 'restored'; session: SessionDto }
  | { type: 'deleted'; sessionId: string };
