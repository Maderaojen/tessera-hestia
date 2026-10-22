import { newLaunchGuard } from '../contract/launch-guard.js';
import type { SpawnStartup } from '../contract/workspace.js';
import { afterExit, beforeFirstMessage, confirmFirstDelivery, noticed, watchFirstTurn } from '../launch-guard/decide.js';
import { t } from '../i18n/index.js';
import type { SpawnPorts } from './ports.js';

// A delegation's or a branch line's start, step by step (ADR 0015 決策 13,
// 16; ADR 0023 決策 5):
//   workspace  the worktree is made (or found), the brief written beside
//              its cwd, and its session id chosen
//   session    its tmux, registered in the starting session's project
//   launch     the profile's CLI started in it, until it is up
//   briefing   the trust prompt answered (when the user may be answered
//              for), then the one line telling the CLI to read the brief —
//              typed only into its input box, read back from its
//              transcript, and the CLI watched through its first turn
//              (ADR 0030, launch-guard/decide.ts); a CLI that quit to
//              finish updating itself is started again once
// Each call moves at most one step and acts only on what it sees now, so
// a restart (every deploy) picks up where it was: the session id is saved
// before the session is made, a CLI already bound is not launched again,
// and an instruction already sent is checked, not sent again. What the
// record makes of each outcome (a state, a report, a notice) is the
// caller's, through the hooks.

// How long the CLI gets to come up after its launch.
export const LAUNCH_GIVE_UP_MS = 3 * 60_000;
// A launch the app rolled back shows as no CLI bound; give the poller this
// long before reading it that way.
const LAUNCH_SETTLE_MS = 10_000;
// After answering the trust prompt, how long it may stay on screen.
export const TRUST_SETTLE_MS = 30_000;
// A CLI just up (or just past its trust prompt) is given this long to draw
// its input box before anything is typed into it.
export const CLI_SETTLE_MS = 5_000;
// How long the CLI may stay busy or behind a prompt before the instruction
// is given up on.
export const BRIEF_GIVE_UP_MS = 10 * 60_000;
// The transcript has shown what arrived by then (continuity's numbers).
const OWN_SEND_SLACK_MS = 3_000;
export { MISSING_GIVE_UP_MS } from '../launch-guard/decide.js';

export type SpawnContext = { ports: SpawnPorts; now: Date };

/** What is started: its start so far, its session (chosen in the workspace step), and its brief. */
export type SpawnSubject = { startup: SpawnStartup; childSessionId: string | null; briefFile: string };

export type StepOutcome = { ok: true } | { ok: false; detail: string };

/**
 * Why a start needs a person: 'cli_exited', 'workspace_trust',
 * 'startup_prompt', 'brief_not_delivered'. `final`: the stepper has given
 * up on this one (the brief went in twice and didn't arrive); anything else
 * may still clear up on its own.
 */
export type SpawnAttention = { reason: 'cli_exited' | 'workspace_trust' | 'startup_prompt' | 'brief_not_delivered'; detail: string | null; final: boolean };

export type SpawnHooks = {
  // The worktree made and the brief written; the session id chosen and
  // saved on the subject. Not ok: it couldn't be, in words.
  prepare(): Promise<StepOutcome>;
  // The tmux made (or found) for subject.childSessionId.
  ensureSession(): Promise<StepOutcome>;
  // The CLI started in it; `detail` is why not.
  launch(): Promise<StepOutcome>;
  // Whether the trust prompt may be answered on the user's behalf.
  trustAllowed(): boolean;
  // It was: written down.
  trustAnswered(): void;
  // Didn't get going (the workspace, the tmux or the CLI).
  failed(detail: string): void;
  attention(issue: SpawnAttention): void;
  // Its session is gone.
  gone(): void;
  // The brief is in, sent at `sentAt`, and the CLI got through its first turn.
  briefed(sentAt: string): void;
  // The CLI quit to finish updating itself and is started again.
  relaunching?(): void;
  // The one line typed into the CLI.
  message: string;
};

function since(ctx: SpawnContext, iso: string | null): number {
  return iso ? ctx.now.getTime() - Date.parse(iso) : 0;
}

export function newStartup(at: string): SpawnStartup {
  return { stage: 'workspace', stageSince: at, launchedAt: null, trustAnsweredAt: null, sentAt: null, resent: 0, deliveredAt: null };
}

function enter(ctx: SpawnContext, startup: SpawnStartup, stage: SpawnStartup['stage']): void {
  startup.stage = stage;
  startup.stageSince = ctx.now.toISOString();
}

export async function advanceSpawn(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  switch (subject.startup.stage) {
    case 'workspace':
      return workspace(ctx, subject, hooks);
    case 'session':
      return session(ctx, subject, hooks);
    case 'launch':
      return launch(ctx, subject, hooks);
    case 'briefing':
      return briefing(ctx, subject, hooks);
  }
}

async function workspace(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  const prepared = await hooks.prepare();
  if (!prepared.ok) {
    hooks.failed(prepared.detail);
    return;
  }
  enter(ctx, subject.startup, 'session');
}

async function session(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  const made = await hooks.ensureSession();
  if (!made.ok) {
    hooks.failed(made.detail);
    return;
  }
  enter(ctx, subject.startup, 'launch');
}

async function launch(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  const { startup } = subject;
  const child = await ctx.ports.readChild(subject.childSessionId!);
  if (!child) {
    hooks.gone();
    return;
  }
  if (!startup.launchedAt) {
    // Bound already: launched before a restart, or by hand.
    if (child.provider || child.launching) {
      startup.launchedAt = ctx.now.toISOString();
      return;
    }
    const result = await hooks.launch();
    if (!result.ok) {
      hooks.failed(result.detail);
      return;
    }
    startup.launchedAt = ctx.now.toISOString();
    return;
  }
  if (child.running && !child.switching) {
    enter(ctx, startup, 'briefing');
    return;
  }
  if (!child.provider && !child.launching && since(ctx, startup.launchedAt) > LAUNCH_SETTLE_MS) {
    hooks.failed(child.lastError ?? t('spawn.startup.notStarted'));
    return;
  }
  if (since(ctx, startup.launchedAt) > LAUNCH_GIVE_UP_MS) hooks.failed(t('spawn.startup.neverStarted'));
}

async function briefing(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  const { ports } = ctx;
  const { startup } = subject;
  const id = subject.childSessionId!;
  const child = await ports.readChild(id);
  if (!child) {
    hooks.gone();
    return;
  }
  const attention = (reason: SpawnAttention['reason'], detail: string | null = null, final = false) => hooks.attention({ reason, detail, final });
  // Quit before it took over: before the line went in, or during its first turn.
  if (!child.running) {
    if (!child.switching) await exited(ctx, subject, hooks);
    return;
  }
  if (!startup.sentAt) {
    if (child.startupPrompt === 'workspace_trust') {
      await answerTrust(ctx, subject, hooks);
      return;
    }
    // Any other screen the app recognizes is the user's to answer.
    if (child.interaction) {
      attention('startup_prompt');
      return;
    }
    if (child.phase !== 'idle') {
      if (since(ctx, startup.stageSince) > BRIEF_GIVE_UP_MS) attention('brief_not_delivered', t('spawn.startup.notReady'));
      return;
    }
    if (since(ctx, startup.stageSince) < CLI_SETTLE_MS || (startup.trustAnsweredAt && since(ctx, startup.trustAnsweredAt) < CLI_SETTLE_MS)) return;
    // Typed only into the CLI's own input box (ADR 0030).
    const { decision, guard } = beforeFirstMessage(await ports.readScreen(id), startup.guard ?? newLaunchGuard(), ctx.now);
    startup.guard = guard;
    if (decision.do === 'skip_update') {
      const answer = await ports.skipUpdate(id);
      if (answer !== 'answered') {
        const reading = await ports.readScreen(id);
        startup.guard = noticed(guard, reading?.tail ?? null, ctx.now);
        attention('startup_prompt', withTail(t('spawn.startup.updatePromptUnsure'), reading?.tail ?? null));
      }
      return;
    }
    if (decision.do === 'notice') {
      attention('startup_prompt', withTail(t(decision.about === 'update_prompt' ? 'spawn.startup.updateSkippedStill' : 'spawn.startup.unknownScreen'), decision.tail));
      return;
    }
    if (decision.do === 'wait') {
      if (since(ctx, startup.stageSince) > BRIEF_GIVE_UP_MS) attention('brief_not_delivered', withTail(t('spawn.startup.noInputBox'), guard.tail));
      return;
    }
    const outcome = await ports.send(id, hooks.message);
    if (outcome.status === 'sent') startup.sentAt = ctx.now.toISOString();
    else if (outcome.status === 'failed') attention('brief_not_delivered', outcome.reason);
    else if (since(ctx, startup.stageSince) > BRIEF_GIVE_UP_MS) attention('brief_not_delivered', t('spawn.startup.waitingElsewhere'));
    return;
  }
  if (!startup.deliveredAt) {
    if (since(ctx, startup.sentAt) < OWN_SEND_SLACK_MS) return;
    const delivered = await ports.checkDelivered(id, hooks.message, startup.sentAt);
    const verdict = confirmFirstDelivery({ delivered, sentAt: startup.sentAt, now: ctx.now, resent: startup.resent });
    if (verdict === 'delivered') startup.deliveredAt = ctx.now.toISOString();
    else if (verdict === 'resend') {
      // Sent again once the CLI is back at its input box.
      startup.sentAt = null;
      startup.resent += 1;
    } else if (verdict === 'failed') attention('brief_not_delivered', t('spawn.startup.readBriefYourself', { file: subject.briefFile }), true);
    return;
  }
  // In: taken over once it got through its first turn (ADR 0030).
  const watched = watchFirstTurn({ running: child.running, switching: child.switching, phase: child.phase, deliveredAt: startup.deliveredAt, now: ctx.now });
  if (watched === 'over') hooks.briefed(startup.sentAt);
}

function withTail(text: string, tail: string | null): string {
  return tail ? t('format.text.withTail', { text, tail }) : text;
}

// The CLI quit before taking over. One that quit to finish updating itself
// is started again (same profile, same tmux) and given the line again;
// anything else is the user's, with what its screen ended on.
async function exited(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  const { startup } = subject;
  const guard = startup.guard ?? newLaunchGuard();
  const after = afterExit(await ctx.ports.readScreen(subject.childSessionId!), guard);
  if (!after.relaunch) {
    startup.guard = { ...guard, tail: after.tail };
    hooks.attention({ reason: 'cli_exited', detail: after.tail, final: false });
    return;
  }
  enter(ctx, startup, 'launch');
  Object.assign(startup, { launchedAt: null, trustAnsweredAt: null, sentAt: null, resent: 0, deliveredAt: null });
  startup.guard = { ...newLaunchGuard(), relaunches: guard.relaunches + 1, tail: after.tail };
  hooks.relaunching?.();
}

// The trust prompt is answered once, on the user's behalf, only when the
// caller says the user agreed to this folder being worked in (ADR 0015
// 決策 4a); otherwise it waits for them.
async function answerTrust(ctx: SpawnContext, subject: SpawnSubject, hooks: SpawnHooks): Promise<void> {
  const { startup } = subject;
  if (!hooks.trustAllowed()) {
    hooks.attention({ reason: 'workspace_trust', detail: null, final: false });
    return;
  }
  if (startup.trustAnsweredAt) {
    if (since(ctx, startup.trustAnsweredAt) > TRUST_SETTLE_MS) {
      hooks.attention({ reason: 'workspace_trust', detail: t('spawn.startup.trustStill'), final: false });
    }
    return;
  }
  const answer = await ctx.ports.answerTrust(subject.childSessionId!);
  if (answer !== 'answered') {
    hooks.attention({ reason: 'workspace_trust', detail: t('spawn.startup.trustUnsure'), final: false });
    return;
  }
  startup.trustAnsweredAt = ctx.now.toISOString();
  hooks.trustAnswered();
}
