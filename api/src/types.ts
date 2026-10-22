import type {
  LegacySessionStatus, PendingInteraction, Provider, SegmentHandoff, SessionActivity, Turn, TurnPhase,
} from './contract/index.js';
import type { PastedTextMark } from './pastedText.js';
import type { ModelChoice } from './contract/models.js';
import type { PermissionMode, SessionActualPermissionMode } from './contract/permissions.js';
import type { RuntimeId } from './runtimes/types.js';
import type { SessionObservations } from './sync/observations.js';
import type { SpawnSessionFields } from './spawn/session-fields.js';

// The stored records (registry.ts) and the rules read straight off them.
// What a client sees of them is session-dto.ts; whether a conversation can
// be resumed or forked, runtimes/conversation-blocks.ts.

// The running CLI's actual permission mode as stored (sync/permissionMode.ts).
export type ActualPermissionModeState = SessionActualPermissionMode & { changedInTerminal: boolean };

// The CLI lifecycle (docs/decisions/0007-session-state-machine.md §1). What the CLI is
// doing within a turn lives in `turnPhase`, not here; every write goes
// through registry.ts's lifecycle transition helper.
export type SessionStatus =
  | 'idle' // tmux pane exists, no CLI launched yet
  | 'launching' // CLI command sent, waiting for the pane to settle
  | 'ready' // CLI is up
  | 'dead'; // tmux session no longer exists

export type { LegacySessionStatus, PendingInteraction, Provider, SessionActivity, Turn, TurnPhase };

// LegacySessionStatus — the pre-split status that folded the turn phase in —
// is still what older registry files hold, and still what the public API's
// `status` reports for frontends that predate `turnPhase`.
// TurnPhase is only meaningful while status is 'ready' (ADR §1); any other
// status means there is no turn, whatever is stored. Changed only through
// sync/turnEffects.ts applyTurnEffects; entering 'ready' starts it over at
// 'idle'.

const LEGACY_STATUS: Record<TurnPhase, LegacySessionStatus> = {
  idle: 'ready',
  replying: 'waiting',
  awaiting_approval: 'needs_interaction',
};

// Migration / compatibility: a turn phase as the legacy status of a 'ready'
// session, and back.
export function statusForPhase(phase: TurnPhase): LegacySessionStatus {
  return LEGACY_STATUS[phase];
}

export function turnPhaseOf(status: LegacySessionStatus): TurnPhase | null {
  if (status === 'ready') return 'idle';
  if (status === 'waiting') return 'replying';
  if (status === 'needs_interaction') return 'awaiting_approval';
  return null;
}

// The current turn's phase, or null when the CLI isn't 'ready' (no turn).
// Records predating the field count as 'idle'.
export function activeTurnPhase(session: Pick<ManagedSession, 'status' | 'turnPhase'>): TurnPhase | null {
  return session.status === 'ready' ? (session.turnPhase ?? 'idle') : null;
}

export function legacyStatusOf(session: Pick<ManagedSession, 'status' | 'turnPhase'>): LegacySessionStatus {
  const phase = activeTurnPhase(session);
  return phase ? statusForPhase(phase) : session.status;
}

// Detected from the provider's own transcript first: today this only covers
// Claude's tool-permission prompts (an assistant `tool_use` block with no
// matching `tool_result` yet; see docs/reference/human-in-the-loop.md). The transcript
// alone can't tell a prompt apart from an already-approved tool that is still
// running, so when the adapter can read its pane (paneShowsPermissionPrompt)
// the pane has to confirm the prompt is actually on screen; an unreadable
// pane keeps the transcript's answer. Pane text never raises one on its own.
// (PendingInteraction: see the contract.)

export type PaneActivity = 'busy' | 'idle' | 'unknown';

// A blocking prompt the CLI showed at start-up, recognized from its pane
// (runtimes/types.ts StartupPromptReading). While set, app sends are held
// back instead of being typed into the prompt.
export type StartupPrompt = { kind: 'workspace_trust'; detectedAt: string };

// What lastError held for the stuck hint before it became its own field
// (stuckSince). Read only to migrate records written then, and written only
// into the public lastError for PWAs cached before contract v1, which may
// show that field as-is.
export const STUCK_HINT_TEXT = '一段時間沒有偵測到任何回應，可能卡在需要手動操作的畫面（例如 slash command 選單），請至終端機確認。';

// The one thing the UI shows about what the CLI is doing right now. Status,
// pendingInteraction, the stuck hint and a pending /clear are independent
// fields that can overlap; this collapses them into a single state by
// priority, so the frontend never has to decide which of two signals wins.
// (SessionActivity: see the contract.)

// First matching rule wins.
// 'replying' only means "sent, not imported yet" — whether the CLI is
// actually working comes from the pane; with no pane reading (unknown) it
// stays 'busy', the conservative "a reply is on its way". Same result as the
// pre-split derivation from the legacy status, for every combination.
export function deriveSessionActivity(
  session: Pick<ManagedSession, 'status' | 'turnPhase' | 'clearPending' | 'stuckSince' | 'paneActivity' | 'startupPrompt'>,
): SessionActivity {
  if (session.status === 'dead') return 'ended';
  if (session.clearPending || session.status === 'launching') return 'starting';
  if (session.status === 'idle') return 'not_started';
  if (session.startupPrompt) return 'awaiting_approval';
  const phase = activeTurnPhase(session);
  if (phase === 'awaiting_approval') return 'awaiting_approval';
  if (session.stuckSince) return 'stalled';
  if (phase === 'replying' && session.paneActivity !== 'idle') return 'busy';
  return 'idle';
}

// One tmux session's record. Its fields are grouped by who owns them: the
// session's own lifecycle and conversations here, what the poller observes
// of the running CLI (sync/observations.ts) and what a branch line or a
// delegate's session carries (spawn/session-fields.ts). The stored record
// is one flat object either way.
export type ManagedSession = SessionCore & SessionObservations & SpawnSessionFields;

type SessionCore = {
  id: string; // uuid, also the suffix of the tmux session name
  tmuxName: string; // `${SESSION_PREFIX}${id}`
  // The tmux server (`tmux -L`) it lives on: TMUX_SOCKET for sessions opened
  // since this was recorded; null or missing for older ones, which stay on
  // the user's default server until they end (tmux.ts SocketLookup).
  tmuxSocket?: string | null;
  cwd: string;
  // 一個 session 永遠恰好屬於一個 project，必填，不可為 null。
  projectId: string;
  // User-facing display name, set via PATCH /sessions/:id — deliberately
  // separate from both tmuxName (internal bookkeeping) and whatever name
  // a provider's own CLI was launched with (e.g. Claude's `-n`, a
  // one-shot, provider-cosmetic thing that isn't even supported by every
  // provider and was never stored here). Renaming this never touches the
  // tmux session or the running CLI process.
  alias: string | null;
  sessionNumber?: number;
  createdAt: string;
  provider: Provider | null;
  /** Runtime implementation of the active CLI; absent only on legacy records. */
  runtimeId?: RuntimeId | null;
  providerSessionId: string | null;
  providerSessionFile: string | null; // resolved lazily; cached once found
  providerLaunchedAt: string | null;
  status: SessionStatus;
  // Only meaningful while status is 'ready' — read it through
  // activeTurnPhase. Registry load backfills it (see registry.ts
  // migrateTurnPhase); optional only so hand-built records (tests, older
  // callers) needn't spell out the default, which is 'idle'.
  turnPhase?: TurnPhase;
  lastUserMessageAt: string | null;
  // The text of the most recent message sent via POST /messages (not
  // /respond — this is specifically the "did my chat message actually
  // reach the CLI" tracking, see routes/messages.ts and polling.ts's own
  // comments). Reset (along with deliveryUnconfirmedText) every time a
  // new message is sent, so only the latest send is ever tracked.
  lastUserMessageText: string | null;
  // Set once DELIVERY_ECHO_TIMEOUT_MS has passed with no real user-role
  // entry appearing in the transcript since lastUserMessageAt — the
  // message this holds is a "possibly not delivered" flag the frontend
  // shows on that specific pending bubble. null the rest of the time,
  // including once an echo does eventually appear (checked every poll,
  // not just once at the timeout mark).
  deliveryUnconfirmedText: string | null;
  // A real error to show (a failed launch, an unconfirmed restart …); never
  // the stuck hint, which is stuckSince.
  lastError: string | null;
  // Since when a replying turn has looked stuck: nothing in the transcript
  // for STUCK_HINT_MS and a pane that isn't visibly busy (sync/turnMachine.ts).
  // Cleared once anything moves or the turn ends. Absent on older records.
  stuckSince?: string | null;
  pendingInteraction: PendingInteraction | null;
  turns: Turn[]; // finalized turns delivered to the frontend so far
  // Which transcript file `turns` was accumulated from. A relaunch (manual
  // or auto-restart-on-crash) points providerSessionFile at a brand new
  // file whose own turn numbering starts back at 0 — comparing against this
  // (instead of assuming turns.length always means "already-seen count in
  // the current file") is what lets polling.ts tell "new file, start over"
  // apart from "same file, more turns appended".
  turnsSourceFile: string | null;
  // Persisted launch context is backend-only except for its non-path identity projection.
  launchProfile?: LaunchProfileSnapshot | null;
  // Conversation history is segmented within this long-lived tmux container.
  // Legacy top-level turns remain temporarily available to older internal callers.
  activeConversationId?: string | null;
  conversations?: ConversationSegment[];
  // Persisted provisional launch attempt. It is not a conversation until
  // provider liveness is positively confirmed, and its private profile
  // snapshot never crosses the public DTO boundary.
  launchPending?: PendingLaunchAttempt | null;
  // A dead-session resume is explicitly claimed before creating or
  // sending to tmux. Persisted so a process restart can inspect liveness but
  // never re-send the command automatically.
  resumePending?: PendingResumeAttempt | null;
  // A CLI /clear or Claude conversation switch is a durable two-step operation. argv and IDs are private
  // launch data; pollers may observe the phase after a restart but never replay
  // a command whose delivery could be uncertain.
  clearPending?: PendingClearAttempt | null;
  // When the user deleted the session (DELETE /sessions/:id): it sits in
  // the project's trash until restored or purged. A visibility flag, not a
  // lifecycle status — a trashed record is always 'dead'. Absent or null
  // (every record from before the trash) means live; see isTrashed.
  deletedAt?: string | null;
};

/**
 * Whether the record is in the trash. Only a non-empty string counts, so a
 * record from before the trash, or one with a damaged value, stays live
 * rather than vanishing.
 */
export function isTrashed(session: Pick<ManagedSession, 'deletedAt'>): boolean {
  return typeof session.deletedAt === 'string' && session.deletedAt !== '';
}

export type PendingResumeAttempt = {
  attemptId: string;
  conversationId: string;
  startedAt: string;
};

// Also carries a switch to an earlier conversation ("continue #1 in this
// tmux"): the same exit-then-launch-in-the-same-tmux machinery, except the
// launch is its runtime's resume (`claude --resume <id>`) and success reopens
// that conversation rather than starting a new one. `targetConversationId`
// set is what makes it a switch.
export type PendingClearAttempt = {
  attemptId: string;
  /** An old targetConversationId marks a switch during registry migration. */
  operation?: 'clear' | 'conversation_switch';
  // The conversation being left. A switch can start from no running
  // conversation at all (idle / dead tmux), hence nullable.
  conversationId: string | null;
  /** Runtime-neutral identity; optional only for pre-runtime legacy records. */
  provider?: Provider;
  runtimeId?: RuntimeId;
  newProviderSessionId: string | null;
  /** Reserved when clear is claimed; stable across registry reloads. */
  newConversationId?: string;
  launchArgv: string[];
  startedAt: string;
  previousStatus: SessionStatus;
  // The turn phase a rollback to a 'ready' previousStatus puts back (absent:
  // 'idle'). A rollback returns to the same running CLI, so its turn
  // carries on rather than starting over.
  previousTurnPhase?: TurnPhase;
  // 'awaiting_force': the running CLI didn't exit in time, or can't be
  // asked to — waiting on the user to allow a forced pane reset, or cancel.
  phase: 'waiting_exit' | 'awaiting_force' | 'launching';
  delivery?: 'not_sent' | 'exit_uncertain' | 'launch_uncertain' | 'confirmed';
  launchStartedAt: string | null;
  targetConversationId?: string | null;
  // Which CLI the exit is waited on (liveness identity) — the running one
  // may not be Claude when switching. Absent means Claude (a /clear).
  exitProvider?: Provider | null;
  // When the exit was requested; a switch asks the user to force it once
  // this is older than RUNTIME_EXIT_TIMEOUT_MS.
  exitRequestedAt?: string | null;
  // A handoff to another launch profile (continuity/): the new conversation
  // runs this profile instead of the one being left, and both segments
  // record a provider_switch. Absent: an ordinary /clear on the same profile.
  launchProfile?: LaunchProfileSnapshot;
};

export type PendingLaunchAttempt = {
  provider: Provider;
  runtimeId?: RuntimeId;
  providerSessionId: string | null;
  providerLaunchedAt: string;
  previousStatus: SessionStatus;
  // As PendingClearAttempt's.
  previousTurnPhase?: TurnPhase;
  launchProfile: LaunchProfileSnapshot;
  // A branch line's launch, forking the conversation it came from (the
  // conversation it starts is a 'fork' one).
  fork?: { fromSessionId: string; fromConversationId: string };
};

export type ConversationSegment = {
  id: string;
  sequence: number;
  kind: 'cli';
  provider: Provider | null;
  runtimeId?: RuntimeId | null;
  launchProfile: LaunchProfileSnapshot | null;
  providerSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  startReason: 'launch' | 'provider_switch' | 'relaunch' | 'clear' | 'legacy_migration' | 'runtime_recovery' | 'fork';
  endReason: 'relaunch' | 'provider_switch' | 'clear' | 'cli_exit' | 'unknown' | null;
  transcript: {
    state: 'pending' | 'resolved' | 'not_found' | 'ambiguous' | 'legacy_unverified';
    file: string | null;
    identity: 'pinned_id' | 'verified_metadata' | 'claude_clear_heuristic' | null;
  };
  // Number of provider turns already present when a recovered runtime was
  // attached. Private checkpoint; never part of the browser DTO.
  transcriptTurnOffset?: number | null;
  lastUserMessageAt: string | null;
  lastUserMessageText: string | null;
  deliveryUnconfirmedText: string | null;
  // App sends not yet seen in the transcript (sync/delivery.ts). Absent on
  // records written before tracking existed, which means none.
  unconfirmedSends?: OutgoingSend[];
  // Transcript times of the messages typed in the terminal rather than sent
  // by the app (the latest ones), so the chat can mark them.
  terminalMessageAts?: string[];
  // The parts of the app's latest sends that were pasted text
  // (pastedText.ts), so the chat can show each as one block.
  pastedTexts?: PastedTextMark[];
  pendingInteraction: PendingInteraction | null;
  transcriptError: string | null;
  turns: Turn[];
  // What the app last switched this conversation's model to (routes/
  // models.ts). Absent: never switched from the app.
  model?: ModelChoice | null;
  // The handoff this conversation started from (continuity/), with its
  // brief's file (relative to cwd; never in a DTO).
  handoff?: SegmentHandoffRecord | null;
};

export type SegmentHandoffRecord = SegmentHandoff & { briefFile: string | null };

/** One app send not yet seen as a user message in the CLI's transcript. */
export type OutgoingSend = {
  text: string;
  at: string;
  // Set once DELIVERY_ECHO_TIMEOUT_MS passed with no echo: shown to the
  // user as possibly undelivered, with its text kept for resending.
  flagged: boolean;
  // Sent while an earlier reply was still being written. The CLI holds such
  // a message until it can take it, so its echo timeout only runs while no
  // reply is in progress (see sync/delivery.ts reconcileSends).
  midReply?: boolean;
  // When the CLI was seen starting a turn right after this send (made from
  // idle): it took the message in, though its text may only reach the
  // transcript later — Codex 0.161.0 compacts a long conversation first.
  // Holds back the echo timeout (see sync/delivery.ts reconcileSends).
  receivedAt?: string;
};

export type LaunchProfileSnapshot = {
  id: string;
  provider: Provider;
  runtimeId?: RuntimeId;
  source: 'native' | 'janus';
  profileName?: string;
  home?: string;
  conversationRoot?: string;
  // Snapshot native CLI options at launch so a future explicit resume does
  // not silently inherit edited profile settings.
  args?: string[];
  delegate: { kind: 'native'; executable: string } | { kind: 'janus'; executable: string };
  // The launch permission mode (contract/permissions.ts) this conversation
  // was started in; /clear and resume start it the same way. Absent:
  // cli_default (nothing passed), as for every snapshot older than modes.
  permissionMode?: PermissionMode;
};
