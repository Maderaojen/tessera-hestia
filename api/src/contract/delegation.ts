// Handing a piece of work to another LLM in a tmux of its own.
// Needs the `delegation` capability (meta.ts).

import type { PermissionMode } from './permissions.js';
import type { SpawnIsolation, SpawnStartup, SpawnWorkspace } from './workspace.js';
import { typedText, type TypedKey } from './typed.js';

/**
 * proposed      an LLM asked (llmInitiated 'ask'); waiting for the user to
 *               approve or decline it. Nothing is made until then; 24 hours
 *               without an answer stops it ('expired')
 * starting      worktree, tmux, CLI, brief — each step can be picked up again
 * working       the delegate is at it
 * needs_attention  idle too long without delivering, its CLI ended, it said
 *               it is blocked, or a start-up screen needs a person
 * reviewing     delivered; the delegating LLM reviews it first (parentReview):
 *               it passes it on to the user or sends it back
 * delivered     waiting for the user to accept or reject it (also once the
 *               LLM passed it; `stateReason` says why it skipped or ended
 *               the LLM's review)
 * accepted, rejected, stopped  over (`stateReason` says why it stopped)
 */
export type DelegationStatus =
  | 'proposed' | 'starting' | 'working' | 'needs_attention'
  | 'reviewing' | 'delivered'
  | 'accepted' | 'rejected' | 'stopped';

export const DELEGATION_STATUSES: readonly DelegationStatus[] = [
  'proposed', 'starting', 'working', 'needs_attention', 'reviewing', 'delivered', 'accepted', 'rejected', 'stopped',
];
export const DELEGATION_TERMINAL_STATUSES: readonly DelegationStatus[] = ['accepted', 'rejected', 'stopped'];

/**
 * Why a delegation needs attention, or stopped:
 * - needs_attention: 'idle', 'cli_exited', 'blocked', 'workspace_trust',
 *   'startup_prompt', 'brief_not_delivered';
 * - stopped: 'user', 'parent' (the delegating LLM's `hestia delegate stop`),
 *   'declined', 'expired' (a proposal), 'launch_failed', 'child_gone';
 * - delivered: null (no LLM review), 'passed' (the delegating LLM passed
 *   it), 'review_rounds' (the LLM's send-backs used up), 'parent_gone' (the
 *   delegating session is gone), 'parent_switched' (it moved on to another
 *   conversation, not by a continuity handoff).
 * A client shows its own text for the ones it knows and the raw value otherwise.
 */
export type DelegationStateReason = string;

export type DelegationInitiator = 'user' | 'llm' | 'organizer';
export type DelegationIsolation = SpawnIsolation;

export type DelegationReportKind = 'understanding' | 'delivery' | 'blocked' | 'review' | 'decision';

export type DelegationReport = {
  kind: DelegationReportKind;
  by: 'child' | 'parent' | 'user' | 'system';
  at: string;
  // Markdown.
  text: string;
  verdict?: 'pass' | 'send_back' | 'accept' | 'reject';
};

// A delegation's workspace (contract/workspace.ts), and its delegate's HEAD
// when it delivered.
export type DelegationWorkspace = SpawnWorkspace & {
  headAtDelivery: string | null;
};

/**
 * Where a delegation in 'starting' is (and, in 'needs_attention' reached
 * from there, where it will pick up): contract/workspace.ts.
 */
export type DelegationStartup = SpawnStartup;

/**
 * What a delegation has to tell the delegating conversation (ADR 0015 決策 6):
 * it was delivered (for the user, or for it to review first), its delegate
 * is blocked, the user accepted or rejected it, or declined the proposal
 * (or it expired).
 */
export type DelegationParentEvent = 'delivered' | 'review' | 'blocked' | 'accepted' | 'rejected' | 'declined' | 'expired';

/** What the delegate is told: its delivery was sent back, with feedback. */
export type DelegationChildEvent = 'feedback';

/**
 * A message waiting for its recipient to be idle, kept across restarts:
 * to the delegating conversation ('parent', a DelegationParentEvent) or
 * to the delegate ('child', a send-back's feedback).
 */
export type DelegationOutboxItem = {
  to: 'parent' | 'child';
  event: DelegationParentEvent | DelegationChildEvent;
  // The delivery round a feedback item is for (the round it sends the
  // delegate back into).
  round?: number;
  // What was typed (DELEGATION_MESSAGES.parent or .feedback); '' until first sent.
  text: string;
  createdAt: string;
  // Times it was typed in.
  attempts: number;
  // When it was last typed in, while its arrival is being checked; null before.
  sentAt: string | null;
};

export type Delegation = {
  // Short; also in the branch, the worktree folder and file names.
  id: string;
  title: string;
  initiator: DelegationInitiator;
  // When the user approved an LLM's proposal; null otherwise. The user
  // approving counts as the user's own consent (trusting the new worktree).
  approvedAt: string | null;
  parentSessionId: string | null;
  parentConversationId: string | null;
  // Turns in that conversation when the brief was first written: what
  // `hestia conversation show --upstream` prints. Null before then, and for
  // one made before this was kept (all of it is printed).
  parentTurnsAtStart?: number | null;
  childSessionId: string | null;
  depth: number;
  profileId: string;
  // The profile's label when the delegation was made.
  profileLabel: string;
  // The permission mode its delegate is launched in, decided when it was
  // made. Absent on delegations made before modes: the setting at launch.
  permissionMode?: PermissionMode;
  profileHistory: { profileId: string; at: string }[];
  workspace: DelegationWorkspace;
  // The task as the delegator wrote it.
  task: string;
  // Absolute path of the brief: <delegate's cwd>/.hestia/delegations/<id>/brief.md.
  briefFile: string;
  state: DelegationStatus;
  stateReason: DelegationStateReason | null;
  // What went wrong, in words, when there is more to say than the reason.
  stateDetail: string | null;
  stateSince: string;
  startup: DelegationStartup | null;
  // When the instruction to read the brief arrived (the delegate's first turn).
  briefSentAt: string | null;
  // Delivery number (1, plus one for each send-back).
  round: number;
  // Oldest first.
  reports: DelegationReport[];
  outbox: DelegationOutboxItem[];
  // The target account's remaining quota at start; null when unknown.
  quotaAtStart: number | null;
  createdAt: string;
  updatedAt: string;
  // When the delegate's CLI was last seen at work (a turn starting or ending).
  lastActivityAt: string | null;
  // When the user was told the delegating conversation is held up by its
  // usage limit while this waits on its review (once per review).
  parentHeldNoticeAt?: string | null;
  endedAt: string | null;
};

/** What an LLM may do on its own, and how a delegation is set up: global, and per tmux in either direction. */
export type DelegationPreferences = {
  targets: string[];
  llmInitiated: 'allow' | 'ask' | 'off';
  isolation: DelegationIsolation;
  parentReview: boolean;
  notify: 'key' | 'all';
  idleAttentionMinutes: number;
};

/** Safety limits: global, a tmux may only make them stricter. */
export type DelegationLimits = {
  maxConcurrent: number;
  maxDepth: number;
  maxReviewRounds: number;
  minRemainingPercent: number;
};

export const DELEGATION_LIMIT_KEYS: readonly (keyof DelegationLimits)[] = ['maxConcurrent', 'maxDepth', 'maxReviewRounds', 'minRemainingPercent'];

/**
 * Whether `value` is at least as strict as `global` for this limit: fewer
 * at once, less deep, fewer rounds — but a higher quota floor. A tmux may
 * only save such a value.
 */
export function isStricterLimit(key: keyof DelegationLimits, value: number, global: number): boolean {
  return key === 'minRemainingPercent' ? value >= global : value <= global;
}

export const DELEGATION_LLM_INITIATED: readonly DelegationPreferences['llmInitiated'][] = ['allow', 'ask', 'off'];
export const DELEGATION_NOTIFY: readonly DelegationPreferences['notify'][] = ['key', 'all'];

/** GET/PUT /delegation: the global settings. PUT takes either part, field by field. */
export type DelegationSettingsResponse = { preferences: DelegationPreferences; limits: DelegationLimits };
export type DelegationSettingsPatch = { preferences?: Partial<DelegationPreferences>; limits?: Partial<DelegationLimits> };

/** A tmux's own settings: any preference, and limits only stricter than the global ones. */
export type DelegationOverride = { preferences: Partial<DelegationPreferences>; limits: Partial<DelegationLimits> };

/**
 * GET/PUT /sessions/:id/delegation. `effective`: the preferences that apply
 * to this tmux (global, then its own); `limits`: the limits that apply (per
 * field the stricter of the two).
 */
export type SessionDelegationResponse = { effective: DelegationPreferences; override: DelegationOverride; limits: DelegationLimits };

/** PUT /sessions/:id/delegation: null puts a field back on the global value. */
export type SessionDelegationPatch = {
  preferences?: { [K in keyof DelegationPreferences]?: DelegationPreferences[K] | null };
  limits?: { [K in keyof DelegationLimits]?: DelegationLimits[K] | null };
};

/**
 * POST /delegations. With the user's login it is the user's (any available
 * profile; `profileId` defaults to the first target); with the local tool
 * token it is the delegating LLM's (`hestia delegate start`): the profile
 * must be one of the targets, and `isolation` may only ask for 'worktree'.
 *
 * The target account's quota low (under `minRemainingPercent`, or over its
 * limit as continuity saw it): the user's is answered 409
 * `quota_low_confirm` and starts once sent again with `confirmLowQuota:
 * true` (the delegate's own continuity carries it past the limit); an
 * LLM's is refused, `quota_too_low`, whatever it sends.
 */
export type StartDelegationRequest = {
  parentSessionId: string;
  task: string;
  profileId?: string;
  title?: string;
  isolation?: DelegationIsolation;
  confirmLowQuota?: boolean;
  // The permission mode its delegate starts in (permissions.ts): only with
  // the user's login (the tool token's is refused). Absent: the delegating
  // tmux's or the global setting for the delegate's runtime — for an LLM's
  // own delegation never yolo (auto instead, or cli_default).
  permissionMode?: PermissionMode;
};

/** POST /delegations/:id/stop with the local tool token: only from the delegating session. */
export type StopDelegationRequest = { fromSessionId?: string };

/** POST /delegations/:id/deliver */
export type DeliverDelegationRequest = { fromSessionId: string; report: string; blocked?: boolean };

/**
 * POST /delegations/:id/review. With the local tool token it is the
 * delegating LLM's review of a delegation in 'reviewing' (`hestia delegate
 * review`; `fromSessionId` must be the delegating session): 'pass' hands
 * it to the user, 'send_back' (with feedback) sends the delegate back to
 * work while its send-backs last (`maxReviewRounds`). With the user's login
 * it is the user sending one in 'reviewing' or 'delivered' back, any
 * number of times; only 'send_back'.
 */
export type ReviewDelegationRequest = { fromSessionId?: string; verdict: 'pass' | 'send_back'; feedback?: string };

/**
 * POST /delegations/:id/cleanup (the user's login only; a delegation that
 * is over, in its own worktree): closes the delegate's tmux first, as the
 * app's 關閉此 tmux does (its CLI asked to exit; refused with
 * `delegate_still_running` when it won't), so nothing is left running in a
 * folder that is gone; then removes the worktree (`git worktree remove`,
 * refused with `workspace_dirty` when it has uncommitted work), and with
 * `deleteBranch` its branch too (`git branch -d`, refused with
 * `branch_not_merged` unless merged). Every refusal is checked before
 * anything is closed or removed, except the CLI not exiting.
 */
export type CleanupDelegationRequest = { deleteBranch?: boolean };

/** POST /delegations and every action on one. */
export type DelegationResponse = { delegation: Delegation };

/**
 * GET /delegations/:id: the delegation, and `deliveryMergedInto` — the
 * branch the repo it was cut from has checked out ('HEAD' when detached),
 * once that has the commit it was delivered at (`headAtDelivery`, past its
 * base); null when it hasn't, nothing new was delivered, or that can't be
 * read. Read from git on each request, never kept.
 */
export type DelegationDetailResponse = DelegationResponse & { deliveryMergedInto: string | null };

/** GET /delegations?session=<id>&active=1: newest first. */
export type DelegationListResponse = { delegations: Delegation[] };

const PARENT_EVENT_TEXT: Record<DelegationParentEvent, TypedKey> = {
  delivered: 'typed.delegation.eventDelivered',
  review: 'typed.delegation.eventReview',
  blocked: 'typed.delegation.eventBlocked',
  accepted: 'typed.delegation.eventAccepted',
  rejected: 'typed.delegation.eventRejected',
  declined: 'typed.delegation.eventDeclined',
  expired: 'typed.delegation.eventExpired',
};

/**
 * What a delegation types into a CLI, word for word: the delegate's brief
 * instruction, and the one line telling the delegating conversation what
 * happened (the details are in a file). One line each: a newline would
 * submit early.
 */
export const DELEGATION_MESSAGES = {
  brief: (file: string) => typedText('typed.delegation.brief', { file }),
  parent: (event: DelegationParentEvent, id: string, file: string) =>
    typedText('typed.delegation.parent', { id, event: typedText(PARENT_EVENT_TEXT[event]), file }),
  // To the delegate, when its delivery is sent back. `command` is the
  // backend's own hestia command (config.ts COMMAND_NAME).
  feedback: (id: string, round: number, file: string, command = 'hestia') => typedText('typed.delegation.feedback', { id, round, file, command }),
};

export type DelegationMessageKind = 'brief' | 'parent' | 'feedback';

const squeeze = (text: string) => text.replace(/\s+/g, '');
const BRIEF_HEAD = squeeze(DELEGATION_MESSAGES.brief('')).slice(0, 2);
const BRIEF_TAIL = squeeze(DELEGATION_MESSAGES.brief(''));
// The parent line's fixed opening (before the id) and closing (after the file).
const PARENT_SHAPE = DELEGATION_MESSAGES.parent('delivered', '\u0000', '\u0001');
const PARENT_SQUEEZED_HEAD = squeeze(PARENT_SHAPE.slice(0, PARENT_SHAPE.indexOf('\u0000')));
const PARENT_TAIL = squeeze(PARENT_SHAPE.slice(PARENT_SHAPE.indexOf('\u0001') + 1));
// What only a send-back says; also on lines recorded with the head cut off
// (whatever the command is called: hestia, hestia-dev).
const FEEDBACK_MARKS = ['你的交付被退回了', 'delegatedone交付'];

/**
 * Which delegation message `text` is, if it is one — so a client labels it
 * (like a handoff's) and doesn't warn about its delivery: the delegation
 * checks that itself.
 */
export function delegationMessageKind(text: string): DelegationMessageKind | null {
  const got = squeeze(text);
  if (!got) return null;
  if (got.startsWith(PARENT_SQUEEZED_HEAD) || got.endsWith(PARENT_TAIL)) {
    return FEEDBACK_MARKS.some((mark) => got.includes(mark)) ? 'feedback' : 'parent';
  }
  // 請讀<file>，先用一段話回報你的理解，然後開始。
  const briefEnd = BRIEF_TAIL.slice(BRIEF_HEAD.length);
  if (got.startsWith(BRIEF_HEAD) && got.endsWith(briefEnd) && got.includes('.hestia/delegations/')) return 'brief';
  return null;
}
