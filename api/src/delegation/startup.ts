import path from 'node:path';
import { DELEGATION_MESSAGES, type Delegation } from '../contract/delegation.js';
import { advanceSpawn, type StepOutcome } from '../spawn/startup.js';
import { prompt, t } from '../i18n/index.js';
import { formatDelegationBrief } from './brief.js';
import { addReport, launchFailed, needAttention, setState, type StepContext } from './record.js';

// A delegation in 'starting' (ADR 0015 決策 13, 16): the steps are
// spawn/startup.ts's, shared with branch lines; what each outcome means
// for a delegation (its state, a report, a notice) is here.

export { BRIEF_GIVE_UP_MS, CLI_SETTLE_MS, LAUNCH_GIVE_UP_MS, MISSING_GIVE_UP_MS, newStartup, TRUST_SETTLE_MS } from '../spawn/startup.js';

/** The report the brief asks for, beside it. */
export function reportFileOf(delegation: Pick<Delegation, 'briefFile'>): string {
  return path.join(path.dirname(delegation.briefFile), 'report.md');
}

export function briefMessage(delegation: Pick<Delegation, 'briefFile'>): string {
  return DELEGATION_MESSAGES.brief(delegation.briefFile);
}

export async function advanceStartup(ctx: StepContext, delegation: Delegation): Promise<void> {
  const startup = delegation.startup;
  if (!startup) return;
  await advanceSpawn(ctx, { startup, childSessionId: delegation.childSessionId, briefFile: delegation.briefFile }, {
    message: briefMessage(delegation),
    prepare: () => prepare(ctx, delegation),
    ensureSession: () => ensureSession(ctx, delegation),
    async launch() {
      const result = await ctx.ports.launch(delegation.childSessionId!, delegation.profileId, delegation.permissionMode);
      return result.ok ? result : { ok: false, detail: result.reason };
    },
    // A user who started the delegation, or approved an LLM's proposal,
    // agreed to this worktree being worked in (ADR 0015 決策 4a). An LLM's
    // own delegation nobody approved ('allow') waits for the user.
    trustAllowed: () => delegation.initiator === 'user' || !!delegation.approvedAt,
    trustAnswered() {
      addReport(ctx, delegation, {
        kind: 'decision', by: 'system',
        text: prompt(delegation.approvedAt ? 'delegation.record.trustedApproved' : 'delegation.record.trustedUserStarted', { path: delegation.workspace.path }),
      });
    },
    failed: (detail) => launchFailed(ctx, delegation, detail),
    attention: ({ reason, detail }) => needAttention(ctx, delegation, reason, detail),
    gone: () => setState(ctx, delegation, 'stopped', 'child_gone'),
    briefed: (sentAt) => toWorking(ctx, delegation, sentAt),
    relaunching() {
      addReport(ctx, delegation, { kind: 'decision', by: 'system', text: prompt('delegation.record.relaunched') });
      ctx.notify(delegation, t('spawn.startup.relaunched'));
    },
  });
}

async function prepare(ctx: StepContext, delegation: Delegation): Promise<StepOutcome> {
  const { ports } = ctx;
  try {
    await ports.ensureWorkspace(delegation.workspace);
  } catch (err) {
    return { ok: false, detail: t('spawn.prepare.workspaceFailed', { error: (err as Error).message }) };
  }
  const parent = delegation.parentSessionId ? await ports.readParent(delegation.parentSessionId) : null;
  // The conversation it was delegated from, not the one that session is on
  // now; read up to the turns it had the first time, so doing this again
  // points at the same place.
  const { parentSessionId: sessionId, parentConversationId: conversationId } = delegation;
  const view = sessionId && conversationId
    ? await ports.readUpstream(sessionId, conversationId, delegation.parentTurnsAtStart ?? null).catch((err: unknown) => {
      console.warn(`[delegation] ${delegation.id}: reading where the delegating conversation is failed`, err);
      return null;
    })
    : null;
  // Not found, or no turns yet: nothing to stop at, so `--upstream` prints
  // all of it rather than none.
  if (view && view.turns > 0) delegation.parentTurnsAtStart ??= view.turns;
  const parentDirty = parent && delegation.workspace.isolation === 'worktree' ? await ports.parentDirty(parent.cwd) : null;
  const brief = formatDelegationBrief({
    delegation,
    parent: parent ? { tmuxName: parent.tmuxName, profileLabel: parent.profileLabel } : null,
    parentDirty,
    upstream: view && sessionId && conversationId
      ? { sessionId, conversationId, turns: delegation.parentTurnsAtStart ?? view.turns, view }
      : null,
    reportFile: reportFileOf(delegation),
    canDelegate: delegation.depth < ctx.limits.maxDepth,
  });
  try {
    await ports.writeBrief(delegation, brief);
  } catch (err) {
    return { ok: false, detail: t('delegation.prepare.briefFailed', { error: (err as Error).message }) };
  }
  // Chosen (and saved) before the session is made, so a restart in
  // between finds that session rather than making a second one.
  delegation.childSessionId ??= ports.newSessionId();
  return { ok: true };
}

async function ensureSession(ctx: StepContext, delegation: Delegation): Promise<StepOutcome> {
  const parent = delegation.parentSessionId ? await ctx.ports.readParent(delegation.parentSessionId) : null;
  if (!parent) return { ok: false, detail: t('delegation.prepare.parentGone') };
  try {
    await ctx.ports.ensureChildSession({
      sessionId: delegation.childSessionId!, cwd: delegation.workspace.path, projectId: parent.projectId, delegationId: delegation.id,
      alias: delegation.title,
      origin: { fromSessionId: delegation.parentSessionId, fromConversationId: delegation.parentConversationId },
    });
  } catch (err) {
    return { ok: false, detail: t('spawn.prepare.tmuxFailed', { error: (err as Error).message }) };
  }
  return { ok: true };
}

/** The brief is in: the delegate is at work. */
export function toWorking(ctx: StepContext, delegation: Delegation, briefSentAt: string | null): void {
  delegation.briefSentAt = briefSentAt ?? ctx.now.toISOString();
  delegation.startup = null;
  delegation.lastActivityAt = ctx.now.toISOString();
  const first = delegation.state === 'starting';
  setState(ctx, delegation, 'working');
  if (first) ctx.notify(delegation, t('delegation.push.started'), 'all');
}
