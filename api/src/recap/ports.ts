import type { LaunchOption } from '../contract/meta.js';
import type { ConversationRecapEvent, ConversationRecapModelCatalog, RecapErrorCode, RecapStatus } from '../contract/recap.js';
import type { RuntimeId } from '../contract/runtimes.js';
import type { Turn } from '../contract/sessions.js';
import type { RecapOutput } from './schema.js';
import type { ConversationRecapFile, RecapBatchResult, RecapBatchWrite, RecapOwner } from './store.js';

// Everything recap/ reads from or does to the rest of the app. The real
// implementations are in wiring.ts; tests pass their own.

/** One conversation of a session, as the scheduler sees it. */
export type RecapConversation = RecapOwner & {
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  turns: Turn[];
  // The session's active conversation, with a reply being written.
  replying: boolean;
  // While replying: whether the turn being answered is among `turns` yet.
  // It's imported once its transcript settles, not as soon as it's sent,
  // so until then the last turn is a finished one. Absent: it is there.
  replyingTurnStored?: boolean;
  // Its session is in the trash.
  trashed: boolean;
};

export type RecapRunRequest = { profileId: string; model: string; effort: string | null; prompt: string };

export type RecapRunResult =
  | { ok: true; output: RecapOutput }
  // `until`: for account_limited, when the limit resets, if the CLI said.
  | { ok: false; code: RecapErrorCode; until?: string | null; params?: Record<string, string> };

export type RecapAccountState =
  | { available: false }
  // `limited`: the account is over its usage limit (`until` it resets, when known).
  | { available: true; label: string; runtimeId: RuntimeId; limited: null | { until: string | null } };

export type RecapPorts = {
  // Every conversation of every session, trashed ones included.
  listConversations(): Promise<RecapConversation[]>;
  // A live session's conversations; null when there is no such session (or it is in the trash).
  listSessionConversations(sessionId: string): Promise<RecapConversation[] | null>;
  getConversation(sessionId: string, conversationId: string): Promise<RecapConversation | null>;

  readRecap(owner: RecapOwner): Promise<ConversationRecapFile | null>;
  applyBatch(owner: RecapOwner, write: RecapBatchWrite): Promise<RecapBatchResult>;
  // Changes the recap (an empty one if there is none) in its file's queue.
  updateRecap(owner: RecapOwner, mutate: (recap: ConversationRecapFile, existed: boolean) => ConversationRecapFile | null): Promise<ConversationRecapFile | null>;
  setItemStatus(owner: RecapOwner, itemId: string, status: RecapStatus, now: string): Promise<ConversationRecapFile | null>;

  // One CLI run on the account (runner.ts).
  runBatch(request: RecapRunRequest): Promise<RecapRunResult>;
  // The launch profiles a recap can run on (Codex and Claude Code), and an
  // account's models (throws when the CLI can't list them).
  listProfiles(): Promise<LaunchOption[]>;
  listModels(profileId: string, refresh: boolean): Promise<ConversationRecapModelCatalog>;
  // Whether the account is still a launch option, and over its limit:
  // from what continuity saw of it and the account-status snapshot.
  accountState(profileId: string): Promise<RecapAccountState>;

  now(): Date;
  publish(event: ConversationRecapEvent): void;
};

