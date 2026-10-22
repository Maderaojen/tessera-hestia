import type { LaunchOption } from './meta.js';
import type { ModelCatalog } from './models.js';
import type { Provider, RuntimeId } from './runtimes.js';

// Conversation recaps: for each
// conversation of a session, a short list of what the user asked for, each
// with how far it got. Kept up to date in the background by a cheap model
// on an account the user picked; the statuses the user set are never
// overwritten. Needs the `recap` capability (meta.ts).

export const RECAP_STATUSES = ['implemented', 'accepted', 'planned', 'not_implemented', 'uncertain'] as const;
export type RecapStatus = (typeof RECAP_STATUSES)[number];

export function isRecapStatus(value: unknown): value is RecapStatus {
  return typeof value === 'string' && (RECAP_STATUSES as readonly string[]).includes(value);
}

/**
 * Why the last run for a conversation (or every run, for a pause) failed.
 * Only the code and its params are kept; a client words them itself and
 * never shows a CLI's own output.
 * - invalid_output: the model's answer didn't fit the schema or the rules;
 * - run_failed: the CLI exited with an error; run_timeout: it took too long;
 * - account_limited: the account is over its usage limit;
 * - model_rejected: the account can't use the chosen model;
 * - profile_unavailable: the chosen account is gone from the launch options;
 * - runner_unavailable: the CLI couldn't be started at all.
 */
export const RECAP_ERROR_CODES = [
  'invalid_output', 'run_failed', 'run_timeout', 'account_limited', 'model_rejected', 'profile_unavailable', 'runner_unavailable',
] as const;
export type RecapErrorCode = (typeof RECAP_ERROR_CODES)[number];

/** One thing the user asked for. */
export type ConversationRecapItem = {
  // Made by the app ('r_' and 8 characters); never reused.
  id: string;
  // One sentence, the gist only. Plain text: never rendered as markdown or HTML.
  title: string;
  status: RecapStatus;
  // 'user': the user set this status, and nothing automatic changes it.
  statusSource: 'auto' | 'user';
  // The turns it was asked over, as Turn.index, both ends included.
  turns: { from: number; to: number };
  createdAt: string;
  // When its title, status or turns last changed.
  updatedAt: string;
  // When the user set its status; null for 'auto'.
  statusChangedAt: string | null;
};

/** PUT /recap/settings takes any of these. */
export type ConversationRecapSettings = {
  // Off by default.
  enabled: boolean;
  // The launch profile (account) the recaps run on (GET /recap/profiles).
  profileId: string | null;
  model: string | null;
  // Only for a model with efforts (GET /recap/models).
  effort: string | null;
  // Also recap, at the lowest priority, the conversations that would
  // otherwise wait for "建立摘要". Off by default.
  backfillOld: boolean;
};

export type ConversationRecapPauseCode = 'profile_unavailable' | 'model_rejected' | 'account_limited';

/**
 * Every run stopped. profile_unavailable and model_rejected stay until the
 * settings pick another account or model; account_limited lifts itself at
 * `until`, or once the account is seen to have quota again.
 */
export type ConversationRecapPause = null | { code: ConversationRecapPauseCode; until: string | null; at: string };

/** GET and PUT /recap/settings. */
export type ConversationRecapSettingsResponse = ConversationRecapSettings & {
  // When the recaps were last turned on (the server's own field): a
  // conversation without a recap is only recapped on its own when it has a
  // turn from after it.
  enabledAt: string | null;
  pause: ConversationRecapPause;
  queue: { running: null | { sessionId: string; conversationId: string }; waiting: number };
};

/** GET /recap/profiles: the accounts a recap can run on (Codex and Claude Code only). */
export type ConversationRecapProfilesResponse = { profiles: LaunchOption[] };

/** GET /recap/models: GET /sessions/:id/models' answer for one account, without `current`. */
export type ConversationRecapModelCatalog = Omit<ModelCatalog, 'current'>;

export const CONVERSATION_RECAP_STATES = [
  'disabled', 'unavailable', 'empty', 'not_created', 'waiting', 'queued', 'running', 'up_to_date', 'behind', 'failed', 'paused',
] as const;
/**
 * - disabled: the recaps are off (an existing recap still shows, and its
 *   statuses can still be changed);
 * - unavailable: this conversation can't have one (no provider);
 * - empty: no finished turn yet;
 * - not_created: no recap, and none is made on its own (POST …/recap/refresh makes it);
 * - waiting: it is recapped once the conversation has been quiet a while;
 * - queued, running: in line, being recapped;
 * - up_to_date: every finished turn is in it;
 * - behind: recapped up to coveredTurns, the rest still to do (stopped part
 *   way, or waiting to retry);
 * - failed: the last run failed before anything was recapped, waiting to retry;
 * - paused: every run is stopped (`pause` says why).
 */
export type ConversationRecapState = (typeof CONVERSATION_RECAP_STATES)[number];

/** One conversation's recap, as GET /sessions/:id/recaps lists it. */
export type ConversationRecapView = {
  conversationId: string;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  provider: Provider | null;
  available: boolean;
  // Finished turns (the one being replied to doesn't count yet).
  totalTurns: number;
  // How many of them, from the first, are in the recap.
  coveredTurns: number;
  // totalTurns - coveredTurns, never below 0.
  pendingTurns: number;
  state: ConversationRecapState;
  // [] when there is no recap.
  items: ConversationRecapItem[];
  updatedAt: string | null;
  // What wrote the recap last.
  generator: { profileLabel: string; runtimeId: RuntimeId; model: string; effort: string | null } | null;
  error: null | { code: RecapErrorCode; params?: Record<string, string>; retryAt: string | null };
  pause: ConversationRecapPause;
};

/** GET /sessions/:id/recaps. */
export type SessionRecapsResponse = {
  enabled: boolean;
  // Newest conversation (highest sequence) first.
  conversations: ConversationRecapView[];
};

/**
 * Sent on GET /sessions/events and GET /sessions/:id/events, only to a
 * stream opened with `include=recap` (older clients take an event they
 * don't know for a deleted session). Carries the state, not the items: a
 * client showing the recap reads it again when `updatedAt` or `state` changes.
 */
export type ConversationRecapEvent = {
  type: 'recap';
  sessionId: string;
  conversationId: string;
  state: ConversationRecapState;
  coveredTurns: number;
  totalTurns: number;
  updatedAt: string | null;
};
