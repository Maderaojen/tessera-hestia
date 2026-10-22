import type { PermissionMode } from '../contract/permissions.js';
import { randomUUID } from 'node:crypto';
import { hasIncomingNotes, type BriefNoteCode, type ContinuityDefaults, type ContinuityHandoff, type ContinuityEventKind, type HandoffConfirm, type HandoffSource, type HandoffTrigger } from '../contract/continuity.js';
import { prompt, t, type PromptKey } from '../i18n/index.js';
import { HANDOFF_PROMPTS } from './policy.js';
import type { ContinuityPorts, SessionView } from './ports.js';
import type { SegmentHandoffRecord } from '../types.js';
import { newLaunchGuard, type LaunchGuard } from '../contract/launch-guard.js';
import { afterExit, beforeFirstMessage, confirmFirstDelivery, noticed, watchFirstTurn } from '../launch-guard/decide.js';

// One handoff, step by step:
//   writing_brief  the CLI being left writes its brief (or can't)
//   switching      same tmux, new conversation on the target profile
//   briefing       the new CLI is told to read the brief — typed only into
//                  its input box, in once its transcript shows it, and
//                  (confirm 'auto') watched through its first turn
//   reporting      it reads it and reports what it understood
//   awaiting_confirmation  the user decides
// A CLI taking over that quits before it took over fails the handoff (it
// is not done); one that quit to finish updating itself is started again
// once, same profile, same tmux (ADR 0030, launch-guard/decide.ts).
// Each call to advanceHandoff moves at most one step and only from what it
// observes now, so a restart (or a slow CLI) just picks up where it was.
//
// Whatever the CLI being left manages, the brief always ends with the app's
// own part — where things stand, how to pick up, and the whole recorded
// conversation beside it — so the CLI taking over can find its own way in.
//
// With source 'incoming' nothing is asked of the CLI being left: the app
// writes its part at once, and the CLI taking over is asked to read the
// conversation and add its own notes to the brief before it reports.

// How long a turn in progress is waited out before it is interrupted, and
// how long after an interrupt before anything is typed: the CLI needs a
// moment to settle back at its input box.
export const TURN_WAIT_MS = 10 * 60_000;
export const SETTLE_AFTER_INTERRUPT_MS = 3_000;
// How long the app's own messages wait out a prompt on screen, and the
// relaunch gets to show up, before the handoff is given up.
export const BLOCKED_GIVE_UP_MS = 10 * 60_000;
export const SWITCH_GIVE_UP_MS = 5 * 60_000;
// The CLI asked to write the brief finished its turn without writing it.
const IDLE_WITHOUT_BRIEF_MS = 90_000;
// A turn that starts within this of our message is our message's; the
// transcript has shown what arrived by then.
const OWN_SEND_SLACK_MS = 3_000;
// A request that never shows up in the CLI's record at all (a CLI past its
// limit may not take it in) is given up on this soon, not at the brief's
// full time limit.
export const MISSING_GIVE_UP_MS = 30_000;

// Why the app wrote the brief itself: a code the app words in its own
// language, and the words that go into the brief and the handoff's record
// (i18n/prompts, Chinese: the LLM taking over reads them).
type BriefNote = { code: BriefNoteCode; text: string };
const BRIEF_NOTES: Record<BriefNoteCode, PromptKey> = {
  limit_hit: 'handoff.note.limitHit',
  mechanical_only: 'handoff.note.mechanicalOnly',
  user_skipped: 'handoff.note.userSkipped',
  cli_gone: 'handoff.note.cliGone',
  never_settled: 'handoff.note.neverSettled',
  send_failed: 'handoff.note.sendFailed',
  waiting_elsewhere: 'handoff.note.waitingElsewhere',
  cut_short: 'handoff.note.cutShort',
  never_arrived: 'handoff.note.neverArrived',
  limit_while_writing: 'handoff.note.limitWhileWriting',
  timed_out: 'handoff.note.timedOut',
  no_brief_written: 'handoff.note.noBriefWritten',
};
const briefNote = (code: BriefNoteCode, values?: Record<string, unknown>): BriefNote => ({ code, text: prompt(BRIEF_NOTES[code], values) });

export type HandoffContext = {
  ports: ContinuityPorts;
  policy: ContinuityDefaults;
  now: Date;
  // A handoff's events carry its id.
  record(kind: ContinuityEventKind, detail: string | null, handoffId?: string): void;
  notify(body: string): void;
};

export type HandoffOutcome =
  | { kind: 'continue'; handoff: ContinuityHandoff }
  | { kind: 'done' }
  // `tail`: the pane's last lines, when they say something. `bare`: the
  // CLI taking over never took over and the tmux has no CLI now, so
  // another profile can be started in it.
  | { kind: 'failed'; reason: string; tail?: string | null; bare?: boolean };

export async function beginHandoff(
  ctx: HandoffContext,
  sessionId: string,
  input: {
    trigger: HandoffTrigger; view: SessionView & { conversationId: string }; toProfileId: string; toLabel: string; interrupt?: boolean;
    // This handoff's own choices; absent: the policy's.
    source?: HandoffSource; confirm?: HandoffConfirm;
    // The user's own choice for the CLI taking over; absent: the setting then.
    permissionMode?: PermissionMode;
  },
): Promise<ContinuityHandoff> {
  const id = randomUUID();
  const brief = await ctx.ports.prepareBrief(sessionId, id);
  const now = ctx.now.toISOString();
  ctx.record('handoff_started', `${input.trigger} → ${input.toLabel}`, id);
  const handoff: ContinuityHandoff = {
    id,
    trigger: input.trigger,
    fromConversationId: input.view.conversationId,
    toConversationId: null,
    fromProfileId: input.view.profileId,
    toProfileId: input.toProfileId,
    toLabel: input.toLabel,
    source: input.source ?? ctx.policy.handoffSource,
    confirm: input.confirm ?? ctx.policy.handoffConfirm,
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    stage: 'writing_brief',
    briefFile: brief.file,
    briefPath: brief.absolute,
    briefSource: null,
    briefNote: null,
    briefNoteCode: null,
    interrupt: input.trigger === 'hard' || !!input.interrupt,
    interruptedAt: null,
    startedAt: now,
    stageSince: now,
    sentAt: null,
    resent: 0,
  };
  // The CLI taking over adds its own notes: nothing is asked of this one.
  if (handoff.source === 'incoming') return assembleBrief(ctx, sessionId, handoff, null, null, { incoming: true });
  // A limit hit leaves the CLI unable to answer; it can't write a brief.
  if (input.trigger === 'limit_hit') return assembleBrief(ctx, sessionId, handoff, null, briefNote('limit_hit'));
  if (handoff.source === 'mechanical') return assembleBrief(ctx, sessionId, handoff, null, briefNote('mechanical_only'));
  return handoff;
}

/** This handoff's own choices; one saved before it had them follows the policy. */
export function handoffSourceOf(ctx: Pick<HandoffContext, 'policy'>, handoff: ContinuityHandoff): HandoffSource {
  return handoff.source ?? ctx.policy.handoffSource;
}
export function handoffConfirmOf(ctx: Pick<HandoffContext, 'policy'>, handoff: ContinuityHandoff): HandoffConfirm {
  return handoff.confirm ?? ctx.policy.handoffConfirm;
}

function enter(ctx: HandoffContext, handoff: ContinuityHandoff, stage: ContinuityHandoff['stage']): ContinuityHandoff {
  return { ...handoff, stage, stageSince: ctx.now.toISOString(), sentAt: null, resent: 0 };
}

function since(ctx: HandoffContext, iso: string | null): number {
  return iso ? ctx.now.getTime() - Date.parse(iso) : 0;
}

/** The brief as handed over: what the CLI being left wrote (if anything), then the app's own part. */
async function assembleBrief(
  ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, selfText: string | null, note: BriefNote | null,
  options: { incoming?: boolean } = {},
): Promise<ContinuityHandoff> {
  const written = selfText?.trim() ? selfText.trim() : null;
  const briefSource = written ? 'self' : options.incoming ? 'incoming' : 'mechanical';
  const mechanical = briefSource === 'mechanical' && note !== null;
  const withNote: ContinuityHandoff = { ...handoff, briefSource, briefNote: mechanical ? note.text : null, briefNoteCode: mechanical ? note.code : null };
  const own = await ctx.ports.mechanicalBrief(sessionId, withNote);
  // Not having it never holds the handoff up.
  const addendum = await ctx.ports.briefAddendum(sessionId).catch(() => null);
  await ctx.ports.writeBrief(sessionId, handoff.briefFile, [written, own, addendum].filter((part): part is string => !!part).join('\n\n---\n\n'));
  ctx.record('handoff_brief', briefSource === 'mechanical' ? `mechanical${note ? `：${note.text}` : ''}` : briefSource, handoff.id);
  return enter(ctx, withNote, 'switching');
}

export async function advanceHandoff(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff): Promise<HandoffOutcome> {
  const outcome = await step(ctx, sessionId, handoff);
  // Once the new conversation is known, the handoff is written onto it
  // (session-timeline §4.2); a write that didn't work is tried again.
  if (outcome.kind === 'continue') return { kind: 'continue', handoff: await markSegment(ctx, sessionId, outcome.handoff) };
  if (outcome.kind === 'done') await markSegment(ctx, sessionId, handoff);
  return outcome;
}

/** What is written on the conversation a handoff started. */
export function segmentRecord(ctx: Pick<HandoffContext, 'policy'>, handoff: ContinuityHandoff): SegmentHandoffRecord {
  return {
    handoffId: handoff.id,
    trigger: handoff.trigger,
    fromConversationId: handoff.fromConversationId,
    briefSource: handoff.briefSource,
    source: handoffSourceOf(ctx, handoff),
    briefNote: handoff.briefNote,
    briefNoteCode: handoff.briefNoteCode ?? null,
    confirm: handoffConfirmOf(ctx, handoff),
    briefAmended: handoff.briefAmended ?? null,
    briefFile: handoff.briefFile,
  };
}

async function markSegment(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff): Promise<ContinuityHandoff> {
  if (handoff.segmentMarked || !handoff.toConversationId) return handoff;
  const marked = await ctx.ports.markHandoffSegment(sessionId, handoff.toConversationId, segmentRecord(ctx, handoff)).catch(() => false);
  return marked ? { ...handoff, segmentMarked: true } : handoff;
}

async function step(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff): Promise<HandoffOutcome> {
  const view = await ctx.ports.readSession(sessionId);
  if (!view) return { kind: 'failed', reason: t('continuity.handoff.sessionGone') };
  switch (handoff.stage) {
    case 'writing_brief':
      return writingBrief(ctx, sessionId, handoff, view);
    case 'switching':
      return switching(ctx, sessionId, handoff, view);
    case 'briefing':
      return briefing(ctx, sessionId, handoff, view);
    case 'reporting':
      return reporting(ctx, sessionId, handoff, view);
    case 'awaiting_confirmation':
      return awaitingConfirmation(ctx, handoff, view);
  }
}

/**
 * The CLI being left is at its input box, ready for a message: idle, and,
 * after an interrupt, settled. A turn in progress is interrupted when the
 * handoff says so, or once it has been waited on long enough.
 */
async function readyForMessage(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, view: SessionView): Promise<
  { ready: true } | { ready: false; handoff: ContinuityHandoff }
> {
  if (view.phase === 'replying' && (handoff.interrupt || since(ctx, handoff.stageSince) > TURN_WAIT_MS) && !handoff.interruptedAt) {
    await ctx.ports.interrupt(sessionId);
    return { ready: false, handoff: { ...handoff, interrupt: true, interruptedAt: ctx.now.toISOString() } };
  }
  if (view.phase !== 'idle') return { ready: false, handoff };
  if (handoff.interruptedAt && since(ctx, handoff.interruptedAt) < SETTLE_AFTER_INTERRUPT_MS) return { ready: false, handoff };
  return { ready: true };
}

async function writingBrief(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, view: SessionView): Promise<HandoffOutcome> {
  const fallBack = async (note: BriefNote) => ({ kind: 'continue' as const, handoff: await assembleBrief(ctx, sessionId, handoff, null, note) });
  if (handoff.skipBrief) return fallBack(briefNote('user_skipped'));
  if (view.conversationId !== handoff.fromConversationId || !view.running) return fallBack(briefNote('cli_gone'));
  if (!handoff.sentAt) {
    const ready = await readyForMessage(ctx, sessionId, handoff, view);
    if (!ready.ready) {
      // An interrupt that never brings the CLI back to its input box.
      if (handoff.interruptedAt && since(ctx, handoff.interruptedAt) > BLOCKED_GIVE_UP_MS) return fallBack(briefNote('never_settled'));
      return { kind: 'continue', handoff: ready.handoff };
    }
    const outcome = await ctx.ports.send(sessionId, HANDOFF_PROMPTS.writeBrief(handoff.briefPath));
    if (outcome.status === 'sent') return { kind: 'continue', handoff: { ...handoff, sentAt: ctx.now.toISOString() } };
    if (outcome.status === 'failed') return fallBack(briefNote('send_failed', { reason: outcome.reason }));
    return since(ctx, handoff.stageSince) > BLOCKED_GIVE_UP_MS ? fallBack(briefNote('waiting_elsewhere')) : { kind: 'continue', handoff };
  }
  const elapsed = since(ctx, handoff.sentAt);
  if (elapsed < OWN_SEND_SLACK_MS) return { kind: 'continue', handoff };
  // A request that arrived cut short can't be trusted to be followed (it
  // may write somewhere else entirely); the CLI's turn is left alone.
  const delivered = await ctx.ports.checkDelivered(sessionId, HANDOFF_PROMPTS.writeBrief(handoff.briefPath), handoff.sentAt);
  if (delivered === 'partial') return fallBack(briefNote('cut_short'));
  if (delivered === 'missing' && elapsed > MISSING_GIVE_UP_MS) return fallBack(briefNote('never_arrived'));
  // Ran out while writing it.
  const hit = await ctx.ports.readLimitHit(sessionId);
  if (hit && Date.parse(hit.hit.at) > Date.parse(handoff.sentAt)) return fallBack(briefNote('limit_while_writing'));
  if (elapsed > ctx.policy.selfBriefTimeoutSeconds * 1000) {
    const late = await ctx.ports.findBrief(sessionId, handoff.briefFile);
    return late?.trim()
      ? { kind: 'continue', handoff: await assembleBrief(ctx, sessionId, handoff, late, null) }
      : fallBack(briefNote('timed_out'));
  }
  if (view.phase !== 'idle') return { kind: 'continue', handoff };
  const text = await ctx.ports.findBrief(sessionId, handoff.briefFile);
  if (text?.trim()) return { kind: 'continue', handoff: await assembleBrief(ctx, sessionId, handoff, text, null) };
  return elapsed > IDLE_WITHOUT_BRIEF_MS ? fallBack(briefNote('no_brief_written')) : { kind: 'continue', handoff };
}

async function switching(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, view: SessionView): Promise<HandoffOutcome> {
  if (!handoff.sentAt) {
    if (handoff.relaunch) return relaunching(ctx, sessionId, handoff, view);
    if (view.conversationId !== handoff.fromConversationId) return { kind: 'failed', reason: t('continuity.handoff.conversationChanged') };
    // The relaunch interrupts a reply itself where the CLI has a verified
    // interrupt; one that can't be is retried until the turn ends.
    const result = await ctx.ports.switchProfile(sessionId, handoff.toProfileId, {
      expectedConversationId: handoff.fromConversationId, ...(handoff.permissionMode ? { permissionMode: handoff.permissionMode } : {}),
    });
    if (result.ok) return { kind: 'continue', handoff: { ...handoff, sentAt: ctx.now.toISOString(), switchBlocked: null } };
    if (view.phase !== 'idle' && since(ctx, handoff.stageSince) <= BLOCKED_GIVE_UP_MS) {
      // Said once, as it starts, rather than only when it is given up on.
      if (handoff.switchBlocked?.reason === result.reason) return { kind: 'continue', handoff };
      ctx.record('handoff_waiting', result.reason, handoff.id);
      ctx.notify(t('continuity.push.switchWaitsForTurn', { label: handoff.toLabel, reason: result.reason }));
      return { kind: 'continue', handoff: { ...handoff, switchBlocked: { reason: result.reason, since: ctx.now.toISOString() } } };
    }
    return { kind: 'failed', reason: handoff.switchBlocked ? t('continuity.handoff.turnNeverEnded', { reason: result.reason }) : result.reason };
  }
  const arrived = view.conversationId !== null && view.conversationId !== handoff.fromConversationId && view.running && !view.switching;
  if (arrived) {
    ctx.record('handoff_switched', handoff.toLabel, handoff.id);
    // A fresh look at the new CLI's screen; how often it was started again stays.
    const guard: LaunchGuard = { ...newLaunchGuard(), relaunches: handoff.guard?.relaunches ?? 0 };
    return { kind: 'continue', handoff: { ...enter(ctx, handoff, 'briefing'), toConversationId: view.conversationId, deliveredAt: null, guard } };
  }
  // The relaunch was rolled back, or never showed up.
  if (!view.switching && view.conversationId === handoff.fromConversationId && since(ctx, handoff.sentAt) > OWN_SEND_SLACK_MS * 10) {
    return { kind: 'failed', reason: t('continuity.handoff.switchFailed') };
  }
  if (handoff.relaunch && !view.switching && !view.running && view.conversationId === null && since(ctx, handoff.sentAt) > OWN_SEND_SLACK_MS * 10) {
    return { kind: 'failed', reason: t('continuity.handoff.relaunchFailed'), bare: true };
  }
  if (since(ctx, handoff.sentAt) > SWITCH_GIVE_UP_MS) return { kind: 'failed', reason: t('continuity.handoff.neverStarted'), bare: !view.running && !view.switching };
  return { kind: 'continue', handoff };
}

// The CLI taking over quit (ADR 0030): its profile is started in the same
// tmux, with no CLI to end first.
async function relaunching(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, view: SessionView): Promise<HandoffOutcome> {
  if (view.switching) return { kind: 'continue', handoff };
  if (view.running) return { kind: 'failed', reason: t('continuity.handoff.otherCliRunning') };
  const result = await ctx.ports.launchProfile(sessionId, handoff.toProfileId, handoff.permissionMode ? { permissionMode: handoff.permissionMode } : {});
  if (!result.ok) return { kind: 'failed', reason: result.reason, bare: true };
  return { kind: 'continue', handoff: { ...handoff, sentAt: ctx.now.toISOString(), switchBlocked: null } };
}

function briefingPrompt(ctx: HandoffContext, handoff: ContinuityHandoff): string {
  const ask = handoffConfirmOf(ctx, handoff) === 'ask';
  if (handoffSourceOf(ctx, handoff) === 'incoming') return (ask ? HANDOFF_PROMPTS.briefIncomingAsk : HANDOFF_PROMPTS.briefIncomingAuto)(handoff.briefPath);
  return (ask ? HANDOFF_PROMPTS.briefAsk : HANDOFF_PROMPTS.briefAuto)(handoff.briefPath);
}

function withTail(text: string, tail: string | null | undefined): string {
  return tail ? t('format.text.withTail', { text, tail }) : text;
}

async function briefing(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, view: SessionView): Promise<HandoffOutcome> {
  // Quit before it took over: before the brief went in, or during its first turn.
  if (!view.running && !view.switching) return exited(ctx, sessionId, handoff);
  const stuck = (current: ContinuityHandoff) => (since(ctx, handoff.stageSince) > BLOCKED_GIVE_UP_MS
    ? { kind: 'failed' as const, reason: t('continuity.handoff.notReadyForBrief', { path: handoff.briefPath }), tail: current.guard?.tail ?? null }
    : { kind: 'continue' as const, handoff: current });
  if (handoff.deliveredAt) {
    // In: watched through its first turn ('auto'; 'ask' reports instead).
    const watched = watchFirstTurn({ running: view.running, switching: view.switching, phase: view.phase, deliveredAt: handoff.deliveredAt, now: ctx.now });
    if (watched !== 'over') return { kind: 'continue', handoff };
    ctx.notify(t('continuity.push.tookOver', { label: handoff.toLabel }));
    return { kind: 'done' };
  }
  if (handoff.sentAt) {
    // Sent: in only once its transcript shows it, whole.
    if (since(ctx, handoff.sentAt) < OWN_SEND_SLACK_MS) return { kind: 'continue', handoff };
    const delivered = await ctx.ports.checkDelivered(sessionId, briefingPrompt(ctx, handoff), handoff.sentAt);
    const verdict = confirmFirstDelivery({ delivered, sentAt: handoff.sentAt, now: ctx.now, resent: handoff.resent });
    if (verdict === 'wait') return { kind: 'continue', handoff };
    // Sent again once the CLI is back at its input box.
    if (verdict === 'resend') return { kind: 'continue', handoff: { ...handoff, sentAt: null, resent: handoff.resent + 1 } };
    if (verdict === 'failed') {
      return {
        kind: 'failed',
        reason: delivered === 'partial'
          ? t('continuity.handoff.briefCutTwice', { path: handoff.briefPath })
          : t('continuity.handoff.briefNeverArrived', { path: handoff.briefPath }),
      };
    }
    if (handoffConfirmOf(ctx, handoff) !== 'ask') return { kind: 'continue', handoff: { ...handoff, deliveredAt: ctx.now.toISOString() } };
    return { kind: 'continue', handoff: { ...enter(ctx, handoff, 'reporting'), sentAt: handoff.sentAt, deliveredAt: ctx.now.toISOString() } };
  }
  if (!view.running || view.phase !== 'idle') return stuck(handoff);
  // Typed only into the CLI's own input box (ADR 0030).
  const { decision, guard } = beforeFirstMessage(await ctx.ports.readScreen(sessionId), handoff.guard ?? newLaunchGuard(), ctx.now);
  const current = { ...handoff, guard };
  if (decision.do === 'skip_update') {
    const answer = await ctx.ports.skipUpdate(sessionId);
    if (answer === 'answered') return { kind: 'continue', handoff: current };
    const tail = (await ctx.ports.readScreen(sessionId))?.tail ?? null;
    ctx.record('handoff_waiting', withTail(t('continuity.handoff.updatePromptUnsure'), tail), handoff.id);
    ctx.notify(withTail(t('continuity.push.updatePromptUnsure', { label: handoff.toLabel }), tail));
    return { kind: 'continue', handoff: { ...current, guard: noticed(guard, tail, ctx.now) } };
  }
  if (decision.do === 'notice') {
    const update = decision.about === 'update_prompt';
    ctx.record('handoff_waiting', withTail(t(update ? 'continuity.handoff.updateSkippedStill' : 'continuity.handoff.unknownScreen'), decision.tail), handoff.id);
    ctx.notify(withTail(t(update ? 'continuity.push.updateSkippedStill' : 'continuity.push.unknownScreen', { label: handoff.toLabel }), decision.tail));
    return { kind: 'continue', handoff: current };
  }
  if (decision.do === 'wait') return stuck(current);
  const outcome = await ctx.ports.send(sessionId, briefingPrompt(ctx, handoff));
  if (outcome.status === 'failed') return { kind: 'failed', reason: outcome.reason };
  if (outcome.status === 'blocked') return stuck(current);
  return { kind: 'continue', handoff: { ...current, sentAt: ctx.now.toISOString() } };
}

// The CLI taking over quit before it took over. One that quit to finish
// updating itself is started again once (same profile, same tmux) and
// given the brief again; otherwise the handoff failed, with what its
// screen ended on — never done.
async function exited(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff): Promise<HandoffOutcome> {
  const guard = handoff.guard ?? newLaunchGuard();
  const after = afterExit(await ctx.ports.readScreen(sessionId), guard);
  if (!after.relaunch) {
    const reason = t(handoff.deliveredAt ? 'continuity.handoff.exitedInFirstTurn' : 'continuity.handoff.exitedBeforeTakeover');
    return { kind: 'failed', reason, tail: after.tail, bare: true };
  }
  ctx.record('handoff_relaunched', t('continuity.handoff.relaunchedAfterUpdate', { label: handoff.toLabel }), handoff.id);
  ctx.notify(t('continuity.push.relaunchedAfterUpdate', { label: handoff.toLabel }));
  return {
    kind: 'continue',
    handoff: {
      ...enter(ctx, handoff, 'switching'), relaunch: true, toConversationId: null, deliveredAt: null, segmentMarked: false,
      guard: { ...newLaunchGuard(), relaunches: guard.relaunches + 1, tail: after.tail },
    },
  };
}

// The new CLI reads the brief and reports back; the go-ahead is offered
// once that turn is over, not while it is still reading.
async function reporting(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff, view: SessionView): Promise<HandoffOutcome> {
  // Quit before its report: it never took over (ADR 0030).
  if (!view.running && !view.switching) return exited(ctx, sessionId, handoff);
  if (!view.running || view.conversationId !== handoff.toConversationId) return { kind: 'done' };
  if (view.phase === 'idle' && since(ctx, handoff.sentAt) > OWN_SEND_SLACK_MS) {
    const briefAmended = handoffSourceOf(ctx, handoff) === 'incoming' ? await amended(ctx, sessionId, handoff) : handoff.briefAmended ?? null;
    ctx.notify(t('continuity.push.reported', { label: handoff.toLabel }));
    // Written on the conversation again, now with briefAmended.
    const segmentMarked = briefAmended === (handoff.briefAmended ?? null) ? handoff.segmentMarked : false;
    return { kind: 'continue', handoff: { ...enter(ctx, handoff, 'awaiting_confirmation'), sentAt: handoff.sentAt, briefAmended, segmentMarked } };
  }
  return { kind: 'continue', handoff };
}

// Whether the CLI taking over added its notes: the brief changed after it
// was told to read it, and has the heading it was asked to write under.
async function amended(ctx: HandoffContext, sessionId: string, handoff: ContinuityHandoff): Promise<boolean> {
  const brief = await ctx.ports.readBriefMeta(sessionId, handoff.briefFile).catch(() => null);
  if (!brief || !handoff.sentAt) return false;
  return Date.parse(brief.modifiedAt) > Date.parse(handoff.sentAt) && hasIncomingNotes(brief.text);
}

function awaitingConfirmation(ctx: HandoffContext, handoff: ContinuityHandoff, view: SessionView): HandoffOutcome {
  // The user answered it in the chat themselves, or moved on.
  if (!view.running || view.conversationId !== handoff.toConversationId) return { kind: 'done' };
  if (view.lastSentAt && Date.parse(view.lastSentAt) > Date.parse(handoff.stageSince)) return { kind: 'done' };
  return { kind: 'continue', handoff };
}

/** The user's go-ahead (POST …/handoff/confirm). */
export async function confirmHandoff(ctx: HandoffContext, sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const view = await ctx.ports.readSession(sessionId);
  if (view?.phase !== 'idle') return { ok: false, reason: t('continuity.handoff.stillReplying') };
  const outcome = await ctx.ports.send(sessionId, HANDOFF_PROMPTS.confirm);
  return outcome.status === 'sent' ? { ok: true } : { ok: false, reason: outcome.reason };
}

/** The user's "interrupt now" while the handoff waits for the turn to end. */
export function interruptNow(handoff: ContinuityHandoff): ContinuityHandoff {
  return { ...handoff, interrupt: true };
}
