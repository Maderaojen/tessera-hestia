import type { ErrorCode } from '../contract/errors.js';
import type { LaunchOption } from '../contract/meta.js';
import type {
  ConversationRecapModelCatalog, ConversationRecapSettings, ConversationRecapSettingsResponse, ConversationRecapState,
  ConversationRecapView, RecapErrorCode, RecapStatus, SessionRecapsResponse,
} from '../contract/recap.js';
import type { Turn } from '../contract/sessions.js';
import type { JsonFileStore } from '@maderaojen/json-file-store';
import { RECAP_BATCH_TURNS, RECAP_IDLE_MS, RECAP_LIMIT_RECHECK_MS, recapBackoffMs } from './constants.js';
import type { RecapConversation, RecapPorts, RecapRunResult } from './ports.js';
import { buildRecapPrompt } from './prompt.js';
import { applyRecapSettingsPatch, type RecapSettingsState } from './settings-store.js';
import { recapProgress, type ConversationRecapFile, type RecapGenerator } from './store.js';

export type { RecapPorts } from './ports.js';

// Keeping every conversation's recap up to date in the background: which conversations are due, in
// what order, one CLI run at a time, and what a failure does. Knows nothing
// of tmux, the registry or any CLI: everything goes through RecapPorts
// (wiring.ts). The queue itself is never saved; it is worked out again from
// the conversations and their recaps (a request the user made is kept in
// the recap file), so a restart picks up where things were.

// The timer is re-armed at least this often, so a suspended machine or a
// clock change is caught up with.
const MAX_TIMER_MS = 60 * 60_000;
const PAUSE_CODES = new Set<RecapErrorCode>(['profile_unavailable', 'model_rejected', 'account_limited']);

export type RecapReason = 'manual' | 'new_turns' | 'backfill';
const PRIORITY: Record<RecapReason, number> = { manual: 3, new_turns: 2, backfill: 1 };

/** Recapping still to do for a conversation: from which turn, why, and from when. */
export type RecapWork = {
  kind: 'work';
  reason: RecapReason;
  // The turn (array position) the next batch starts at; 0 on a rebuild.
  startAt: number;
  rebuild: boolean;
  // When it may run (ms); Infinity while its reply is still being written.
  readyAt: number;
  // Within its priority, lower goes first.
  order: number;
};

export type RecapPlan = { kind: 'unavailable' | 'empty' | 'up_to_date' | 'not_created' } | RecapWork;

/** The turns that can be recapped: all but a last one still being replied to. */
export function completedTurns(conversation: Pick<RecapConversation, 'turns' | 'replying' | 'replyingTurnStored'>): Turn[] {
  const lastUnfinished = conversation.replying && conversation.replyingTurnStored !== false;
  return lastUnfinished ? conversation.turns.slice(0, -1) : conversation.turns;
}

const timeOf = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * What a conversation needs (§3.5's table). `changedAt`: when its turns last
 * changed (ms), or when the scheduler started if it hasn't seen them change.
 */
export function planRecap(input: {
  conversation: RecapConversation;
  recap: ConversationRecapFile | null;
  settings: Pick<RecapSettingsState, 'enabledAt' | 'backfillOld'>;
  changedAt: number;
}): RecapPlan {
  const { conversation, recap, settings, changedAt } = input;
  if (!conversation.provider) return { kind: 'unavailable' };
  const completed = completedTurns(conversation);
  if (completed.length === 0) return { kind: 'empty' };
  const idleAt = conversation.replying ? Infinity : changedAt + RECAP_IDLE_MS;
  const retryAt = timeOf(recap?.lastError?.retryAt) ?? 0;
  if (!recap) {
    // Without a recap, only a conversation with a turn from after the
    // recaps were turned on is recapped on its own, and then from its start.
    const enabledAt = timeOf(settings.enabledAt) ?? Infinity;
    if (completed.some((turn) => (timeOf(turn.user.at) ?? -Infinity) >= enabledAt)) {
      return { kind: 'work', reason: 'new_turns', startAt: 0, rebuild: false, readyAt: idleAt, order: changedAt };
    }
    if (!settings.backfillOld) return { kind: 'not_created' };
    const last = completed.at(-1)!;
    const lastAt = timeOf(last.assistant.at) ?? timeOf(last.user.at) ?? 0;
    return { kind: 'work', reason: 'backfill', startAt: 0, rebuild: false, readyAt: 0, order: -lastAt };
  }
  const progress = recapProgress(recap, conversation.turns);
  if (completed.length <= progress.coveredTurns) return { kind: 'up_to_date' };
  const base = { kind: 'work', startAt: progress.coveredTurns, rebuild: progress.rebuild } as const;
  const requestedAt = timeOf(recap.requestedAt);
  if (requestedAt !== null) {
    // A request runs right away, unless it already failed since it was made.
    const failedSince = (timeOf(recap.lastError?.at) ?? -Infinity) >= requestedAt;
    return { ...base, reason: 'manual', readyAt: failedSince ? retryAt : 0, order: requestedAt };
  }
  return { ...base, reason: 'new_turns', readyAt: Math.max(idleAt, retryAt), order: changedAt };
}

/** The state a conversation's recap is shown in (contract ConversationRecapState). */
export function recapState(input: {
  conversation: RecapConversation;
  recap: ConversationRecapFile | null;
  plan: RecapPlan;
  settings: Pick<RecapSettingsState, 'enabled' | 'pause'>;
  running: boolean;
  now: number;
}): ConversationRecapState {
  const { recap, plan, settings, now } = input;
  if (plan.kind === 'unavailable') return 'unavailable';
  if (!settings.enabled) return 'disabled';
  if (plan.kind === 'empty') return 'empty';
  if (input.running) return 'running';
  if (plan.kind !== 'work') return plan.kind;
  if (settings.pause) return 'paused';
  if (plan.readyAt <= now) return 'queued';
  const backingOff = (timeOf(recap?.lastError?.retryAt) ?? 0) > now;
  // Stopped part way is 'behind'; a failure before anything was recapped is 'failed'.
  if (backingOff) return plan.startAt > 0 ? 'behind' : 'failed';
  return 'waiting';
}

export type RecapRefusal = {
  ok: false;
  status: 400 | 404 | 409 | 502;
  code: ErrorCode;
  message: string;
  params?: Record<string, string>;
};
export type RecapResult<T> = { ok: true; value: T } | RecapRefusal;

const refuse = (status: RecapRefusal['status'], code: RecapRefusal['code'], message: string, params?: Record<string, string>): RecapRefusal => (
  { ok: false, status, code, message, ...(params ? { params } : {}) }
);

export type RecapScheduler = {
  // Reads every conversation once and starts working off the queue.
  start(): Promise<void>;
  stop(): void;
  // Works out every conversation's plan again (start-up, turning on).
  scan(): Promise<void>;
  // Runs whatever is due, one batch at a time, until nothing is.
  tick(): Promise<void>;
  // A conversation's turns changed: its idle wait starts over.
  conversationChanged(sessionId: string, conversationId: string): Promise<void>;
  // Something else about a session changed (a reply finished, it came back
  // from the trash): its conversations' plans are worked out again.
  sessionChanged(sessionId: string): Promise<void>;
  sessionRemoved(sessionId: string): void;

  getSettings(): Promise<ConversationRecapSettingsResponse>;
  updateSettings(patch: Partial<ConversationRecapSettings>): Promise<RecapResult<ConversationRecapSettingsResponse>>;
  listProfiles(): Promise<LaunchOption[]>;
  listModels(profileId: string, refresh: boolean): Promise<RecapResult<ConversationRecapModelCatalog>>;
  // null: no such session (or it is in the trash).
  sessionRecaps(sessionId: string): Promise<SessionRecapsResponse | null>;
  // The user's 更新／建立摘要: first in line, without the idle wait.
  refresh(sessionId: string, conversationId: string): Promise<RecapResult<ConversationRecapView>>;
  setItemStatus(sessionId: string, conversationId: string, itemId: string, status: RecapStatus): Promise<RecapResult<ConversationRecapView>>;
};

type Queued = { sessionId: string; conversationId: string; work: RecapWork };
type Outcome = { kind: 'done' } | { kind: 'stale' } | { kind: 'failed'; code: RecapErrorCode; until?: string | null; params?: Record<string, string> };

const keyOf = (sessionId: string, conversationId: string) => `${sessionId}\n${conversationId}`;
// The states a conversation rests in: not worth an event the first time
// they are seen (a scan would otherwise send one for every conversation).
const RESTING = new Set<ConversationRecapState>(['disabled', 'unavailable', 'empty', 'not_created', 'up_to_date']);

export function createRecapScheduler(ports: RecapPorts, store: JsonFileStore<RecapSettingsState>): RecapScheduler {
  const queue = new Map<string, Queued>();
  const changedAt = new Map<string, number>();
  const announced = new Map<string, string>();
  let startedAt = ports.now().getTime();
  let running: { sessionId: string; conversationId: string } | null = null;
  let ticking: Promise<void> | null = null;
  let again = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // When an account over its limit with no known reset was last looked at.
  let limitCheckedAt = 0;
  // Batches in a row whose answer couldn't be written because the recap or
  // the turns moved on meanwhile; past a few, it counts as a failure.
  const staleRuns = new Map<string, number>();
  const MAX_STALE_RUNS = 3;

  // Settings edits and pauses both read-modify-write the settings file; one at a time.
  let settingsQueue: Promise<unknown> = Promise.resolve();
  const editSettings = (edit: (state: RecapSettingsState) => RecapSettingsState): Promise<RecapSettingsState> => {
    const next = settingsQueue.then(async () => {
      const state = edit(structuredClone(await store.load()));
      await store.save(state);
      return state;
    });
    settingsQueue = next.catch(() => undefined);
    return next;
  };

  const nowMs = () => ports.now().getTime();
  const nowIso = () => ports.now().toISOString();
  const isRunning = (conversation: RecapConversation) => running?.sessionId === conversation.sessionId && running.conversationId === conversation.conversationId;
  const changedAtOf = (key: string) => changedAt.get(key) ?? startedAt;

  function planFor(conversation: RecapConversation, recap: ConversationRecapFile | null, settings: RecapSettingsState): RecapPlan {
    return planRecap({ conversation, recap, settings, changedAt: changedAtOf(keyOf(conversation.sessionId, conversation.conversationId)) });
  }

  function viewOf(conversation: RecapConversation, recap: ConversationRecapFile | null, plan: RecapPlan, settings: RecapSettingsState): ConversationRecapView {
    const totalTurns = conversation.provider ? completedTurns(conversation).length : 0;
    const covered = plan.kind === 'work' ? plan.startAt : recap ? recapProgress(recap, conversation.turns).coveredTurns : 0;
    const coveredTurns = Math.min(covered, totalTurns);
    const error = recap?.lastError ?? null;
    return {
      conversationId: conversation.conversationId,
      sequence: conversation.sequence,
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      provider: conversation.provider,
      available: conversation.provider !== null,
      totalTurns,
      coveredTurns,
      pendingTurns: Math.max(0, totalTurns - coveredTurns),
      state: recapState({ conversation, recap, plan, settings, running: isRunning(conversation), now: nowMs() }),
      items: recap?.items ?? [],
      updatedAt: recap?.updatedAt ?? null,
      generator: recap?.generator
        ? { profileLabel: recap.generator.profileLabel, runtimeId: recap.generator.runtimeId, model: recap.generator.model, effort: recap.generator.effort }
        : null,
      error: error ? { code: error.code, ...(error.params ? { params: error.params } : {}), retryAt: error.retryAt } : null,
      pause: settings.pause,
    };
  }

  // Sends a `recap` event when what a client shows of the conversation changed.
  function announce(conversation: RecapConversation, view: ConversationRecapView): void {
    const key = keyOf(conversation.sessionId, conversation.conversationId);
    const shown = `${view.state}|${view.coveredTurns}|${view.totalTurns}|${view.updatedAt}`;
    const before = announced.get(key);
    if (before === shown) return;
    announced.set(key, shown);
    if (before === undefined && RESTING.has(view.state)) return;
    ports.publish({
      type: 'recap', sessionId: conversation.sessionId, conversationId: conversation.conversationId,
      state: view.state, coveredTurns: view.coveredTurns, totalTurns: view.totalTurns, updatedAt: view.updatedAt,
    });
  }

  // Works out the conversation's plan again, keeps the queue to it, and
  // tells clients if that changed what they show.
  async function replan(conversation: RecapConversation, known?: ConversationRecapFile | null): Promise<{ plan: RecapPlan; recap: ConversationRecapFile | null }> {
    const key = keyOf(conversation.sessionId, conversation.conversationId);
    const settings = await store.load();
    let recap = known !== undefined ? known : conversation.provider ? await ports.readRecap(conversation) : null;
    const plan = planFor(conversation, recap, settings);
    if (plan.kind === 'work' && settings.enabled && !conversation.trashed) queue.set(key, { sessionId: conversation.sessionId, conversationId: conversation.conversationId, work: plan });
    else queue.delete(key);
    // Caught up: the user's request is done.
    if (plan.kind === 'up_to_date' && recap?.requestedAt) {
      recap = await ports.updateRecap(conversation, (current) => (current.requestedAt ? { ...current, requestedAt: null } : null));
    }
    if (settings.enabled && !conversation.trashed) announce(conversation, viewOf(conversation, recap, plan, settings));
    return { plan, recap };
  }

  async function replanQueued(): Promise<void> {
    for (const { sessionId, conversationId } of [...queue.values()]) {
      const conversation = await ports.getConversation(sessionId, conversationId);
      if (conversation) await replan(conversation);
      else queue.delete(keyOf(sessionId, conversationId));
    }
  }

  async function pause(code: RecapErrorCode, reportedUntil: string | null): Promise<void> {
    if (!PAUSE_CODES.has(code)) return;
    // A reset time already past says nothing more: looked at again later instead.
    const until = (timeOf(reportedUntil) ?? 0) > nowMs() ? reportedUntil : null;
    console.warn(`[recap] paused: ${code}${until ? ` until ${until}` : ''}`);
    limitCheckedAt = nowMs();
    await editSettings((state) => ({ ...state, pause: { code: code as NonNullable<RecapSettingsState['pause']>['code'], until, at: nowIso() } }));
    await replanQueued();
  }

  // An account over its limit lifts its own pause: at the reset time when
  // known, else once the account no longer looks limited. The others wait
  // for the user to pick another account or model.
  async function liftPause(settings: RecapSettingsState): Promise<boolean> {
    const current = settings.pause;
    if (!current || current.code !== 'account_limited' || !settings.profileId) return !current;
    const now = nowMs();
    const until = timeOf(current.until);
    if (until !== null) {
      if (until > now) return false;
    } else {
      if (now - Math.max(timeOf(current.at) ?? 0, limitCheckedAt) < RECAP_LIMIT_RECHECK_MS) return false;
      limitCheckedAt = now;
      const account = await ports.accountState(settings.profileId);
      if (account.available && account.limited) {
        const next = account.limited.until;
        if (next !== current.until) await editSettings((state) => ({ ...state, pause: state.pause && { ...state.pause, until: next } }));
        return false;
      }
    }
    await editSettings((state) => ({ ...state, pause: null }));
    console.warn('[recap] pause lifted');
    await replanQueued();
    return true;
  }

  async function runBatch(conversation: RecapConversation, recap: ConversationRecapFile | null, work: RecapWork, settings: RecapSettingsState, generator: RecapGenerator): Promise<Outcome> {
    const completed = completedTurns(conversation);
    const batch = completed.slice(work.startAt, work.startAt + RECAP_BATCH_TURNS);
    const prompt = buildRecapPrompt({ previous: recap?.items ?? [], turns: batch });
    // A malformed answer is tried once more straight away.
    for (let attempt = 0; ; attempt += 1) {
      const run: RecapRunResult = await ports.runBatch({ profileId: settings.profileId!, model: settings.model!, effort: settings.effort, prompt });
      let failure: Exclude<RecapRunResult, { ok: true }>;
      if (run.ok) {
        // Checked against the turns as they are now: they may have moved on.
        const latest = await ports.getConversation(conversation.sessionId, conversation.conversationId);
        const written = await ports.applyBatch(conversation, {
          output: run.output, batch, startAt: work.startAt, turns: latest?.turns ?? conversation.turns, generator, now: nowIso(),
          clearRequest: work.startAt + batch.length >= completed.length,
        });
        if (written.ok) return { kind: 'done' };
        console.warn(`[recap] ${conversation.sessionId}/${conversation.conversationId}: answer not written (${written.code}): ${written.reason}`);
        if (written.code === 'stale') return { kind: 'stale' };
        failure = { ok: false, code: 'invalid_output' };
      } else {
        failure = run;
      }
      if (failure.code === 'invalid_output' && attempt === 0) continue;
      return { kind: 'failed', code: failure.code, until: failure.until ?? null, ...(failure.params ? { params: failure.params } : {}) };
    }
  }

  async function runOne(sessionId: string, conversationId: string): Promise<void> {
    const conversation = await ports.getConversation(sessionId, conversationId);
    if (!conversation || conversation.trashed) {
      queue.delete(keyOf(sessionId, conversationId));
      return;
    }
    const { plan, recap } = await replan(conversation);
    if (plan.kind !== 'work' || plan.readyAt > nowMs()) return;
    const settings = await store.load();
    const account = await ports.accountState(settings.profileId!);
    if (!account.available) {
      await pause('profile_unavailable', null);
      return;
    }
    if (account.limited) {
      await pause('account_limited', account.limited.until);
      return;
    }
    const generator: RecapGenerator = {
      profileId: settings.profileId!, profileLabel: account.label, runtimeId: account.runtimeId, model: settings.model!, effort: settings.effort,
    };
    running = { sessionId, conversationId };
    let outcome: Outcome;
    try {
      announce(conversation, viewOf(conversation, recap, plan, settings));
      outcome = await runBatch(conversation, recap, plan, settings, generator);
    } catch (err) {
      console.error(`[recap] ${sessionId}/${conversationId}: batch failed`, err);
      outcome = { kind: 'failed', code: 'run_failed' };
    } finally {
      running = null;
    }
    const key = keyOf(sessionId, conversationId);
    const staleInARow = outcome.kind === 'stale' ? (staleRuns.get(key) ?? 0) + 1 : 0;
    if (staleInARow > 0 && staleInARow < MAX_STALE_RUNS) staleRuns.set(key, staleInARow);
    else staleRuns.delete(key);
    if (staleInARow >= MAX_STALE_RUNS) outcome = { kind: 'failed', code: 'run_failed' };
    if (outcome.kind === 'failed') {
      if (PAUSE_CODES.has(outcome.code)) {
        await pause(outcome.code, outcome.until ?? null);
      } else {
        const failed = outcome;
        const at = nowIso();
        await ports.updateRecap(conversation, (current) => {
          const failures = current.failures + 1;
          const retryAt = new Date(Date.parse(at) + recapBackoffMs(failures)).toISOString();
          return { ...current, failures, lastError: { code: failed.code, at, retryAt, ...(failed.params ? { params: failed.params } : {}) } };
        });
      }
    }
    const latest = await ports.getConversation(sessionId, conversationId);
    if (latest) await replan(latest);
    else queue.delete(key);
  }

  // The next due job by priority, then order; false when there is none.
  async function runNext(): Promise<boolean> {
    const settings = await store.load();
    if (!settings.enabled || !settings.profileId || !settings.model) return false;
    if (settings.pause && !(await liftPause(settings))) return false;
    const now = nowMs();
    const [next] = [...queue.values()]
      .filter((entry) => entry.work.readyAt <= now)
      .sort((a, b) => PRIORITY[b.work.reason] - PRIORITY[a.work.reason] || a.work.order - b.work.order);
    if (!next) return false;
    await runOne(next.sessionId, next.conversationId);
    return true;
  }

  async function arm(): Promise<void> {
    if (!started) return;
    if (timer) clearTimeout(timer);
    const settings = await store.load();
    const now = nowMs();
    const due: number[] = [...queue.values()].map((entry) => entry.work.readyAt).filter(Number.isFinite);
    if (settings.pause?.code === 'account_limited') {
      due.push(timeOf(settings.pause.until) ?? Math.max(timeOf(settings.pause.at) ?? 0, limitCheckedAt) + RECAP_LIMIT_RECHECK_MS);
    }
    const delay = due.length ? Math.max(0, Math.min(...due) - now) : MAX_TIMER_MS;
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, Math.min(delay, MAX_TIMER_MS));
    timer.unref?.();
  }

  function tick(): Promise<void> {
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      do {
        again = false;
        while (await runNext()) { /* the next one */ }
      } while (again);
    })().finally(() => {
      ticking = null;
      void arm().catch((err: unknown) => console.error('[recap] arming the timer failed', err));
    });
    return ticking;
  }

  function kick(): void {
    void tick().catch((err: unknown) => console.error('[recap] run failed', err));
  }

  async function scan(): Promise<void> {
    const settings = await store.load();
    if (!settings.enabled) {
      queue.clear();
      return;
    }
    const seen = new Set<string>();
    for (const conversation of await ports.listConversations()) {
      seen.add(keyOf(conversation.sessionId, conversation.conversationId));
      try {
        await replan(conversation);
      } catch (err) {
        console.error(`[recap] planning ${conversation.sessionId}/${conversation.conversationId} failed`, err);
      }
    }
    for (const key of queue.keys()) if (!seen.has(key)) queue.delete(key);
  }

  async function settingsResponse(): Promise<ConversationRecapSettingsResponse> {
    const { enabled, profileId, model, effort, backfillOld, enabledAt, pause: paused } = await store.load();
    const waiting = [...queue.values()].filter((entry) => !(running && entry.sessionId === running.sessionId && entry.conversationId === running.conversationId)).length;
    return { enabled, profileId, model, effort, backfillOld, enabledAt, pause: paused, queue: { running: running ? { ...running } : null, waiting } };
  }

  // A recap's account and model, checked against what the account offers now.
  async function checkChoice(choice: Pick<ConversationRecapSettings, 'profileId' | 'model' | 'effort'>): Promise<RecapRefusal | null> {
    if (choice.profileId === null) return choice.model === null ? null : refuse(400, 'invalid_request', 'a model needs an account (profileId)');
    if (!(await ports.listProfiles()).some((profile) => profile.id === choice.profileId)) {
      return refuse(400, 'launch_profile_unavailable', 'this launch profile is not available for recaps; refresh the profiles');
    }
    if (choice.model === null) return choice.effort === null ? null : refuse(400, 'invalid_request', 'an effort needs a model');
    const catalog = await models(choice.profileId, false);
    if (!catalog.ok) return catalog;
    const option = catalog.value.options.find((candidate) => candidate.id === choice.model);
    if (!option) return refuse(400, 'model_unknown', `no model "${choice.model}" for this account`, { model: choice.model });
    if (choice.effort !== null && !option.efforts.includes(choice.effort)) {
      return refuse(400, 'invalid_request', `${option.label} has no effort "${choice.effort}"`);
    }
    return null;
  }

  async function models(profileId: string, refresh: boolean): Promise<RecapResult<ConversationRecapModelCatalog>> {
    const profile = (await ports.listProfiles()).find((candidate) => candidate.id === profileId);
    if (!profile) return refuse(400, 'launch_profile_unavailable', 'this launch profile is not available for recaps; refresh the profiles');
    try {
      return { ok: true, value: await ports.listModels(profileId, refresh) };
    } catch (error) {
      const reason = (error as Error).message;
      return refuse(502, 'model_list_failed', `couldn't list ${profile.label}'s models: ${reason}`, { cli: profile.label, reason });
    }
  }

  async function findConversation(sessionId: string, conversationId: string): Promise<RecapResult<RecapConversation>> {
    const conversation = await ports.getConversation(sessionId, conversationId);
    if (!conversation || conversation.trashed) return refuse(404, 'not_found', 'not found');
    if (!conversation.provider) return refuse(409, 'recap_unavailable', 'this conversation has no provider, so it has no recap');
    return { ok: true, value: conversation };
  }

  return {
    async start() {
      started = true;
      startedAt = nowMs();
      await scan();
      kick();
    },

    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    scan,
    tick,

    async conversationChanged(sessionId, conversationId) {
      changedAt.set(keyOf(sessionId, conversationId), nowMs());
      // Off, nothing is planned: turning on scans everything anyway.
      if (!(await store.load()).enabled) return;
      const conversation = await ports.getConversation(sessionId, conversationId);
      if (conversation) await replan(conversation);
      kick();
    },

    async sessionChanged(sessionId) {
      if (!(await store.load()).enabled) return;
      for (const conversation of await ports.listSessionConversations(sessionId) ?? []) await replan(conversation);
      kick();
    },

    sessionRemoved(sessionId) {
      for (const [key, entry] of queue) if (entry.sessionId === sessionId) queue.delete(key);
    },

    getSettings: settingsResponse,

    async updateSettings(patch) {
      const before = await store.load();
      const merged = { ...before, ...patch };
      if (merged.enabled && (!merged.profileId || !merged.model)) {
        return refuse(400, 'invalid_request', 'turning recaps on needs an account (profileId) and a model');
      }
      // Turning off, or a change of anything else, needs no look at the account.
      if (patch.enabled === true || ['profileId', 'model', 'effort'].some((field) => field in patch)) {
        const refused = await checkChoice(merged);
        if (refused) return refused;
      }
      const next = await editSettings((state) => applyRecapSettingsPatch(state, patch, nowIso()));
      if (!next.enabled) {
        // Nothing more is started; a batch already running is let finish.
        queue.clear();
      } else if (!before.enabled || next.backfillOld !== before.backfillOld || (before.pause && !next.pause)) {
        await scan();
      }
      kick();
      return { ok: true, value: await settingsResponse() };
    },

    async listProfiles() {
      return ports.listProfiles();
    },

    listModels: models,

    async sessionRecaps(sessionId) {
      const conversations = await ports.listSessionConversations(sessionId);
      if (!conversations) return null;
      const settings = await store.load();
      const views = await Promise.all(conversations.map(async (conversation) => {
        const recap = conversation.provider ? await ports.readRecap(conversation) : null;
        return viewOf(conversation, recap, planFor(conversation, recap, settings), settings);
      }));
      return { enabled: settings.enabled, conversations: views.sort((a, b) => b.sequence - a.sequence) };
    },

    async refresh(sessionId, conversationId) {
      const settings = await store.load();
      if (!settings.enabled) return refuse(409, 'recap_disabled', 'conversation recaps are off');
      const found = await findConversation(sessionId, conversationId);
      if (!found.ok) return found;
      const conversation = found.value;
      let recap = await ports.readRecap(conversation);
      const before = planFor(conversation, recap, settings);
      if (before.kind === 'work' || before.kind === 'not_created') {
        const at = nowIso();
        recap = await ports.updateRecap(conversation, (current) => ({ ...current, requestedAt: at }));
      }
      const { plan } = await replan(conversation, recap);
      kick();
      return { ok: true, value: viewOf(conversation, recap, plan, await store.load()) };
    },

    async setItemStatus(sessionId, conversationId, itemId, status) {
      const found = await findConversation(sessionId, conversationId);
      if (!found.ok) return found;
      const conversation = found.value;
      const recap = await ports.setItemStatus(conversation, itemId, status, nowIso());
      if (!recap) return refuse(404, 'recap_item_not_found', 'no such recap item');
      const settings = await store.load();
      return { ok: true, value: viewOf(conversation, recap, planFor(conversation, recap, settings), settings) };
    },
  };
}
