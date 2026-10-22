import type { PermissionMode } from '../contract/permissions.js';
import type {
  ContinuityDefaults, ContinuityEvent, ContinuityEventKind, ContinuityHandoff, ContinuityOverride, ContinuityPending, FailedHandoff,
  HandoffConfirm, HandoffSource, HandoffTrigger, RelaunchHandoffRequest, SessionContinuityResponse, StartHandoffRequest,
} from '../contract/continuity.js';
import type { ErrorCode } from '../contract/errors.js';
import type { JsonFileStore } from '@maderaojen/json-file-store';
import { advanceHandoff, beginHandoff, confirmHandoff, interruptNow, type HandoffContext } from './handoff.js';
import { t, type MessageKey } from '../i18n/index.js';
import {
  DEFAULT_CONTINUITY, decideCliWake, decideWake, effectivePolicy, monitorDecision, planForCliResume, planForHit, postponeOrDrop, resumesWithinDay, selectTarget,
  type DropReason, type ProfileCandidate,
} from './policy.js';
import type { ContinuityPorts, SessionView } from './ports.js';
import { newLaunchGuard } from '../contract/launch-guard.js';
import { afterExit } from '../launch-guard/decide.js';

export type { ContinuityPorts, SendOutcome, SessionView } from './ports.js';

// Carrying a conversation on when its CLI runs low on, or out of, its
// usage limit: wait for the
// reset and carry on, or hand the work to the next profile in the chain.
// Knows nothing of tmux, the registry or any CLI: everything it reads or
// does goes through ContinuityPorts (wired up in wiring.ts), and all it
// keeps is one JSON file, so a restart (every deploy) picks up where it was.

export const SCAN_INTERVAL_MS = 60_000;
// Handoffs move in steps a few seconds apart (a CLI finishing a turn, a
// relaunch landing), so they are advanced more often than the scan.
export const HANDOFF_TICK_MS = 5_000;
// The timer is re-armed at least this often, so a suspended machine or a
// clock change is caught up with.
const MAX_TIMER_MS = 60 * 60_000;
const MAX_HISTORY = 20;
// A handoff recorded as done is read again (recoverLostHandoff) only this
// soon after, and only when the CLI it started quit this soon after it.
export const LOST_HANDOFF_WINDOW_MS = 24 * 60 * 60_000;
const LOST_HANDOFF_EXIT_MS = 10 * 60_000;

type SessionState = {
  override: ContinuityOverride;
  // The last hit acted on, so the same one is never handled twice.
  lastHit: { conversationId: string; at: string } | null;
  pending: ContinuityPending | null;
  handoff: ContinuityHandoff | null;
  // The conversation whose low quota was already acted on (a handoff
  // started, or there was nobody to hand to): once per conversation.
  monitored: string | null;
  // A conversation whose handoff failed: its limit hits fall back to
  // waiting for the reset instead of trying again.
  noHandoffFor: string | null;
  // When carry-ons were sent, for the daily cap.
  resumedAt: string[];
  history: ContinuityEvent[];
  // The last handoff whose CLI never took over, for the user to start
  // again (ADR 0030); null once started again, dismissed or replaced.
  failedHandoff: FailedHandoff | null;
};

export type ContinuityState = {
  version: 1;
  defaults: ContinuityDefaults;
  sessions: Record<string, SessionState>;
  // Accounts known to be over their limit, from the hits seen on them.
  accounts: Record<string, { limitedUntil: string }>;
};

export function emptyContinuityState(): ContinuityState {
  return { version: 1, defaults: structuredClone(DEFAULT_CONTINUITY), sessions: {}, accounts: {} };
}

function emptySession(): SessionState {
  return { override: {}, lastHit: null, pending: null, handoff: null, monitored: null, noHandoffFor: null, resumedAt: [], history: [], failedHandoff: null };
}

/** Whatever is on disk, made the current shape; anything unreadable falls back to defaults. */
export function decodeContinuityState(raw: unknown): ContinuityState {
  const state = emptyContinuityState();
  if (!raw || typeof raw !== 'object') return state;
  const r = raw as Partial<ContinuityState>;
  state.defaults = { ...state.defaults, ...(r.defaults ?? {}) };
  state.accounts = r.accounts && typeof r.accounts === 'object' ? r.accounts : {};
  for (const [id, s] of Object.entries(r.sessions ?? {})) {
    state.sessions[id] = {
      ...emptySession(),
      ...s,
      // A handoff saved before these fields existed.
      handoff: s?.handoff ? Object.assign({ briefPath: s.handoff.briefFile, briefNote: null, interrupt: s.handoff.trigger === 'hard', interruptedAt: null, resent: 0 }, s.handoff) : null,
      override: s?.override ?? {},
      resumedAt: Array.isArray(s?.resumedAt) ? s.resumedAt : [],
      history: Array.isArray(s?.history) ? s.history : [],
      failedHandoff: s?.failedHandoff ?? null,
    };
  }
  return state;
}

const DROP_NOTICES: Partial<Record<DropReason, MessageKey>> = {
  cli_not_running: 'continuity.push.resetCliGone',
  prompt_waiting: 'continuity.push.resetPromptWaiting',
  daily_cap: 'continuity.push.resetDailyCap',
  cli_did_not_resume: 'continuity.push.resetCliDidNotResume',
};

export function formatWakeTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (at.getTime() - now.getTime() < 20 * 60 * 60_000) return time;
  return `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

export type ContinuityRefusal = { ok: false; status: 400 | 404 | 409; code: ErrorCode; message: string; params?: Record<string, string> };
export type ContinuityResult = { ok: true; view: SessionContinuityResponse } | ContinuityRefusal;

export type Continuity = {
  start(): Promise<void>;
  stop(): void;
  // One look at every session: low quota (handoff mode) and new limit hits.
  // Also drops the state of sessions that no longer exist.
  scan(): Promise<void>;
  // Acts on every carry-on that is due. Runs off the timer.
  runDue(): Promise<void>;
  // Moves every handoff in progress one step on.
  advanceHandoffs(): Promise<void>;
  getDefaults(): Promise<ContinuityDefaults>;
  // When this account is known to be over its limit, the time it resets
  // (from the hits seen on it); null otherwise or once that time is past.
  accountLimitedUntil(accountId: string): Promise<string | null>;
  setDefaults(patch: Partial<ContinuityDefaults>): Promise<ContinuityDefaults>;
  getSession(sessionId: string): Promise<SessionContinuityResponse>;
  // null clears a field back to the default.
  setSession(sessionId: string, patch: { [K in keyof ContinuityOverride]?: ContinuityOverride[K] | null }): Promise<SessionContinuityResponse>;
  cancelPending(sessionId: string): Promise<SessionContinuityResponse>;
  startHandoff(sessionId: string, request: StartHandoffRequest): Promise<ContinuityResult>;
  // The switch waiting for a reply that can't be interrupted safely: end
  // the CLI being left now (its pane reset) and switch.
  forceHandoffSwitch(sessionId: string): Promise<ContinuityResult>;
  // While a handoff waits for the turn to end: stop the reply instead.
  interruptHandoff(sessionId: string): Promise<ContinuityResult>;
  // While the CLI being left writes its brief (or is waited on to): don't
  // wait for it, the app writes the brief.
  skipHandoffBrief(sessionId: string): Promise<ContinuityResult>;
  confirmHandoff(sessionId: string): Promise<ContinuityResult>;
  // The CLI taking over has reported back: the user is done with the
  // handoff without telling it anything (nothing is sent).
  dismissHandoff(sessionId: string): Promise<ContinuityResult>;
  cancelHandoff(sessionId: string): Promise<SessionContinuityResponse>;
  // A handoff whose CLI never took over: start its profile (or another)
  // in the tmux again with the same brief (ADR 0030).
  relaunchHandoff(sessionId: string, request: RelaunchHandoffRequest): Promise<ContinuityResult>;
  // Forget that failed handoff (the user dealt with it).
  dismissFailedHandoff(sessionId: string): Promise<SessionContinuityResponse>;
};

export function createContinuity(ports: ContinuityPorts, store: JsonFileStore<ContinuityState>): Continuity {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let handoffTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // Scans, due carry-ons, handoff steps and API edits all
  // read-modify-write one file; one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  function record(session: SessionState, kind: ContinuityEventKind, detail: string | null, now: Date, handoffId?: string): void {
    session.history.push({ at: now.toISOString(), kind, detail, ...(handoffId ? { handoffId } : {}) });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
  }

  function notify(sessionId: string, body: string): void {
    void ports.notify(sessionId, body).catch((err: unknown) => console.warn('[continuity] notify failed', err));
  }

  async function view(state: ContinuityState, sessionId: string): Promise<SessionContinuityResponse> {
    const session = state.sessions[sessionId] ?? emptySession();
    return {
      effective: effectivePolicy(state.defaults, session.override),
      override: structuredClone(session.override),
      pending: session.pending,
      handoff: session.handoff,
      history: [...session.history],
      selfBrief: await selfBrief(sessionId),
      failedHandoff: session.failedHandoff,
    };
  }

  // Whether the conversation running now ends on a usage limit that hasn't
  // reset: its CLI can't answer, so it can't write a brief.
  async function limitedNow(sessionId: string, conversationId: string, now: Date): Promise<boolean> {
    const hit = await ports.readLimitHit(sessionId).catch(() => null);
    return hit?.conversationId === conversationId && !(hit.hit.resetsAt && Date.parse(hit.hit.resetsAt) <= now.getTime());
  }

  async function selfBrief(sessionId: string): Promise<NonNullable<SessionContinuityResponse['selfBrief']>> {
    const seen = await ports.readSession(sessionId).catch(() => null);
    if (!seen?.running || seen.conversationId === null) return { available: false, reason: 'cli_not_running' };
    if (await limitedNow(sessionId, seen.conversationId, ports.now())) return { available: false, reason: 'limit_hit' };
    return { available: true, reason: null };
  }

  function handoffContext(state: ContinuityState, sessionId: string, session: SessionState, now: Date): HandoffContext {
    return {
      ports,
      policy: effectivePolicy(state.defaults, session.override),
      now,
      record: (kind, detail, handoffId) => record(session, kind, detail, now, handoffId),
      notify: (body) => notify(sessionId, body),
    };
  }

  function sessionOf(state: ContinuityState, sessionId: string): SessionState {
    state.sessions[sessionId] ??= emptySession();
    return state.sessions[sessionId];
  }

  async function arm(): Promise<void> {
    if (!running) return;
    if (timer) clearTimeout(timer);
    const state = await store.load();
    const due = Object.values(state.sessions).map((s) => s.pending?.wakeAt).filter((at): at is string => !!at).map(Date.parse);
    const delay = due.length ? Math.max(0, Math.min(...due) - ports.now().getTime()) : MAX_TIMER_MS;
    timer = setTimeout(() => {
      timer = null;
      void runDue().catch((err: unknown) => console.error('[continuity] due run failed', err)).finally(() => void arm());
    }, Math.min(delay, MAX_TIMER_MS));
    timer.unref?.();
  }

  // The chain's next profile for this session, from what is known of each
  // account now; null when nobody can take over.
  async function pickTarget(state: ContinuityState, policy: ContinuityDefaults, seen: SessionView, now: Date): Promise<{ id: string; label: string } | null> {
    const profiles = await ports.listProfiles();
    const candidates: ProfileCandidate[] = [];
    for (const profile of profiles) {
      if (!policy.chain.includes(profile.id)) continue;
      const quota = profile.accountId ? await ports.readQuota(profile.accountId) : null;
      const limited = profile.accountId ? state.accounts[profile.accountId]?.limitedUntil ?? null : null;
      candidates.push({ id: profile.id, accountId: profile.accountId, remainingPercent: quota?.remainingPercent ?? null, limitedUntil: limited });
    }
    const id = selectTarget({
      chain: policy.chain, currentProfileId: seen.profileId, currentAccountId: seen.accountId,
      candidates, softRemainingPercent: policy.softRemainingPercent, now,
    });
    const profile = id ? profiles.find((p) => p.id === id) : undefined;
    return profile ? { id: profile.id, label: profile.label } : null;
  }

  async function startHandoffNow(
    state: ContinuityState, sessionId: string, session: SessionState, seen: SessionView & { conversationId: string },
    trigger: HandoffTrigger, target: { id: string; label: string }, now: Date, interrupt = false,
    choices: { source?: HandoffSource; confirm?: HandoffConfirm; permissionMode?: PermissionMode } = {},
  ): Promise<void> {
    session.pending = null;
    session.failedHandoff = null;
    session.handoff = await beginHandoff(handoffContext(state, sessionId, session, now), sessionId, {
      trigger, view: seen, toProfileId: target.id, toLabel: target.label, interrupt, ...choices,
    });
  }

  async function scanOnce(): Promise<boolean> {
    const state = await store.load();
    const ids = await ports.listSessionIds();
    let changed = false;
    for (const id of Object.keys(state.sessions)) {
      if (!ids.includes(id)) {
        delete state.sessions[id];
        changed = true;
      }
    }
    const now = ports.now();
    for (const [account, { limitedUntil }] of Object.entries(state.accounts)) {
      if (Date.parse(limitedUntil) <= now.getTime()) {
        delete state.accounts[account];
        changed = true;
      }
    }
    for (const id of ids) {
      try {
        if (await recoverLostHandoff(state, id)) changed = true;
        if (await scanSession(state, id)) changed = true;
      } catch (err) {
        console.error(`[continuity] scan of session ${id} failed`, err);
      }
    }
    if (changed) await store.save(state);
    return changed;
  }

  // A handoff recorded as done before the launch guard (ADR 0030) whose
  // CLI never took over: the last thing continuity did here, recent, and
  // the conversation it started ended by the CLI quitting with no turn at
  // all, with nothing started in the tmux since. Read again once as a
  // failure: one whose pane says the CLI quit to restart after updating is
  // started again (same profile and mode, same brief), as a live handoff
  // would be; any other is offered to the user to start again. Its events
  // then come after the handoff_done, so it is never read twice.
  async function recoverLostHandoff(state: ContinuityState, sessionId: string): Promise<boolean> {
    const session = state.sessions[sessionId];
    const done = session?.history.at(-1);
    if (!session || session.handoff || session.failedHandoff || session.pending || done?.kind !== 'handoff_done' || !done.handoffId) return false;
    const now = ports.now();
    const doneAt = Date.parse(done.at);
    if (!(now.getTime() - doneAt <= LOST_HANDOFF_WINDOW_MS)) return false;
    const seen = await ports.readSession(sessionId);
    if (!seen || seen.running || seen.switching || seen.conversationId !== null) return false;
    const started = await ports.readHandoffConversation(sessionId, done.handoffId);
    if (!started?.latest || started.turns > 0 || started.endReason !== 'cli_exit' || !started.endedAt || !started.profileId) return false;
    if (Date.parse(started.endedAt) - doneAt > LOST_HANDOFF_EXIT_MS) return false;
    const segment = started.record;
    if (!segment.trigger || !segment.fromConversationId || !segment.briefFile || !started.briefPath) return false;
    if (!(await ports.readBriefMeta(sessionId, segment.briefFile).catch(() => null))) return false;
    const label = (await ports.listProfiles()).find((profile) => profile.id === started.profileId)?.label ?? started.profileId;
    const at = now.toISOString();
    const handoff: ContinuityHandoff = {
      id: done.handoffId, trigger: segment.trigger, fromConversationId: segment.fromConversationId, toConversationId: null,
      fromProfileId: null, toProfileId: started.profileId, toLabel: label,
      ...(segment.source ? { source: segment.source } : {}), ...(segment.confirm ? { confirm: segment.confirm } : {}),
      ...(started.permissionMode ? { permissionMode: started.permissionMode } : {}),
      stage: 'switching', briefFile: segment.briefFile, briefPath: started.briefPath, briefSource: segment.briefSource, briefNote: segment.briefNote, briefNoteCode: segment.briefNoteCode ?? null,
      interrupt: false, interruptedAt: null, startedAt: at, stageSince: at, sentAt: null, resent: 0,
      relaunch: true, guard: newLaunchGuard(),
    };
    const reason = t('continuity.handoff.exitedMarkedDone');
    record(session, 'handoff_failed', reason, now, done.handoffId);
    const after = afterExit(await ports.readScreen(sessionId), newLaunchGuard());
    if (after.relaunch) {
      session.handoff = { ...handoff, guard: { ...newLaunchGuard(), relaunches: 1, tail: after.tail } };
      record(session, 'handoff_relaunched', t('continuity.handoff.relaunchedAfterUpdate', { label }), now, done.handoffId);
      notify(sessionId, t('continuity.push.earlierRelaunched', { label }));
    } else {
      session.failedHandoff = failedRecord(handoff, reason, after.tail, now);
      notify(sessionId, t('continuity.push.earlierFailed', { label, reason }));
    }
    return true;
  }

  async function scanSession(state: ContinuityState, sessionId: string): Promise<boolean> {
    const seen = await ports.readSession(sessionId);
    if (!seen?.running || seen.switching || seen.conversationId === null) return false;
    const conversationId = seen.conversationId;
    const current = { ...seen, conversationId };
    const existing = state.sessions[sessionId];
    // A handoff in progress is driven by advanceHandoffs.
    if (existing?.handoff) return false;
    const policy = effectivePolicy(state.defaults, existing?.override ?? {});
    const now = ports.now();
    if (await watchQuota(state, sessionId, policy, current, now)) return true;
    // A turn still going (or a CLI coming up) may yet move past a hit.
    if (seen.phase !== 'idle') return false;
    const found = await ports.readLimitHit(sessionId);
    if (!found) return false;
    if (existing?.lastHit?.conversationId === found.conversationId && existing.lastHit.at === found.hit.at) return false;
    const session = sessionOf(state, sessionId);
    session.lastHit = { conversationId: found.conversationId, at: found.hit.at };
    if (seen.accountId && found.hit.resetsAt && Date.parse(found.hit.resetsAt) > now.getTime()) {
      state.accounts[seen.accountId] = { limitedUntil: found.hit.resetsAt };
    }
    session.resumedAt = resumesWithinDay(session.resumedAt, now);
    const cliResumesAt = found.hit.cliResumesAt ?? null;
    const plan = cliResumesAt
      ? planForCliResume(policy, cliResumesAt, now)
      : planForHit(policy, found.hit, session.resumedAt.length, now);
    const what = found.hit.message || found.hit.limitType || 'usage limit';
    if (plan.kind !== 'ignore' && plan.kind !== 'stale' && policy.mode === 'handoff' && session.noHandoffFor !== conversationId) {
      const target = await pickTarget(state, policy, current, now);
      if (target) {
        notify(sessionId, t('continuity.push.limitHandoff', { label: target.label }));
        await startHandoffNow(state, sessionId, session, current, 'limit_hit', target, now);
        return true;
      }
      record(session, 'no_target', what, now);
    }
    switch (plan.kind) {
      case 'ignore':
        record(session, 'detected', what, now);
        break;
      case 'stale':
        record(session, 'detected', `stale: ${what}`, now);
        break;
      case 'schedule':
        if (cliResumesAt) {
          session.pending = { conversationId: found.conversationId, hit: found.hit, wakeAt: plan.wakeAt, postponed: 0, by: 'cli' };
          record(session, 'cli_will_resume', cliResumesAt, now);
          notify(sessionId, t('continuity.push.limitCliResumes', { time: formatWakeTime(cliResumesAt, now) }));
          break;
        }
        session.pending = { conversationId: found.conversationId, hit: found.hit, wakeAt: plan.wakeAt, postponed: 0 };
        record(session, 'scheduled', plan.wakeAt, now);
        notify(sessionId, t('continuity.push.limitScheduled', { time: formatWakeTime(plan.wakeAt, now) }));
        break;
      case 'no_reset_time':
        session.pending = null;
        record(session, 'no_reset_time', what, now);
        notify(sessionId, t('continuity.push.limitNoResetTime'));
        break;
      case 'daily_cap':
        session.pending = null;
        record(session, 'daily_cap', String(plan.count), now);
        notify(sessionId, t('continuity.push.limitDailyCap', { count: plan.count }));
        break;
    }
    return true;
  }

  // Handoff mode: hand over before the limit is hit. Once per conversation.
  async function watchQuota(
    state: ContinuityState, sessionId: string, policy: ContinuityDefaults, seen: SessionView & { conversationId: string }, now: Date,
  ): Promise<boolean> {
    if (policy.mode !== 'handoff' || !seen.accountId) return false;
    const existing = state.sessions[sessionId];
    if (existing?.monitored === seen.conversationId || existing?.pending) return false;
    const quota = await ports.readQuota(seen.accountId);
    const remaining = quota?.remainingPercent ?? null;
    const decision = monitorDecision({ policy, phase: seen.phase, remainingPercent: remaining, lastTurnAt: seen.lastTurnAt, now });
    if (decision === 'refresh') ports.refreshQuota();
    if (decision !== 'soft' && decision !== 'hard') return false;
    const session = sessionOf(state, sessionId);
    session.monitored = seen.conversationId;
    const target = await pickTarget(state, policy, seen, now);
    if (!target) {
      record(session, 'no_target', `${remaining}%`, now);
      notify(sessionId, t('continuity.push.lowNoTarget', { remaining }));
      return true;
    }
    notify(sessionId, t('continuity.push.lowHandoff', { remaining, label: target.label }));
    await startHandoffNow(state, sessionId, session, seen, decision, target, now);
    return true;
  }

  async function wakeSession(state: ContinuityState, sessionId: string, session: SessionState, pending: ContinuityPending): Promise<void> {
    const now = ports.now();
    session.resumedAt = resumesWithinDay(session.resumedAt, now);
    const policy = effectivePolicy(state.defaults, session.override);
    const seen = await ports.readSession(sessionId);
    const current = seen?.running ? await ports.readLimitHit(sessionId) : null;
    const observed = {
      policy, session: seen, currentHit: current?.conversationId === pending.conversationId ? current.hit : null, recentResumes: session.resumedAt.length,
    };
    if (pending.by === 'cli') {
      const checked = decideCliWake(pending, observed);
      session.pending = null;
      if (checked.kind === 'resumed') {
        record(session, 'resumed', 'cli', now);
        return;
      }
      record(session, 'dropped', checked.reason, now);
      const notice = DROP_NOTICES[checked.reason];
      if (notice) notify(sessionId, t(notice));
      if (checked.reason === 'session_gone') delete state.sessions[sessionId];
      return;
    }
    let decision = decideWake(pending, observed, now);
    if (decision.kind === 'send') {
      const outcome = await ports.send(sessionId, policy.resumePrompt);
      if (outcome.status === 'sent') {
        session.pending = null;
        session.resumedAt.push(now.toISOString());
        record(session, 'resumed', null, now);
        notify(sessionId, t('continuity.push.resumed'));
        return;
      }
      if (outcome.status === 'failed') {
        session.pending = null;
        record(session, 'send_failed', outcome.reason, now);
        notify(sessionId, t('continuity.push.resumeFailed', { reason: outcome.reason }));
        return;
      }
      decision = postponeOrDrop(pending, now);
    }
    if (decision.kind === 'postpone') {
      session.pending = { ...pending, wakeAt: decision.wakeAt, postponed: pending.postponed + 1 };
      record(session, 'postponed', decision.wakeAt, now);
      return;
    }
    if (decision.kind === 'drop') {
      session.pending = null;
      record(session, 'dropped', decision.reason, now);
      const notice = DROP_NOTICES[decision.reason];
      if (notice) notify(sessionId, t(notice));
      if (decision.reason === 'session_gone') delete state.sessions[sessionId];
    }
  }

  async function runDueOnce(): Promise<void> {
    const state = await store.load();
    const now = ports.now().getTime();
    let changed = false;
    for (const [id, session] of Object.entries(state.sessions)) {
      const pending = session.pending;
      if (!pending || Date.parse(pending.wakeAt) > now) continue;
      try {
        await wakeSession(state, id, session, pending);
      } catch (err) {
        console.error(`[continuity] carry-on for session ${id} failed`, err);
        session.pending = null;
        record(session, 'send_failed', (err as Error).message, ports.now());
      }
      changed = true;
    }
    if (changed) await store.save(state);
  }

  // After the CLI taking over quit without taking over: the chain's next
  // profile nobody has tried in this handoff, started in the free tmux
  // with the same brief. Only for a handoff the app started itself; the
  // user's own choice of profile is theirs to change.
  async function nextAttempt(state: ContinuityState, sessionId: string, session: SessionState, handoff: ContinuityHandoff, now: Date): Promise<ContinuityHandoff | null> {
    if (handoff.trigger === 'manual') return null;
    const policy = effectivePolicy(state.defaults, session.override);
    if (policy.mode !== 'handoff') return null;
    const seen = await ports.readSession(sessionId);
    if (!seen || seen.running || seen.switching) return null;
    const tried = [...new Set([...(handoff.tried ?? []), handoff.toProfileId])];
    const left = { ...policy, chain: policy.chain.filter((profileId) => !tried.includes(profileId) && profileId !== handoff.fromProfileId) };
    const from = handoff.fromProfileId ? (await ports.listProfiles()).find((profile) => profile.id === handoff.fromProfileId) : undefined;
    const target = await pickTarget(state, left, { ...seen, profileId: handoff.fromProfileId, accountId: from?.accountId ?? null }, now);
    if (!target) return null;
    const at = now.toISOString();
    return {
      ...handoff, toProfileId: target.id, toLabel: target.label, tried, relaunch: true,
      stage: 'switching', stageSince: at, sentAt: null, resent: 0, toConversationId: null, deliveredAt: null, segmentMarked: false,
      switchBlocked: null, guard: newLaunchGuard(),
    };
  }

  function failedRecord(handoff: ContinuityHandoff, reason: string, tail: string | null, now: Date): FailedHandoff {
    return {
      handoffId: handoff.id, at: now.toISOString(), reason, tail,
      fromConversationId: handoff.fromConversationId, fromProfileId: handoff.fromProfileId,
      toProfileId: handoff.toProfileId, toLabel: handoff.toLabel,
      briefFile: handoff.briefFile, briefPath: handoff.briefPath, briefSource: handoff.briefSource, briefNote: handoff.briefNote, briefNoteCode: handoff.briefNoteCode ?? null,
      ...(handoff.source ? { source: handoff.source } : {}),
      ...(handoff.confirm ? { confirm: handoff.confirm } : {}),
      ...(handoff.permissionMode ? { permissionMode: handoff.permissionMode } : {}),
    };
  }

  async function advanceHandoffsOnce(): Promise<void> {
    const state = await store.load();
    let changed = false;
    for (const [id, session] of Object.entries(state.sessions)) {
      const handoff = session.handoff;
      if (!handoff) continue;
      const now = ports.now();
      let outcome: Awaited<ReturnType<typeof advanceHandoff>>;
      try {
        outcome = await advanceHandoff(handoffContext(state, id, session, now), id, handoff);
      } catch (err) {
        console.error(`[continuity] handoff for session ${id} failed`, err);
        outcome = { kind: 'failed', reason: (err as Error).message };
      }
      if (outcome.kind === 'continue') {
        if (JSON.stringify(outcome.handoff) === JSON.stringify(handoff)) continue;
        session.handoff = outcome.handoff;
      } else if (outcome.kind === 'done') {
        session.handoff = null;
        record(session, 'handoff_done', handoff.toLabel, now, handoff.id);
      } else {
        record(session, 'handoff_failed', outcome.reason, now, handoff.id);
        // The CLI taking over never took over and the tmux is free: an
        // automatic handoff goes on to the chain's next profile (ADR 0030).
        const next = outcome.bare ? await nextAttempt(state, id, session, handoff, now) : null;
        if (next) {
          session.handoff = next;
          record(session, 'handoff_relaunched', `→ ${next.toLabel}`, now, handoff.id);
          notify(id, t('continuity.push.nextTarget', { label: handoff.toLabel, reason: outcome.reason, next: next.toLabel }));
          changed = true;
          continue;
        }
        session.handoff = null;
        // Once its brief is written, it can be started again with it.
        session.failedHandoff = handoff.briefSource !== null ? failedRecord(handoff, outcome.reason, outcome.tail ?? null, now) : null;
        // The screen's last lines say what happened; a few go with the notice.
        const tail = outcome.tail ? `\n${outcome.tail.split('\n').slice(-4).join('\n')}` : '';
        notify(id, `${t('continuity.push.handoffFailed', { label: handoff.toLabel, reason: outcome.reason })}${tail}`);
        if (handoff.trigger === 'limit_hit') {
          // Wait for the reset instead: the next scan plans the hit again.
          session.noHandoffFor = handoff.fromConversationId;
          session.lastHit = null;
        }
      }
      changed = true;
    }
    if (changed) await store.save(state);
  }

  const scan = () => serial(async () => {
    if (await scanOnce()) await arm();
  });
  const runDue = () => serial(runDueOnce);
  const advanceHandoffs = () => serial(advanceHandoffsOnce);

  function edit(sessionId: string, change: (session: SessionState, state: ContinuityState) => void): Promise<SessionContinuityResponse> {
    return serial(async () => {
      const state = await store.load();
      change(sessionOf(state, sessionId), state);
      await store.save(state);
      await arm();
      return await view(state, sessionId);
    });
  }

  const refuse = (status: 400 | 404 | 409, code: ErrorCode, message: string, params?: Record<string, string>): ContinuityRefusal => (
    { ok: false, status, code, message, ...(params ? { params } : {}) }
  );

  return {
    async start() {
      running = true;
      await scan();
      await runDue();
      await arm();
      scanTimer = setInterval(() => {
        void scan().catch((err: unknown) => console.error('[continuity] scan failed', err));
      }, SCAN_INTERVAL_MS);
      scanTimer.unref?.();
      handoffTimer = setInterval(() => {
        void advanceHandoffs().catch((err: unknown) => console.error('[continuity] handoff step failed', err));
      }, HANDOFF_TICK_MS);
      handoffTimer.unref?.();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      if (scanTimer) clearInterval(scanTimer);
      if (handoffTimer) clearInterval(handoffTimer);
      timer = null;
      scanTimer = null;
      handoffTimer = null;
    },
    scan,
    runDue,
    advanceHandoffs,
    async getDefaults() {
      return structuredClone((await store.load()).defaults);
    },
    async accountLimitedUntil(accountId) {
      const until = (await store.load()).accounts[accountId]?.limitedUntil;
      return until && Date.parse(until) > ports.now().getTime() ? until : null;
    },
    setDefaults(patch) {
      return serial(async () => {
        const state = await store.load();
        state.defaults = { ...state.defaults, ...patch };
        await store.save(state);
        return structuredClone(state.defaults);
      });
    },
    async getSession(sessionId) {
      return view(await store.load(), sessionId);
    },
    setSession(sessionId, patch) {
      return edit(sessionId, (session) => {
        const override: Record<string, unknown> = { ...session.override };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === undefined) delete override[key];
          else override[key] = value;
        }
        session.override = override as ContinuityOverride;
      });
    },
    cancelPending(sessionId) {
      return edit(sessionId, (session) => {
        if (!session.pending) return;
        session.pending = null;
        record(session, 'cancelled', null, ports.now());
      });
    },
    startHandoff(sessionId, request) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const seen = await ports.readSession(sessionId);
        if (!seen) return refuse(404, 'not_found', 'not found');
        if (!seen.running || seen.conversationId === null) return refuse(409, 'no_running_cli', 'no running CLI to hand off', { status: seen.running ? 'starting' : 'not_running' });
        if (state.sessions[sessionId]?.handoff || seen.switching) return refuse(409, 'handoff_in_progress', 'a handoff or relaunch is already in progress');
        const session = sessionOf(state, sessionId);
        const policy = effectivePolicy(state.defaults, session.override);
        const now = ports.now();
        let target: { id: string; label: string } | null;
        if (request.toProfileId) {
          const profile = (await ports.listProfiles()).find((p) => p.id === request.toProfileId);
          if (!profile) return refuse(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
          if (profile.id === seen.profileId) return refuse(400, 'invalid_request', 'that is the profile already running');
          target = { id: profile.id, label: profile.label };
        } else {
          target = await pickTarget(state, policy, seen, now);
          if (!target) return refuse(409, 'no_handoff_target', 'no profile in the chain can take over now');
        }
        // A conversation that ends on a limit hit can't answer any more: the
        // handoff is a limit hit's, and the app writes the brief at once.
        // (One whose limit has reset since can write its own again.)
        const limited = await limitedNow(sessionId, seen.conversationId, now);
        const choices = {
          ...(request.briefBy ? { source: request.briefBy === 'incoming' ? 'incoming' as const : 'self_then_mechanical' as const } : {}),
          ...(request.afterReport ? { confirm: request.afterReport === 'wait' ? 'ask' as const : 'auto' as const } : {}),
          ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        };
        await startHandoffNow(state, sessionId, session, { ...seen, conversationId: seen.conversationId }, limited ? 'limit_hit' : 'manual', target, now, !!request.interrupt, choices);
        notify(sessionId, t(limited ? 'continuity.push.outHandoff' : 'continuity.push.handoffStarted', { label: target.label }));
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    confirmHandoff(sessionId) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const session = state.sessions[sessionId];
        const handoff = session?.handoff;
        if (!session || handoff?.stage !== 'awaiting_confirmation') return refuse(409, 'handoff_not_awaiting', 'no handoff is waiting for confirmation');
        const now = ports.now();
        const sent = await confirmHandoff(handoffContext(state, sessionId, session, now), sessionId);
        if (!sent.ok) return refuse(409, 'handoff_send_failed', `could not send the go-ahead: ${sent.reason}`, { reason: sent.reason });
        session.handoff = null;
        record(session, 'handoff_done', handoff.toLabel, now, handoff.id);
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    dismissHandoff(sessionId) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const session = state.sessions[sessionId];
        const handoff = session?.handoff;
        if (!session || handoff?.stage !== 'awaiting_confirmation') return refuse(409, 'handoff_not_awaiting', 'no handoff has reported back');
        session.handoff = null;
        // Like a go-ahead's: who took it over (the history shows 交接完成：X).
        record(session, 'handoff_done', handoff.toLabel, ports.now(), handoff.id);
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    cancelHandoff(sessionId) {
      return edit(sessionId, (session) => {
        if (!session.handoff) return;
        record(session, 'handoff_cancelled', session.handoff.stage, ports.now(), session.handoff.id);
        session.handoff = null;
      });
    },
    skipHandoffBrief(sessionId) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const session = state.sessions[sessionId];
        if (session?.handoff?.stage !== 'writing_brief') return refuse(409, 'handoff_not_awaiting', 'no handoff is waiting for its brief');
        session.handoff = { ...session.handoff, skipBrief: true };
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    forceHandoffSwitch(sessionId) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const session = state.sessions[sessionId];
        const handoff = session?.handoff;
        if (!session || handoff?.stage !== 'switching' || handoff.sentAt || !handoff.switchBlocked) {
          return refuse(409, 'handoff_not_awaiting', 'no handoff is waiting to switch');
        }
        const current = await ports.readSession(sessionId);
        if (!current?.running || current.switching || current.conversationId !== handoff.fromConversationId) {
          return refuse(409, 'handoff_force_failed', 'the tmux moved to another conversation, or is switching, before the handoff');
        }
        const now = ports.now();
        const result = await ports.switchProfile(sessionId, handoff.toProfileId, {
          force: true, expectedConversationId: handoff.fromConversationId,
          ...(handoff.permissionMode ? { permissionMode: handoff.permissionMode } : {}),
        });
        if (!result.ok) return refuse(409, 'handoff_force_failed', `could not end the CLI being left: ${result.reason}`, { reason: result.reason });
        record(session, 'handoff_forced', handoff.toLabel, now, handoff.id);
        session.handoff = { ...handoff, sentAt: now.toISOString(), switchBlocked: null };
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    interruptHandoff(sessionId) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const session = state.sessions[sessionId];
        if (session?.handoff?.stage !== 'writing_brief') return refuse(409, 'handoff_not_awaiting', 'no handoff is waiting for the turn to end');
        session.handoff = interruptNow(session.handoff);
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    relaunchHandoff(sessionId, request) {
      return serial(async (): Promise<ContinuityResult> => {
        const state = await store.load();
        const session = state.sessions[sessionId];
        const failed = session?.failedHandoff;
        if (!session || !failed) return refuse(409, 'handoff_not_retryable', 'no handoff of this session failed to take over');
        if (request.briefFile !== failed.briefFile && request.briefFile !== failed.briefPath) {
          return refuse(400, 'invalid_request', 'that is not the failed handoff\'s brief');
        }
        const seen = await ports.readSession(sessionId);
        if (!seen) return refuse(404, 'not_found', 'not found');
        if (session.handoff || seen.switching) return refuse(409, 'handoff_in_progress', 'a handoff or relaunch is already in progress');
        const profile = (await ports.listProfiles()).find((candidate) => candidate.id === (request.toProfileId ?? failed.toProfileId));
        if (!profile) return refuse(400, 'launch_profile_unavailable', 'launch profile unavailable; refresh the launch options');
        if (!(await ports.readBriefMeta(sessionId, failed.briefFile).catch(() => null))) return refuse(409, 'handoff_brief_missing', 'the brief is no longer there');
        const now = ports.now();
        const at = now.toISOString();
        // A CLI still running (the one that got stuck) is ended by the
        // switch, as any handoff's; a free tmux just gets the profile.
        const running = seen.running && seen.conversationId !== null;
        const permissionMode = request.permissionMode ?? failed.permissionMode;
        session.handoff = {
          id: failed.handoffId, trigger: 'manual',
          fromConversationId: running ? seen.conversationId! : failed.fromConversationId, toConversationId: null,
          fromProfileId: running ? seen.profileId : failed.fromProfileId, toProfileId: profile.id, toLabel: profile.label,
          ...(failed.source ? { source: failed.source } : {}),
          ...(failed.confirm ? { confirm: failed.confirm } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          stage: 'switching', briefFile: failed.briefFile, briefPath: failed.briefPath, briefSource: failed.briefSource, briefNote: failed.briefNote, briefNoteCode: failed.briefNoteCode ?? null,
          interrupt: false, interruptedAt: null, startedAt: at, stageSince: at, sentAt: null, resent: 0,
          relaunch: !running, guard: newLaunchGuard(),
        };
        session.failedHandoff = null;
        record(session, 'handoff_started', `relaunch → ${profile.label}`, now, failed.handoffId);
        notify(sessionId, t('continuity.push.restartHandoff', { label: profile.label }));
        await store.save(state);
        return { ok: true, view: await view(state, sessionId) };
      });
    },
    dismissFailedHandoff(sessionId) {
      return edit(sessionId, (session) => {
        session.failedHandoff = null;
      });
    },
  };
}
