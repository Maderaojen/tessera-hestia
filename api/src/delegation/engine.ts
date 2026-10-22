import path from 'node:path';
import type {
  CleanupDelegationRequest, Delegation, DelegationInitiator, DelegationLimits, DelegationOverride, DelegationPreferences,
  DelegationSettingsPatch, DelegationSettingsResponse, DeliverDelegationRequest, ReviewDelegationRequest, SessionDelegationPatch,
  SessionDelegationResponse, StartDelegationRequest,
} from '../contract/delegation.js';
import type { ErrorCode } from '../contract/errors.js';
import { newLaunchGuard } from '../contract/launch-guard.js';
import type { JsonFileStore } from '@maderaojen/json-file-store';
import { prompt, t } from '../i18n/index.js';
import { advanceOutbox } from './outbox.js';
import {
  allows, applyOverridePatch, branchName, checkConcurrent, checkDepth, checkInitiation, checkQuota, DEFAULT_LIMITS, DEFAULT_PREFERENCES,
  defaultTitle, depthOf, effectiveLimits, effectivePreferences, gateQuota, isTerminal, llmSendBacks, looserLimit, lowQuotaDecision, pickIsolation,
  pickProfile, proposalExpired, routeDelivery, shouldNotify, type CheckRefusal, type DelegationAction,
} from './policy.js';
import type { DelegationPorts } from './ports.js';
import { addReport, attentionText, dropUnsentReview, setState, toChild, toParent, type StepContext } from './record.js';
import { advanceStartup, newStartup, toWorking } from './startup.js';
import { watchDelegation } from './watch.js';

export type { DelegationPorts } from './ports.js';

// Handing a piece of work to another LLM in a tmux of its own. Knows
// nothing of tmux, git or the registry: everything it reads or does goes
// through DelegationPorts (wired up in wiring.ts), and all it keeps is one
// JSON file, so a restart (every deploy) picks up where it was.

// Every delegation not over moves one step this often, acting only on
// what it observes then (as continuity's handoffs do).
export const DELEGATION_TICK_MS = 5_000;

export type DelegationState = {
  version: 1;
  preferences: DelegationPreferences;
  limits: DelegationLimits;
  // Per delegating session: its own preferences, stricter limits.
  sessions: Record<string, DelegationOverride>;
  delegations: Record<string, Delegation>;
};

export function emptyDelegationState(): DelegationState {
  return { version: 1, preferences: structuredClone(DEFAULT_PREFERENCES), limits: structuredClone(DEFAULT_LIMITS), sessions: {}, delegations: {} };
}

/** Whatever is on disk, made the current shape; anything unreadable falls back to defaults. */
export function decodeDelegationState(raw: unknown): DelegationState {
  const state = emptyDelegationState();
  if (!raw || typeof raw !== 'object') return state;
  const r = raw as Partial<DelegationState>;
  state.preferences = { ...state.preferences, ...(r.preferences ?? {}) };
  state.limits = { ...state.limits, ...(r.limits ?? {}) };
  for (const [id, own] of Object.entries(r.sessions && typeof r.sessions === 'object' ? r.sessions : {})) {
    if (!own || typeof own !== 'object') continue;
    const { preferences, limits } = own as Partial<DelegationOverride>;
    state.sessions[id] = {
      preferences: preferences && typeof preferences === 'object' ? preferences : {},
      limits: limits && typeof limits === 'object' ? limits : {},
    };
  }
  for (const [id, delegation] of Object.entries(r.delegations ?? {})) {
    if (!delegation || typeof delegation !== 'object' || typeof delegation.id !== 'string') continue;
    // Written by phase 1: no approval, and an outbox nobody used.
    delegation.approvedAt ??= null;
    // Written before the delegating conversation's length was kept.
    delegation.parentTurnsAtStart ??= null;
    delegation.outbox = Array.isArray(delegation.outbox) ? delegation.outbox.filter((item) => item && typeof item.event === 'string') : [];
    state.delegations[id] = delegation;
  }
  return state;
}

export type DelegationRefusal = { ok: false; status: 400 | 403 | 404 | 409; code: ErrorCode; message: string; params?: Record<string, string> };
export type DelegationResult = { ok: true; delegation: Delegation } | DelegationRefusal;
export type SessionSettingsResult = { ok: true; view: SessionDelegationResponse } | DelegationRefusal;

/** Who stops (or reviews) it: the user (their login), or the delegating LLM from its own session. */
export type StopBy = { by: 'user' } | { by: 'parent'; sessionId: string };
export type ReviewBy = StopBy;

export type DelegationEngine = {
  start(): void;
  stop(): void;
  // Moves every delegation that isn't over one step on.
  advance(): Promise<void>;
  list(filter: { sessionId?: string; active?: boolean }): Promise<Delegation[]>;
  get(id: string): Promise<Delegation | null>;
  // Where its delivery has been merged (DelegationDetailResponse); null when unknown.
  deliveryMergedInto(delegation: Delegation): Promise<string | null>;
  startDelegation(request: StartDelegationRequest, initiator: DelegationInitiator): Promise<DelegationResult>;
  // An LLM's proposal: the user says yes (the checks run again) or no.
  approve(id: string): Promise<DelegationResult>;
  decline(id: string): Promise<DelegationResult>;
  deliver(id: string, request: DeliverDelegationRequest): Promise<DelegationResult>;
  // The delegating LLM passes it on or sends it back; the user only sends it back.
  review(id: string, request: Omit<ReviewDelegationRequest, 'fromSessionId'>, by: ReviewBy): Promise<DelegationResult>;
  // Removes the worktree (and a merged branch) of one that is over.
  cleanup(id: string, request: CleanupDelegationRequest): Promise<DelegationResult>;
  accept(id: string): Promise<DelegationResult>;
  reject(id: string): Promise<DelegationResult>;
  stopDelegation(id: string, by?: StopBy): Promise<DelegationResult>;
  // Its CLI quit (before taking over, or later): started again in its tmux
  // with the same profile, and its brief sent again (ADR 0030).
  relaunch(id: string): Promise<DelegationResult>;

  getSettings(): Promise<DelegationSettingsResponse>;
  setSettings(patch: DelegationSettingsPatch): Promise<DelegationSettingsResponse>;
  // One delegating tmux's own: any preference, limits only stricter.
  getSessionSettings(sessionId: string): Promise<SessionSettingsResult>;
  setSessionSettings(sessionId: string, patch: SessionDelegationPatch): Promise<SessionSettingsResult>;
};

/** The brief: in the delegate's cwd, under .hestia/delegations/<id>/. */
function briefFileOf(cwd: string, id: string): string {
  return path.join(cwd, '.hestia', 'delegations', id, 'brief.md');
}

const refuse = (status: DelegationRefusal['status'], code: ErrorCode, message: string, params?: Record<string, string>): DelegationRefusal => (
  { ok: false, status, code, message, ...(params ? { params } : {}) }
);

/**
 * Back to work with feedback (決策 13): the next round, the feedback typed
 * into the delegate once it is idle, and its idle clock started again. The
 * delegating LLM's send-backs are counted against maxReviewRounds by the
 * caller; the user's never are.
 */
function sendBack(ctx: StepContext, delegation: Delegation, by: 'parent' | 'user', feedback: string): void {
  addReport(ctx, delegation, { kind: 'review', by, verdict: 'send_back', text: feedback });
  delegation.round += 1;
  delegation.lastActivityAt = ctx.now.toISOString();
  setState(ctx, delegation, 'working');
  toChild(ctx, delegation);
  const line = feedback.split('\n').find((candidate) => candidate.trim())?.trim() ?? '';
  if (by === 'parent') ctx.notify(delegation, t('delegation.push.sentBack', { round: delegation.round, line: line.length > 120 ? `${line.slice(0, 120)}…` : line }), 'all');
}

export function createDelegationEngine(ports: DelegationPorts, store: JsonFileStore<DelegationState>): DelegationEngine {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Steps and API actions all read-modify-write one file; one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  // What applies to a delegating session: the global settings, then its own.
  function settingsFor(state: DelegationState, sessionId: string | null): { preferences: DelegationPreferences; limits: DelegationLimits } {
    const own = sessionId ? state.sessions[sessionId] : undefined;
    return { preferences: effectivePreferences(state.preferences, own?.preferences), limits: effectiveLimits(state.limits, own?.limits) };
  }

  function context(state: DelegationState, delegation: Delegation): StepContext {
    const { preferences, limits } = settingsFor(state, delegation.parentSessionId);
    return {
      ports,
      preferences,
      limits,
      now: ports.now(),
      notify: (target, body, level = 'key') => {
        if (!shouldNotify(level, preferences.notify)) return;
        void ports.notify(structuredClone(target), body).catch((err: unknown) => console.warn('[delegation] notify failed', err));
      },
    };
  }

  /**
   * The checks that run when one is started and again when a proposal is
   * approved (決策 7, 13): depth, how many at once, the target's quota.
   * `excluding` is the proposal being approved, not counted against itself.
   * A low quota stops an LLM's (and an approval: the proposal was the
   * LLM's); the user's own goes ahead once they confirm it.
   */
  async function checkLimits(
    state: DelegationState,
    input: { parentSessionId: string; depth: number; profileId: string; excluding: string | null; initiator: DelegationInitiator; confirmLowQuota: boolean },
  ): Promise<CheckRefusal | { ok: true; quotaAtStart: number | null; overridden: CheckRefusal | null }> {
    const { limits } = settingsFor(state, input.parentSessionId);
    const deep = checkDepth(input.depth, limits);
    if (deep) return deep;
    const active = Object.values(state.delegations).filter((d) => !isTerminal(d.state) && d.id !== input.excluding);
    const many = checkConcurrent({
      activeOnHost: active.length,
      activeFromParent: active.filter((d) => d.parentSessionId === input.parentSessionId).length,
      globalMax: state.limits.maxConcurrent,
      parentMax: state.sessions[input.parentSessionId]?.limits.maxConcurrent,
    });
    if (many) return many;
    const quota = await ports.readQuota(input.profileId);
    return gateQuota({ check: checkQuota(quota, limits, ports.now()), quota, initiator: input.initiator, confirmed: input.confirmLowQuota });
  }

  // The delegation the delegating session is itself working on, if it is a delegate.
  function delegationOf(state: DelegationState, childSessionId: string): Delegation | null {
    return Object.values(state.delegations)
      .filter((d) => d.childSessionId === childSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async function step(state: DelegationState, delegation: Delegation, busyParents: Set<string>): Promise<void> {
    const ctx = context(state, delegation);
    if (delegation.state === 'proposed') {
      if (proposalExpired(delegation.createdAt, ctx.now)) {
        setState(ctx, delegation, 'stopped', 'expired');
        toParent(ctx, delegation, 'expired');
      }
    } else if (delegation.state === 'starting') {
      await advanceStartup(ctx, delegation);
    } else if (!isTerminal(delegation.state)) {
      await watchDelegation(ctx, delegation);
    }
    // Even once it is over: the user's verdict still goes to the delegating conversation.
    if (delegation.outbox.length) await advanceOutbox(ctx, delegation, busyParents);
  }

  async function advanceOnce(): Promise<void> {
    const state = await store.load();
    let changed = false;
    const busyParents = new Set<string>();
    for (const delegation of Object.values(state.delegations)) {
      if (isTerminal(delegation.state) && !delegation.outbox.length) continue;
      const before = JSON.stringify(delegation);
      try {
        await step(state, delegation, busyParents);
      } catch (err) {
        // Tried again on the next tick.
        console.error(`[delegation] step for ${delegation.id} failed`, err);
      }
      if (JSON.stringify(delegation) !== before) {
        delegation.updatedAt = ports.now().toISOString();
        changed = true;
      }
    }
    if (changed) await store.save(state);
  }

  const advance = () => serial(advanceOnce);

  // Right after a change, rather than on the next tick, while running.
  function kick(): void {
    if (timer) setImmediate(() => void advance().catch((err: unknown) => console.error('[delegation] step failed', err)));
  }

  /** One delegation, changed by an API action and saved. */
  function act(id: string, change: (state: DelegationState, delegation: Delegation, ctx: StepContext) => Promise<DelegationRefusal | null>): Promise<DelegationResult> {
    return serial(async (): Promise<DelegationResult> => {
      const state = await store.load();
      const delegation = state.delegations[id];
      if (!delegation) return refuse(404, 'not_found', 'not found');
      const ctx = context(state, delegation);
      const refused = await change(state, delegation, ctx);
      if (refused) return refused;
      delegation.updatedAt = ctx.now.toISOString();
      await store.save(state);
      kick();
      return { ok: true, delegation: structuredClone(delegation) };
    });
  }

  function sessionView(state: DelegationState, sessionId: string): SessionDelegationResponse {
    const own = state.sessions[sessionId];
    const { preferences, limits } = settingsFor(state, sessionId);
    return {
      effective: preferences,
      override: { preferences: structuredClone(own?.preferences ?? {}), limits: structuredClone(own?.limits ?? {}) },
      limits,
    };
  }

  function guard(delegation: Delegation, action: DelegationAction): DelegationRefusal | null {
    return allows(delegation.state, action)
      ? null
      : refuse(409, 'delegation_state', `a ${delegation.state} delegation can't take ${action}`, { state: delegation.state });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void advance().catch((err: unknown) => console.error('[delegation] step failed', err));
      }, DELEGATION_TICK_MS);
      timer.unref?.();
      kick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    advance,
    async list(filter) {
      const state = await store.load();
      return Object.values(state.delegations)
        .filter((d) => !filter.sessionId || d.parentSessionId === filter.sessionId || d.childSessionId === filter.sessionId)
        .filter((d) => !filter.active || !isTerminal(d.state))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((d) => structuredClone(d));
    },
    async get(id) {
      const found = (await store.load()).delegations[id];
      return found ? structuredClone(found) : null;
    },
    async deliveryMergedInto(delegation) {
      if (!delegation.workspace.headAtDelivery) return null;
      return ports.deliveryMergedInto(delegation.workspace).catch(() => null);
    },
    startDelegation(request, initiator) {
      return serial(async (): Promise<DelegationResult> => {
        const state = await store.load();
        const parent = await ports.readParent(request.parentSessionId);
        if (!parent) {
          return initiator === 'llm'
            ? refuse(400, 'not_in_managed_tmux', 'the delegating session is not one the app manages')
            : refuse(404, 'not_found', 'the delegating session was not found');
        }
        const { preferences } = settingsFor(state, request.parentSessionId);
        const initiation = checkInitiation(initiator, preferences);
        if (!initiation.ok) return initiation;
        const profiles = await ports.listProfiles();
        const picked = pickProfile({ initiator, requested: request.profileId, targets: preferences.targets, available: profiles.map((p) => p.id) });
        if (!picked.ok) return picked;
        const profile = profiles.find((candidate) => candidate.id === picked.profileId)!;
        // Only the user picks a mode (the route refuses the tool token's too).
        if (initiator === 'llm' && request.permissionMode) return refuse(403, 'login_required', 'only the user\'s own login can choose a permission mode');
        const permission = await ports.launchPermissionMode({
          sessionId: request.parentSessionId, profileId: profile.id, llm: initiator === 'llm',
          ...(request.permissionMode ? { requested: request.permissionMode } : {}),
        });
        if (!permission.ok) return refuse(400, permission.code, permission.message);
        const isolation = pickIsolation(initiator, request.isolation, preferences.isolation);
        if (!isolation.ok) return isolation;
        const depth = depthOf(delegationOf(state, request.parentSessionId)?.depth ?? null);
        const limits = await checkLimits(state, {
          parentSessionId: request.parentSessionId, depth, profileId: profile.id, excluding: null, initiator, confirmLowQuota: request.confirmLowQuota === true,
        });
        if (!limits.ok) return limits;

        const now = ports.now().toISOString();
        let id = ports.newId();
        while (state.delegations[id]) id = ports.newId();
        const title = request.title?.trim() || defaultTitle(request.task);
        // Planned now (read only); a proposal is planned again when approved.
        const workspace = await ports.planWorkspace({ id, branch: branchName(id, title), parentCwd: parent.cwd, isolation: isolation.isolation });
        const propose = initiation.propose;
        const delegation: Delegation = {
          id,
          title,
          initiator,
          approvedAt: null,
          parentSessionId: request.parentSessionId,
          parentConversationId: parent.conversationId,
          parentTurnsAtStart: null,
          childSessionId: null,
          depth,
          profileId: profile.id,
          profileLabel: profile.label,
          permissionMode: permission.mode,
          profileHistory: [{ profileId: profile.id, at: now }],
          workspace,
          task: request.task,
          briefFile: briefFileOf(workspace.path, id),
          state: propose ? 'proposed' : 'starting',
          stateReason: null,
          stateDetail: null,
          stateSince: now,
          startup: propose ? null : newStartup(now),
          briefSentAt: null,
          round: 1,
          reports: [],
          outbox: [],
          quotaAtStart: limits.quotaAtStart,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: null,
          endedAt: null,
        };
        state.delegations[id] = delegation;
        const ctx = context(state, delegation);
        if (limits.overridden) addReport(ctx, delegation, { kind: 'decision', by: 'user', text: lowQuotaDecision(limits.overridden) });
        await store.save(state);
        if (propose) ctx.notify(delegation, t('delegation.push.proposed', { from: parent.profileLabel ?? 'LLM', to: profile.label }));
        else if (initiator === 'llm') ctx.notify(delegation, t('delegation.push.llmStarted', { to: profile.label }), 'all');
        kick();
        return { ok: true, delegation: structuredClone(delegation) };
      });
    },
    relaunch(id) {
      return act(id, async (_state, delegation, ctx) => {
        if (!['starting', 'working', 'needs_attention'].includes(delegation.state) || !delegation.childSessionId) {
          return refuse(409, 'delegation_state', `a ${delegation.state} delegation can't be started again`, { state: delegation.state });
        }
        const child = await ports.readChild(delegation.childSessionId);
        if (!child) return refuse(409, 'delegation_state', 'its session is gone', { state: delegation.state });
        if (child.running || child.switching || child.launching) {
          // Stuck on a screen before its brief went in (an update menu, one
          // the app doesn't know): it has done no work yet, so its tmux is
          // closed first and made again by the start.
          if (!stuckBeforeBrief(delegation) || child.switching) return refuse(409, 'cli_already_running', 'its CLI is still running');
          const closed = await ports.closeChild(delegation.childSessionId, true);
          if (!closed.ok) return refuse(409, 'cli_already_running', `its CLI could not be ended: ${closed.reason}`);
        }
        // From the top: each step finds what is already there and moves on.
        // The automatic relaunches already done still count against their cap.
        const relaunches = delegation.startup?.guard?.relaunches ?? 0;
        delegation.startup = { ...newStartup(ctx.now.toISOString()), guard: { ...newLaunchGuard(), relaunches } };
        addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userRelaunched') });
        setState(ctx, delegation, 'starting');
        return null;
      });
    },
    approve(id) {
      return act(id, async (state, delegation, ctx) => {
        const refused = guard(delegation, 'approve');
        if (refused) return refused;
        const parent = delegation.parentSessionId ? await ports.readParent(delegation.parentSessionId) : null;
        if (!parent || !delegation.parentSessionId) return refuse(409, 'not_found', 'the delegating session is gone');
        if (!(await ports.listProfiles()).some((profile) => profile.id === delegation.profileId)) {
          return refuse(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
        }
        // The limits and the quota may have changed since it was proposed.
        // The proposal is the LLM's: a low quota refuses it, as it would have when proposed.
        const limits = await checkLimits(state, {
          parentSessionId: delegation.parentSessionId, depth: delegation.depth, profileId: delegation.profileId, excluding: delegation.id,
          initiator: 'llm', confirmLowQuota: false,
        });
        if (!limits.ok) return limits;
        // From the delegating session's HEAD now, not when it was proposed.
        delegation.workspace = await ports.planWorkspace({
          id: delegation.id, branch: branchName(delegation.id, delegation.title), parentCwd: parent.cwd, isolation: delegation.workspace.isolation,
        });
        delegation.briefFile = briefFileOf(delegation.workspace.path, delegation.id);
        delegation.parentConversationId = parent.conversationId;
        delegation.quotaAtStart = limits.quotaAtStart;
        delegation.approvedAt = ctx.now.toISOString();
        delegation.startup = newStartup(ctx.now.toISOString());
        addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userApproved') });
        setState(ctx, delegation, 'starting');
        return null;
      });
    },
    decline(id) {
      return act(id, async (_state, delegation, ctx) => {
        const refused = guard(delegation, 'decline');
        if (refused) return refused;
        addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userDeclined') });
        setState(ctx, delegation, 'stopped', 'declined');
        toParent(ctx, delegation, 'declined');
        return null;
      });
    },
    deliver(id, request) {
      return act(id, async (_state, delegation, ctx) => {
        // Within its first turn, while the launch guard still watches it
        // (ADR 0030): the brief is in, so it was at work already.
        const early = delegation.state === 'starting' && !!delegation.startup?.deliveredAt && !!delegation.startup.sentAt;
        const refused = early ? null : guard(delegation, 'deliver');
        if (refused) return refused;
        if (!(await ports.readChild(request.fromSessionId))) return refuse(400, 'not_in_managed_tmux', 'not called from a session the app manages');
        if (request.fromSessionId !== delegation.childSessionId) return refuse(400, 'invalid_request', 'only the delegate\'s own session can deliver it');
        if (early) toWorking(ctx, delegation, delegation.startup!.sentAt);
        if (request.blocked) {
          // Every question is passed on, even a second one in a row.
          const question = request.report.trim().split('\n')[0]?.slice(0, 200) || null;
          addReport(ctx, delegation, { kind: 'blocked', by: 'child', text: request.report });
          setState(ctx, delegation, 'needs_attention', 'blocked', question);
          ctx.notify(delegation, question ? t('format.text.labelValue', { label: attentionText(ctx, 'blocked'), value: question }) : attentionText(ctx, 'blocked'));
          toParent(ctx, delegation, 'blocked');
          return null;
        }
        const { clean, head } = await ports.workspaceState(delegation.workspace);
        if (delegation.workspace.isolation === 'worktree' && !clean) {
          return refuse(409, 'workspace_dirty', 'the worktree has uncommitted changes; commit them before delivering');
        }
        delegation.workspace.headAtDelivery = head;
        delegation.startup = null;
        addReport(ctx, delegation, { kind: 'delivery', by: 'child', text: request.report });
        // The delegating LLM reviews it first when it can; otherwise
        // straight to the user, and the delegating conversation is told.
        const route = routeDelivery({
          parentReview: ctx.preferences.parentReview,
          parentAlive: !!delegation.parentSessionId && !!(await ports.readChild(delegation.parentSessionId)),
          sendBacks: llmSendBacks(delegation.reports),
          maxReviewRounds: ctx.limits.maxReviewRounds,
        });
        if (route.state === 'reviewing') {
          setState(ctx, delegation, 'reviewing');
          ctx.notify(delegation, t('delegation.push.deliveredForReview', { round: delegation.round }), 'all');
          toParent(ctx, delegation, 'review');
          return null;
        }
        setState(ctx, delegation, 'delivered', route.reason);
        ctx.notify(delegation, t(route.reason === 'review_rounds' ? 'delegation.push.deliveredRoundsUsed' : 'delegation.push.delivered'));
        toParent(ctx, delegation, 'delivered');
        return null;
      });
    },
    review(id, request, by) {
      return act(id, async (_state, delegation, ctx) => {
        const feedback = request.feedback?.trim() ?? '';
        if (by.by === 'user') {
          // The user's own verdict is accept or reject; a review from the user is a send-back.
          if (request.verdict !== 'send_back') return refuse(400, 'invalid_request', 'the user sends work back here; accepting it is POST /accept');
          const refused = guard(delegation, 'send_back');
          if (refused) return refused;
          if (!feedback) return refuse(400, 'invalid_request', 'say what to change (feedback)');
          sendBack(ctx, delegation, 'user', feedback);
          return null;
        }
        const refused = guard(delegation, 'review');
        if (refused) return refused;
        if (!(await ports.readChild(by.sessionId))) return refuse(400, 'not_in_managed_tmux', 'not called from a session the app manages');
        if (by.sessionId !== delegation.parentSessionId) return refuse(400, 'invalid_request', 'only the delegating session can review it');
        if (request.verdict === 'pass') {
          addReport(ctx, delegation, { kind: 'review', by: 'parent', verdict: 'pass', text: feedback || prompt('delegation.record.parentPassed') });
          dropUnsentReview(delegation);
          setState(ctx, delegation, 'delivered', 'passed');
          ctx.notify(delegation, t('delegation.push.parentPassed'));
          return null;
        }
        if (!feedback) return refuse(400, 'invalid_request', 'say what to change (--feedback or --feedback-file)');
        if (llmSendBacks(delegation.reports) >= ctx.limits.maxReviewRounds) {
          // Its send-backs are used up (the limit was lowered meanwhile): the user decides.
          addReport(ctx, delegation, { kind: 'review', by: 'parent', verdict: 'send_back', text: feedback });
          addReport(ctx, delegation, { kind: 'decision', by: 'system', text: prompt('delegation.record.roundsUsed', { max: ctx.limits.maxReviewRounds }) });
          dropUnsentReview(delegation);
          setState(ctx, delegation, 'delivered', 'review_rounds');
          ctx.notify(delegation, t('delegation.push.sendBackRoundsUsed'));
          return null;
        }
        sendBack(ctx, delegation, 'parent', feedback);
        return null;
      });
    },
    cleanup(id, request) {
      return act(id, async (_state, delegation, ctx) => {
        const refused = guard(delegation, 'cleanup');
        if (refused) return refused;
        const ws = delegation.workspace;
        if (ws.isolation !== 'worktree' || !ws.worktree || !ws.repoRoot) {
          return refuse(400, 'invalid_request', 'it worked in the delegating session\'s own folder; there is no worktree to remove');
        }
        const deleteBranch = request.deleteBranch === true && !!ws.branch && !ws.branchDeletedAt;
        if (ws.removedAt && !deleteBranch) return refuse(400, 'invalid_request', 'its worktree is removed already');
        // Refused for uncommitted work or an unmerged branch before the tmux is closed.
        const removable = await ports.workspaceRemovable(ws, { deleteBranch });
        if (removable) return refuse(409, removable.code, removable.message);
        const done: string[] = [];
        // Nothing is left running in a folder about to go: the delegate's
        // tmux is closed first, as 關閉此 tmux does.
        if (!ws.removedAt && delegation.childSessionId) {
          const closed = await ports.closeChild(delegation.childSessionId);
          if (!closed.ok) {
            return refuse(409, 'delegate_still_running', `the delegate's CLI did not exit (${closed.reason}); close its tmux in the app, then clean up again`, { reason: closed.reason });
          }
          if (closed.closed) done.push(prompt('delegation.record.closedTmux'));
        }
        const outcome = await ports.removeWorkspace(ws, { deleteBranch });
        if (!outcome.ok) return refuse(409, outcome.code, outcome.message);
        const at = ctx.now.toISOString();
        if (outcome.removed) {
          ws.removedAt = at;
          done.push(prompt('delegation.record.removedWorktree', { worktree: ws.worktree }));
        }
        if (outcome.branchDeleted) {
          ws.branchDeletedAt = at;
          done.push(prompt('delegation.record.deletedBranch', { branch: ws.branch }));
        }
        if (done.length) addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userArchived', { done: done.join(prompt('delegation.record.listSeparator')) }) });
        return null;
      });
    },
    accept(id) {
      return act(id, async (_state, delegation, ctx) => {
        const refused = guard(delegation, 'accept');
        if (refused) return refused;
        // Nothing is merged: the branch is the user's (or the delegating
        // LLM's) to merge.
        addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userAccepted'), verdict: 'accept' });
        dropUnsentReview(delegation);
        setState(ctx, delegation, 'accepted');
        toParent(ctx, delegation, 'accepted');
        return null;
      });
    },
    reject(id) {
      return act(id, async (_state, delegation, ctx) => {
        const refused = guard(delegation, 'reject');
        if (refused) return refused;
        addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userRejected'), verdict: 'reject' });
        dropUnsentReview(delegation);
        setState(ctx, delegation, 'rejected');
        toParent(ctx, delegation, 'rejected');
        return null;
      });
    },
    stopDelegation(id, by = { by: 'user' }) {
      return act(id, async (_state, delegation, ctx) => {
        const refused = guard(delegation, 'stop');
        if (refused) return refused;
        if (by.by === 'parent') {
          if (!(await ports.readChild(by.sessionId))) return refuse(400, 'not_in_managed_tmux', 'not called from a session the app manages');
          if (by.sessionId !== delegation.parentSessionId) return refuse(400, 'invalid_request', 'only the delegating session can stop it');
        }
        // The reply in progress is stopped; the tmux and the worktree stay.
        if (delegation.childSessionId) {
          const child = await ports.readChild(delegation.childSessionId);
          if (child?.running && child.phase === 'replying') {
            await ports.interrupt(delegation.childSessionId).catch((err: unknown) => console.warn(`[delegation] ${id}: interrupting the delegate failed`, err));
          }
        }
        if (by.by === 'parent') {
          addReport(ctx, delegation, { kind: 'decision', by: 'parent', text: prompt('delegation.record.parentStopped') });
          setState(ctx, delegation, 'stopped', 'parent');
        } else {
          addReport(ctx, delegation, { kind: 'decision', by: 'user', text: prompt('delegation.record.userStopped') });
          setState(ctx, delegation, 'stopped', 'user');
        }
        return null;
      });
    },

    async getSettings() {
      const state = await store.load();
      return { preferences: structuredClone(state.preferences), limits: structuredClone(state.limits) };
    },
    setSettings(patch) {
      return serial(async () => {
        const state = await store.load();
        state.preferences = { ...state.preferences, ...(patch.preferences ?? {}) };
        state.limits = { ...state.limits, ...(patch.limits ?? {}) };
        await store.save(state);
        return { preferences: structuredClone(state.preferences), limits: structuredClone(state.limits) };
      });
    },
    async getSessionSettings(sessionId) {
      if (!(await ports.readParent(sessionId))) return refuse(404, 'not_found', 'not found');
      return { ok: true, view: sessionView(await store.load(), sessionId) };
    },
    setSessionSettings(sessionId, patch) {
      return serial(async (): Promise<SessionSettingsResult> => {
        if (!(await ports.readParent(sessionId))) return refuse(404, 'not_found', 'not found');
        const state = await store.load();
        const own = state.sessions[sessionId] ?? { preferences: {}, limits: {} };
        const next: DelegationOverride = {
          preferences: applyOverridePatch<DelegationPreferences>(own.preferences, patch.preferences),
          limits: applyOverridePatch<DelegationLimits>(own.limits, patch.limits),
        };
        // A tmux only tightens a limit; loosening one is refused, not ignored.
        const looser = looserLimit(state.limits, next.limits);
        if (looser) {
          return refuse(400, 'invalid_request', `${looser} may only be made stricter than the global ${state.limits[looser]} in a tmux`, { field: looser });
        }
        if (Object.keys(next.preferences).length || Object.keys(next.limits).length) state.sessions[sessionId] = next;
        else delete state.sessions[sessionId];
        await store.save(state);
        return { ok: true, view: sessionView(state, sessionId) };
      });
    },
  };
}

/** Waiting on the user before its brief went in, so its CLI has done nothing yet (ADR 0030). */
export function stuckBeforeBrief(delegation: Pick<Delegation, 'state' | 'startup'>): boolean {
  return delegation.state === 'needs_attention' && delegation.startup?.stage === 'briefing' && !delegation.startup.deliveredAt;
}
