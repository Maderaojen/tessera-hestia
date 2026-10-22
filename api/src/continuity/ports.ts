import type { PermissionMode } from '../contract/permissions.js';
import type { ContinuityHandoff, LimitHit } from '../contract/continuity.js';
import type { ScreenReading } from '../launch-guard/decide.js';
import type { SegmentHandoffRecord } from '../types.js';

// Everything continuity/ reads from or does to the rest of the app. The
// real implementations are in wiring.ts; tests pass their own.

export type SessionView = {
  conversationId: string | null;
  // The CLI is up (not launching, not ended).
  running: boolean;
  phase: 'idle' | 'replying' | 'awaiting_approval' | null;
  // A /clear, switch or handoff relaunch is in progress.
  switching: boolean;
  // The active conversation's launch profile and the account holding its
  // quota (null: none, or no quota source for it).
  profileId: string | null;
  accountId: string | null;
  // When the last turn's reply was recorded, and when the app last sent a
  // message (from the app or found typed into the terminal).
  lastTurnAt: string | null;
  lastSentAt: string | null;
};

export type SendOutcome =
  | { status: 'sent' }
  // The CLI is waiting on a prompt; try again later.
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string };

export type ProfileInfo = { id: string; label: string; accountId: string | null };

export type QuotaReading = {
  // The lower of the 5-hour and 7-day remaining percent; null when neither is known.
  remainingPercent: number | null;
};

export type ContinuityPorts = {
  listSessionIds(): Promise<string[]>;
  readSession(sessionId: string): Promise<SessionView | null>;
  // The hit the session's active conversation ends on, if any.
  readLimitHit(sessionId: string): Promise<{ conversationId: string; hit: LimitHit } | null>;
  send(sessionId: string, text: string): Promise<SendOutcome>;
  notify(sessionId: string, body: string): Promise<void>;
  now(): Date;

  // Quota, from the account-status snapshot; refreshQuota asks for a newer
  // one (rate limited by account-status itself).
  readQuota(accountId: string): Promise<QuotaReading | null>;
  refreshQuota(): void;
  listProfiles(): Promise<ProfileInfo[]>;

  // Stops the reply in progress, as the stop button does.
  interrupt(sessionId: string): Promise<void>;
  // Exit the running CLI and start `profileId` in the same tmux, as a new conversation.
  // `expectedConversationId`: the source must still own the CLI at the atomic claim.
  // `force`: the user chose not to wait for a reply that can't be
  // interrupted safely; the CLI is ended by resetting its pane.
  switchProfile(sessionId: string, profileId: string, options?: { force?: boolean; expectedConversationId?: string; permissionMode?: PermissionMode }): Promise<{ ok: true } | { ok: false; reason: string }>;

  // The brief's file, relative to the session's cwd, and its absolute path
  // (what the CLIs are told). Only its folder is made: a CLI's write tool
  // may refuse to overwrite a file it never read.
  prepareBrief(sessionId: string, handoffId: string): Promise<{ file: string; absolute: string }>;
  // What the CLI wrote as the brief. A brief written under the right name
  // but elsewhere in the working folder (a CLI that misread the path) is
  // moved into place first. null when there is none.
  findBrief(sessionId: string, file: string): Promise<string | null>;
  writeBrief(sessionId: string, file: string, content: string): Promise<void>;
  // Writes the handoff onto the conversation it started; false when that
  // didn't work (retried on the next step).
  markHandoffSegment(sessionId: string, conversationId: string, record: SegmentHandoffRecord): Promise<boolean>;
  // The brief as it is now and when it last changed (an 'incoming' handoff
  // looks for the notes the CLI taking over added); null when it is gone.
  readBriefMeta(sessionId: string, file: string): Promise<{ text: string; modifiedAt: string } | null>;
  // The app's own part of a brief: where things stand and how to pick up,
  // with the whole recorded conversation written beside it.
  mechanicalBrief(sessionId: string, handoff: ContinuityHandoff): Promise<string>;
  // What other features add to the brief for this session (a delegate's
  // instructions for delivering its work), or null; it goes at the end.
  briefAddendum(sessionId: string): Promise<string | null>;
  // Whether the CLI took `text` in whole, as its latest user message since
  // `since`: 'partial' when what arrived is cut short (a part of it),
  // 'missing' when nothing has arrived yet, 'unknown' when there is no
  // transcript to tell from.
  checkDelivered(sessionId: string, text: string, since: string): Promise<'exact' | 'partial' | 'missing' | 'unknown'>;

  // The launch guard (ADR 0030, launch-guard/screen.ts): one look at the
  // CLI's screen (null when it can't be read), and choosing "Skip" in its
  // update menu with the cursor confirmed first.
  readScreen(sessionId: string): Promise<ScreenReading | null>;
  skipUpdate(sessionId: string): Promise<'answered' | 'not_shown' | 'unsure'>;
  // Starts `profileId` in the session's tmux, which has no CLI running (the
  // one taking over quit), as a new conversation.
  launchProfile(sessionId: string, profileId: string, options?: { permissionMode?: PermissionMode }): Promise<{ ok: true } | { ok: false; reason: string }>;
  // The conversation a handoff started (the one written with its id), as
  // the registry has it; null when none is. For a handoff recorded as done
  // whose CLI never took over (engine.ts recoverLostHandoff).
  readHandoffConversation(sessionId: string, handoffId: string): Promise<HandoffConversation | null>;
};

export type HandoffConversation = {
  conversationId: string;
  // No later conversation in the session.
  latest: boolean;
  turns: number;
  endedAt: string | null;
  endReason: string | null;
  profileId: string | null;
  permissionMode: PermissionMode | null;
  record: SegmentHandoffRecord;
  // The brief's absolute path (record.briefFile is relative to the session's folder).
  briefPath: string | null;
};
