import type { LaunchGuard } from './launch-guard.js';
import type { PermissionMode } from './permissions.js';
import { typedText } from './typed.js';

// Carrying on after a CLI hits its usage limit.
// Needs the `continuity` capability (meta.ts).

/**
 * A CLI's report that it stopped on a usage limit, as its transcript adapter
 * reads it (TranscriptAdapter.readLimitHit). Every CLI has its own wording
 * and records; this is the one shape the rest of the app sees.
 */
export type LimitHit = {
  // When the CLI recorded it.
  at: string;
  // 'session': the rolling few-hour window; 'weekly': the weekly one;
  // 'model': one model's own allowance. 'unknown' when the CLI named a kind
  // nobody has verified yet — limitType keeps its own word for it.
  scope: 'session' | 'weekly' | 'model' | 'unknown';
  limitType: string | null;
  // The model whose own allowance ran out, when that is what it says.
  model: string | null;
  // ISO; null when the CLI didn't say, or it couldn't be read.
  resetsAt: string | null;
  // What the CLI showed.
  message: string;
  // Which rule read it, e.g. 'claude-code/quota-limits'.
  ruleId: string;
  // Set when the CLI said it carries on by itself at the reset (Claude Code
  // 2.1.296: "Usage limit reached · continuing automatically at 9:30pm"):
  // when, as ISO. The app then only shows it and sends nothing itself.
  cliResumesAt?: string;
};

/**
 * 'wait_resume': when the limit resets, tell the CLI to carry on.
 * 'handoff': also watch the account's remaining quota, and hand the work to
 * the next profile in `chain` when it runs low or hits the limit; with no
 * profile to hand to, wait for the reset as 'wait_resume' does.
 */
export type ContinuityMode = 'off' | 'wait_resume' | 'handoff';
export const CONTINUITY_MODES: readonly ContinuityMode[] = ['off', 'wait_resume', 'handoff'];

/**
 * Who writes the handoff brief. 'self_then_mechanical': the CLI being left
 * is asked to write it, and the app writes it from the recorded
 * conversation and git if that fails; 'mechanical': only the app;
 * 'incoming': the app writes its part at once, and the CLI taking over is
 * asked to read the conversation it takes over and add its own notes to
 * the brief before it reports (needs the `handoff_options` capability).
 * Every way, the app's own record is in the brief.
 */
export type HandoffSource = 'self_then_mechanical' | 'mechanical' | 'incoming';
export const HANDOFF_SOURCES: readonly HandoffSource[] = ['self_then_mechanical', 'mechanical', 'incoming'];

/** 'ask': the new CLI first reports what it understood and waits for the user; 'auto': it just carries on. */
export type HandoffConfirm = 'ask' | 'auto';
export const HANDOFF_CONFIRMS: readonly HandoffConfirm[] = ['ask', 'auto'];

export type ContinuityDefaults = {
  mode: ContinuityMode;
  // What is sent to carry on.
  resumePrompt: string;
  // How long after the reset time it is sent.
  resumeDelaySeconds: number;
  // At most this many automatic carry-ons per session in 24 hours.
  maxAutoResumesPerDay: number;
  // Launch profile ids to hand off to, in order (GET /launch-profiles).
  chain: string[];
  // Remaining quota (the lower of the 5-hour and 7-day windows, percent) at
  // which a handoff starts once the current turn ends…
  softRemainingPercent: number;
  // …and at which the reply in progress is interrupted for it.
  hardRemainingPercent: number;
  handoffSource: HandoffSource;
  handoffConfirm: HandoffConfirm;
  // How long the CLI being left gets to write its brief.
  selfBriefTimeoutSeconds: number;
};

/** A session's own choices; anything absent follows the defaults. */
export type ContinuityOverride = Partial<ContinuityDefaults>;

export type HandoffTrigger = 'soft' | 'hard' | 'limit_hit' | 'manual';

/**
 * writing_brief → switching → briefing → reporting → awaiting_confirmation
 * (the last two only with handoffConfirm 'ask'); the handoff is over (and
 * null) after that.
 */
/**
 * Why the app wrote the brief itself, as a code: the app shows its own words
 * for it. briefNote is the same reason in the words the brief and the
 * handoff's record use (Chinese, what the LLM taking over reads); a handoff
 * saved before the code existed has only that.
 */
export const BRIEF_NOTE_CODES = [
  'limit_hit', 'mechanical_only', 'user_skipped', 'cli_gone', 'never_settled', 'send_failed',
  'waiting_elsewhere', 'cut_short', 'never_arrived', 'limit_while_writing', 'timed_out', 'no_brief_written',
] as const;
export type BriefNoteCode = (typeof BRIEF_NOTE_CODES)[number];

export type HandoffStage = 'writing_brief' | 'switching' | 'briefing' | 'reporting' | 'awaiting_confirmation';

export type ContinuityHandoff = {
  id: string;
  trigger: HandoffTrigger;
  fromConversationId: string;
  // The new conversation, once the switch landed.
  toConversationId: string | null;
  fromProfileId: string | null;
  toProfileId: string;
  toLabel: string;
  // Who writes the brief and what the CLI taking over does once it has read
  // it, as chosen when the handoff started (the request's, or the policy's
  // then); later changes to the settings don't touch a handoff under way.
  // Absent on handoffs saved before these existed: the policy's.
  source?: HandoffSource;
  confirm?: HandoffConfirm;
  // The permission mode the user chose for the CLI taking over, when they
  // did (StartHandoffRequest). Absent: the setting that applies when it
  // starts — never the mode the conversation being left was started in.
  permissionMode?: PermissionMode;
  stage: HandoffStage;
  // The brief, inside the session's folder (.hestia/handoffs/), relative to
  // the session's cwd; and its absolute path, which is what the CLIs are told.
  briefFile: string;
  briefPath: string;
  // 'incoming': the app's part, for the CLI taking over to add to.
  briefSource: 'self' | 'mechanical' | 'incoming' | null;
  // With 'incoming', once its report is in: whether the CLI taking over
  // added its own notes to the brief. null until then.
  briefAmended?: boolean | null;
  // Why the CLI being left didn't write the brief, when it didn't: in the
  // brief's words, and as a code (absent on handoffs saved before it).
  briefNote: string | null;
  briefNoteCode?: BriefNoteCode | null;
  // Stop the reply in progress rather than wait for the turn to end. A
  // 'hard' handoff always does; one that has waited too long does too.
  interrupt: boolean;
  interruptedAt: string | null;
  // The user chose not to wait for the CLI being left: the app writes the brief.
  skipBrief?: boolean;
  startedAt: string;
  stageSince: string;
  // When the current stage's message went to a CLI; null before it has.
  sentAt: string | null;
  // Times the current stage's message was sent again after it arrived cut.
  resent: number;
  // The conversation it started has the handoff written on it (its
  // SegmentHandoff); until then that is retried each step.
  segmentMarked?: boolean;
  // The switch refused for now (the CLI being left is replying and can't
  // be interrupted safely): why, and since when. It is retried until the
  // turn ends; the user is told once.
  switchBlocked?: { reason: string; since: string } | null;
  // When the CLI taking over showed the brief's instruction in its
  // transcript, whole (ADR 0030); with confirm 'auto' it is then watched
  // through its first turn before the handoff is done.
  deliveredAt?: string | null;
  // What the launch guard saw of the CLI taking over's screen, and how
  // often it was started again.
  guard?: LaunchGuard;
  // The switch starts the profile in a tmux with no CLI (the one taking
  // over quit: started again, or the chain's next profile), rather than
  // ending a running one.
  relaunch?: boolean;
  // Profiles that already failed to take over in this handoff.
  tried?: string[];
};

/**
 * A handoff whose CLI never took over (ADR 0030): kept so the user can
 * start it again with the same brief (POST …/continuity/handoff/relaunch).
 */
export type FailedHandoff = {
  handoffId: string;
  at: string;
  reason: string;
  // The pane's last lines when it failed.
  tail: string | null;
  fromConversationId: string;
  fromProfileId: string | null;
  toProfileId: string;
  toLabel: string;
  briefFile: string;
  briefPath: string;
  briefSource: ContinuityHandoff['briefSource'];
  briefNote: string | null;
  briefNoteCode?: BriefNoteCode | null;
  source?: HandoffSource;
  confirm?: HandoffConfirm;
  permissionMode?: PermissionMode;
};

/**
 * POST /sessions/:id/continuity/handoff/relaunch: start the failed
 * handoff's profile (or `toProfileId`) in the tmux again and give it the
 * same brief. `briefFile`: the failed handoff's, as the client saw it.
 */
export type RelaunchHandoffRequest = { briefFile: string; toProfileId?: string; permissionMode?: PermissionMode };

export type ContinuityPending = {
  conversationId: string;
  hit: LimitHit;
  // When the carry-on is due.
  wakeAt: string;
  // Times it was put off because the CLI was waiting on a prompt.
  postponed: number;
  // 'cli': the CLI carries on by itself (hit.cliResumesAt); at wakeAt the
  // app only checks that it did. Absent: the app sends resumePrompt.
  by?: 'cli';
};

export type ContinuityEventKind =
  | 'detected' // a limit hit was seen while the mode is off
  | 'scheduled'
  | 'cli_will_resume' // the CLI carries on by itself; detail: when
  | 'no_reset_time'
  | 'daily_cap'
  | 'resumed'
  | 'postponed'
  | 'dropped' // the carry-on was no longer due (see detail)
  | 'send_failed'
  | 'cancelled'
  | 'no_target' // quota ran low (or out) with no other profile to hand to
  | 'handoff_started'
  | 'handoff_brief' // detail: who wrote it
  | 'handoff_waiting' // the switch waits for the turn to end; detail: why
  | 'handoff_forced' // the user ended the CLI being left rather than wait
  | 'handoff_switched'
  | 'handoff_done'
  | 'handoff_failed'
  | 'handoff_relaunched' // the CLI taking over started again, or the next profile tried; detail: why
  | 'handoff_cancelled';

// A handoff's events carry its id (capability `handoff_brief`): its brief
// can be read from the history.
export type ContinuityEvent = { at: string; kind: ContinuityEventKind; detail: string | null; handoffId?: string };

/** GET /sessions/:id/continuity/handoffs/:handoffId/brief (capability `handoff_brief`). */
export type HandoffBriefResponse = {
  // The id it was asked by: the handoff's, or its first 8 characters.
  handoffId: string;
  // Relative to the session's folder, for showing only.
  file: string;
  content: string;
  // Only the first HANDOFF_BRIEF_MAX_BYTES were read.
  truncated: boolean;
  size: number;
  modifiedAt: string;
};
export const HANDOFF_BRIEF_MAX_BYTES = 512 * 1024;

/** GET/PUT /continuity */
export type ContinuityDefaultsResponse = { defaults: ContinuityDefaults };

/** GET/PUT /sessions/:id/continuity */
export type SessionContinuityResponse = {
  effective: ContinuityDefaults;
  override: ContinuityOverride;
  pending: ContinuityPending | null;
  handoff: ContinuityHandoff | null;
  // Newest last.
  history: ContinuityEvent[];
  // Whether the CLI running now could write a brief itself (a handoff
  // asked of it would otherwise be written by the app): not when its
  // conversation ends on a usage limit not yet reset, nor with no CLI
  // running. Needs the `handoff_options` capability.
  selfBrief?: { available: boolean; reason: 'limit_hit' | 'cli_not_running' | null };
  // The last handoff whose CLI never took over, until it is started again
  // or dismissed (ADR 0030). Needs the `handoff_relaunch` capability.
  failedHandoff?: FailedHandoff | null;
};

/** The heading the CLI taking over adds its notes under ('incoming'). */
export const INCOMING_NOTES_HEADING = typedText('typed.handoff.incomingNotesHeading');
const INCOMING_NOTES_LINE = new RegExp(`^${INCOMING_NOTES_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm');

/**
 * What a handoff types into the CLIs, word for word, and how a client tells
 * those messages apart from the user's own (to label them, and not to warn
 * about their delivery: the handoff checks that itself). One line each: a
 * newline would submit early.
 */
export const HANDOFF_MESSAGES = {
  writeBrief: (file: string) => typedText('typed.handoff.writeBrief', { file }),
  briefAsk: (file: string) => typedText('typed.handoff.briefAsk', { file }),
  briefAuto: (file: string) => typedText('typed.handoff.briefAuto', { file }),
  // 'incoming': the brief holds only the app's part; the CLI taking over
  // reads the conversation it takes over and adds its own notes. Opens as
  // briefAsk does, so it is told apart the same way.
  briefIncomingAsk: (file: string) => typedText('typed.handoff.briefIncomingAsk', { file, heading: INCOMING_NOTES_HEADING }),
  briefIncomingAuto: (file: string) => typedText('typed.handoff.briefIncomingAuto', { file, heading: INCOMING_NOTES_HEADING }),
  confirm: typedText('typed.handoff.confirm'),
};

/**
 * How many times the user spoke in these turns — each turn's message and
 * the follow-ups sent mid-reply — leaving out what a handoff typed. The
 * chat's 輪 (§3.2).
 */
export function countUserMessages(turns: readonly { user: { text: string }; followUps?: readonly { text: string }[] }[]): number {
  let count = 0;
  for (const turn of turns) {
    if (!handoffMessageKind(turn.user.text)) count += 1;
    for (const followUp of turn.followUps ?? []) if (!handoffMessageKind(followUp.text)) count += 1;
  }
  return count;
}

/**
 * Whether a brief has the incoming LLM's notes: the heading on a line of
 * its own — not merely quoted (the app's part quotes the user's messages
 * and the last reply, which may mention it).
 */
export function hasIncomingNotes(brief: string): boolean {
  return INCOMING_NOTES_LINE.test(brief);
}

export type HandoffMessageKind = 'write_brief' | 'brief' | 'confirm';

const squeeze = (text: string) => text.replace(/\s+/g, '');
// Each message's fixed opening and closing (the brief's path sits in the
// middle). The opening an earlier version used is still recognized.
const WRITE_BRIEF_HEADS = [squeeze(HANDOFF_MESSAGES.writeBrief('')).slice(0, 18), '額度快用完了，接下來會交給另一個LLM接手。'];
const WRITE_BRIEF_TAIL = squeeze(HANDOFF_MESSAGES.writeBrief('')).slice(-30);
const BRIEF_HEAD = squeeze(HANDOFF_MESSAGES.briefAsk('')).slice(0, 16);

/**
 * Which handoff message `text` is, if it is one — also one that arrived
 * with its head cut off, as a CLI once recorded it.
 */
export function handoffMessageKind(text: string): HandoffMessageKind | null {
  const got = squeeze(text);
  if (!got) return null;
  if (WRITE_BRIEF_HEADS.some((head) => got.startsWith(head)) || got.endsWith(WRITE_BRIEF_TAIL)) return 'write_brief';
  if (got.startsWith(BRIEF_HEAD)) return 'brief';
  if (got === squeeze(HANDOFF_MESSAGES.confirm)) return 'confirm';
  return null;
}

/**
 * POST /sessions/:id/continuity/handoff: start one now; without a profile,
 * the chain picks. `interrupt`: stop the reply in progress instead of
 * waiting for the turn to end.
 */
export type StartHandoffRequest = {
  toProfileId?: string;
  interrupt?: boolean;
  // Who writes the brief: the CLI being left ('current', the app if it
  // can't), or the CLI taking over ('incoming'). Absent: the policy's
  // handoffSource. Needs `handoff_options`.
  briefBy?: 'current' | 'incoming';
  // Once the brief is read: report back and wait ('wait'), or carry on
  // ('continue'). Absent: the policy's handoffConfirm.
  afterReport?: 'wait' | 'continue';
  // The permission mode the CLI taking over starts in (permissions.ts);
  // only with the user's login. Absent: the tmux's or the global setting
  // for its runtime. Needs `permission_modes`.
  permissionMode?: PermissionMode;
};
