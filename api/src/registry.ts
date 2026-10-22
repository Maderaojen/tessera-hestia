import { randomUUID } from 'node:crypto';
import { SESSION_PREFIX, TMUX_SOCKET } from './config.js';
import { UUID_SHAPE } from './ids.js';
import { isTrashed, type ConversationSegment, type LaunchProfileSnapshot, type ManagedSession, type Provider } from './types.js';
import { conversationResumeBlocked } from './runtimes/conversation-blocks.js';
import { getRuntimeDriver, runtimeForProvider, type RuntimeId } from './runtimes/index.js';
import { deadSessionRecovery, resumableRuntime } from './runtimes/resume.js';
import { lifecycleTransition } from './registry/lifecycle.js';
import { emptyActiveMirror, newSegment } from './registry/segments.js';
import * as store from './registry/store.js';
// Process-local dispatch ownership for every CLI transition (launch, clear
// or switch, resume): from the durable claim until the request has
// finished sending its one command, the poller must not judge the attempt.
// Launch cancellation and observation also own it through their resolution.
// Lost on restart by design — the poller then takes over from the durable
// state (docs/decisions/0010-runtime-transition-convergence.md).
type TransitionKind = 'launch' | 'clear' | 'resume';
const transitionOwners = new Set<string>();
const ownerKey = (kind: TransitionKind, id: string, attemptKey: string): string => `${kind}:${id}:${attemptKey}`;

// Takes a transition's in-process ownership for as long as its claim is
// being written: a write that fails gives the ownership back, since the
// claim never existed.
async function claimed<R>(key: string, write: Promise<R>): Promise<R> {
  try {
    return await write;
  } catch (error) {
    transitionOwners.delete(key);
    throw error;
  }
}

/** The tmux session a managed session with this id runs in. */
export function tmuxNameFor(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

// Records a new managed session, with no CLI yet. Its tmux must already
// exist (services/sessions.ts creates it first).
export async function createSession(cwd: string, projectId: string, sessionNumber = 1, id: string = randomUUID()): Promise<ManagedSession> {
  const session: ManagedSession = {
    id,
    tmuxName: tmuxNameFor(id),
    tmuxSocket: TMUX_SOCKET,
    cwd,
    projectId,
    alias: null,
    sessionNumber,
    createdAt: new Date().toISOString(),
    provider: null,
    providerSessionId: null,
    providerSessionFile: null,
    providerLaunchedAt: null,
    status: 'idle',
    turnPhase: 'idle',
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    lastError: null,
    pendingInteraction: null,
    turns: [],
    turnsSourceFile: null,
    launchProfile: null,
    activeConversationId: null,
    conversations: [],
    launchPending: null,
    resumePending: null,
    clearPending: null,
  };
  await store.commit(id, () => ({ next: session, result: undefined }));
  return session;
}

// Every reader outside the trash sees live sessions only: a trashed record
// (isTrashed) is as good as deleted for routes, polling, transitions,
// continuity, search and the event streams. The trash itself, and the few
// places that need every record, use getSessionRecord / listAllSessions.

export async function getSession(id: string): Promise<ManagedSession | undefined> {
  const session = await store.get(id);
  return session && !isTrashed(session) ? session : undefined;
}

export async function getConversation(sessionId: string, conversationId: string): Promise<ConversationSegment | undefined> {
  return (await getSession(sessionId))?.conversations?.find((conversation) => conversation.id === conversationId);
}

export async function listSessions(): Promise<ManagedSession[]> {
  return (await store.list()).filter((session) => !isTrashed(session));
}

/** The record whether or not it is in the trash. */
export async function getSessionRecord(id: string): Promise<ManagedSession | undefined> {
  return store.get(id);
}

/**
 * The tmux server a tmux name belongs on (tmux.ts SocketLookup): its
 * record's (null: the default server), or TMUX_SOCKET when no record has
 * the name yet — a session being opened now goes on this install's own.
 */
export async function tmuxSocketFor(tmuxName: string): Promise<string | null> {
  const session = (await store.list()).find((candidate) => candidate.tmuxName === tmuxName);
  return session ? (session.tmuxSocket ?? null) : TMUX_SOCKET;
}

/** Every record, trashed ones included. */
export async function listAllSessions(): Promise<ManagedSession[]> {
  return store.list();
}

export async function listTrashedSessions(): Promise<ManagedSession[]> {
  return (await store.list()).filter(isTrashed);
}

export async function updateSession(
  id: string,
  patch: Partial<ManagedSession>,
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current) return { result: undefined };
    const next = { ...current, ...patch };
    return { next, result: next };
  });
}

export function ownsResumeAttemptLocally(id: string, attemptId: string): boolean {
  return transitionOwners.has(ownerKey('resume', id, attemptId));
}

export function releaseResumeAttempt(id: string, attemptId: string): void {
  transitionOwners.delete(ownerKey('resume', id, attemptId));
}

function clearOwnerKey(id: string, attemptId: string): string {
  return ownerKey('clear', id, attemptId);
}

export function ownsClearAttemptLocally(id: string, attemptId: string): boolean {
  return transitionOwners.has(clearOwnerKey(id, attemptId));
}

export function releaseClearAttempt(id: string, attemptId: string): void {
  transitionOwners.delete(clearOwnerKey(id, attemptId));
}

export async function beginPendingClear(
  id: string,
  attempt: NonNullable<ManagedSession['clearPending']>,
): Promise<ManagedSession | null | undefined> {
  const key = clearOwnerKey(id, attempt.attemptId);
  return claimed(key, store.commit(id, (current) => {
    if (!current || isTrashed(current)) return { result: undefined };
    if (
      current.provider === null || current.status === 'dead' || current.status === 'launching'
      || current.launchPending || current.resumePending || current.clearPending
      || current.activeConversationId !== attempt.conversationId
    ) return { result: null };
    const active = current.conversations?.find((conversation) => conversation.id === attempt.conversationId);
    // The CLI being left; a handoff launches another one (attempt.provider).
    const expectedProvider = attempt.exitProvider ?? attempt.provider ?? 'claude';
    if (!active || active.provider !== expectedProvider || active.endedAt || !active.launchProfile || active.launchProfile.provider !== expectedProvider) return { result: null };
    const next = { ...current, ...lifecycleTransition(current, 'launching'), lastError: null, clearPending: {
      ...structuredClone(attempt), operation: 'clear' as const, newConversationId: attempt.newConversationId ?? randomUUID(),
    } };
    transitionOwners.add(key);
    return { next, result: next };
  }));
}

// Claims a switch to an earlier Claude conversation in this tmux (see
// PendingClearAttempt). Rechecked here, under the same claim as a
// /clear, so two confirmations can't race each other or a launch.
export async function beginConversationSwitch(
  id: string,
  attempt: NonNullable<ManagedSession['clearPending']> & { targetConversationId: string },
): Promise<ManagedSession | null | undefined> {
  const key = clearOwnerKey(id, attempt.attemptId);
  return claimed(key, store.commit(id, (current) => {
    if (!current || isTrashed(current)) return { result: undefined };
    if (current.status === 'launching' || current.launchPending || current.resumePending || current.clearPending) return { result: null };
    const target = current.conversations?.find((conversation) => conversation.id === attempt.targetConversationId);
    if (!target || conversationResumeBlocked(target) !== null) return { result: null };
    if (target.id === current.activeConversationId && !target.endedAt && current.status !== 'dead') return { result: null };
    const next = { ...current, ...lifecycleTransition(current, 'launching'), lastError: null, clearPending: { ...structuredClone(attempt), operation: 'conversation_switch' as const } };
    transitionOwners.add(key);
    return { next, result: next };
  }));
}

// A switch or a /clear waiting on the old CLI's exit:
// waiting_exit → awaiting_force (exit timed out / can't be requested), or
// awaiting_force → waiting_exit (the user allowed the forced pane reset;
// the fresh shell is then picked up exactly like a normal exit).
export async function setPendingExitPhase(
  id: string,
  attemptId: string,
  from: 'waiting_exit' | 'awaiting_force',
  to: 'waiting_exit' | 'awaiting_force',
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    const attempt = current?.clearPending;
    if (!current || !attempt || attempt.attemptId !== attemptId || attempt.phase !== from) return { result: undefined };
    const next = {
      ...current,
      clearPending: { ...attempt, phase: to, ...(to === 'waiting_exit' ? { exitRequestedAt: new Date().toISOString() } : {}) },
    };
    return { next, result: next };
  });
}

export async function beginPendingClearLaunch(id: string, attemptId: string): Promise<ManagedSession | undefined> {
  const key = clearOwnerKey(id, attemptId);
  return claimed(key, store.commit(id, (current) => {
    // awaiting_force too: the user may have exited the old CLI by hand while
    // the force prompt was up — a dead pane is a dead pane either way.
    if (
      !current || current.clearPending?.attemptId !== attemptId
      || (current.clearPending.phase !== 'waiting_exit' && current.clearPending.phase !== 'awaiting_force')
    ) return { result: undefined };
    const next = {
      ...current,
      clearPending: { ...current.clearPending, phase: 'launching' as const, delivery: 'launch_uncertain' as const, launchStartedAt: new Date().toISOString() },
    };
    transitionOwners.add(key);
    return { next, result: next };
  }));
}

export async function notePendingClearDelivery(
  id: string,
  attemptId: string,
  delivery: 'exit_uncertain' | 'launch_uncertain' | 'confirmed',
  lastError: string | null = null,
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current || current.clearPending?.attemptId !== attemptId) return { result: undefined };
    if (delivery === 'launch_uncertain' && current.clearPending.phase !== 'launching') return { result: undefined };
    if (delivery === 'exit_uncertain' && current.clearPending.phase !== 'waiting_exit') return { result: undefined };
    const next: ManagedSession = {
      ...current,
      lastError,
      clearPending: { ...current.clearPending, delivery },
    };
    return { next, result: next };
  });
}

export async function commitPendingClear(id: string, attemptId: string): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    const attempt = current?.clearPending;
    if (!current || !attempt || attempt.attemptId !== attemptId || attempt.phase !== 'launching') return { result: undefined };
    const next = attempt.targetConversationId
      ? committedConversationSwitch(current, attempt, attempt.targetConversationId)
      : committedClear(current, attempt);
    if (next) transitionOwners.delete(clearOwnerKey(id, attemptId));
    return { next, result: next };
  });
}

function committedClear(current: ManagedSession, attempt: NonNullable<ManagedSession['clearPending']>): ManagedSession | undefined {
  const conversations = [...(current.conversations ?? [])];
  const active = conversations.find((conversation) => conversation.id === attempt.conversationId);
  if (!active || active.provider !== (attempt.exitProvider ?? attempt.provider ?? 'claude') || active.endedAt) return undefined;
  if (attempt.newConversationId && conversations.some((conversation) => conversation.id === attempt.newConversationId)) return undefined;
  const startedAt = attempt.launchStartedAt ?? new Date().toISOString();
  const now = new Date().toISOString();
  const handoff = !!attempt.launchProfile;
  const segment = newSegment(conversations, {
    id: attempt.newConversationId ?? randomUUID(),
    provider: attempt.provider ?? active.provider,
    runtimeId: attempt.runtimeId ?? active.runtimeId ?? active.launchProfile?.runtimeId ?? runtimeForProvider(active.provider!),
    launchProfile: attempt.launchProfile
      ? structuredClone(attempt.launchProfile)
      : active.launchProfile ? { ...structuredClone(active.launchProfile), runtimeId: attempt.runtimeId ?? active.launchProfile.runtimeId } : null,
    providerSessionId: attempt.newProviderSessionId,
    startedAt,
    startReason: handoff ? 'provider_switch' : 'clear',
    transcriptTurnOffset: 0,
  });
  return {
    ...current,
    provider: attempt.provider ?? active.provider,
    runtimeId: attempt.runtimeId ?? active.runtimeId ?? active.launchProfile?.runtimeId ?? runtimeForProvider(active.provider!),
    providerSessionId: attempt.newProviderSessionId,
    providerSessionFile: null,
    providerLaunchedAt: startedAt,
    launchProfile: segment.launchProfile,
    activeConversationId: segment.id,
    conversations: conversations.map((conversation) => conversation.id === active.id
      ? { ...conversation, endedAt: now, endReason: handoff ? 'provider_switch' as const : 'clear' as const }
      : conversation).concat(segment),
    clearPending: null,
    startupPrompt: null,
    ...lifecycleTransition(current, 'ready'),
    lastError: null,
    ...emptyActiveMirror(),
  };
}

// A resumed CLI keeps writing the same transcript file (its runtime
// resumes in place), so the target is reopened as it was — its stored turns
// stay, and polling appends new ones after the last stored timestamp
// (selectNewTurns).
function committedConversationSwitch(
  current: ManagedSession,
  attempt: NonNullable<ManagedSession['clearPending']>,
  targetId: string,
): ManagedSession | undefined {
  const conversations = current.conversations ?? [];
  const target = conversations.find((conversation) => conversation.id === targetId);
  const runtime = target && resumableRuntime(target);
  if (!target?.provider || !runtime || !target.providerSessionId) return undefined;
  const now = new Date().toISOString();
  return {
    ...current,
    provider: target.provider,
    // The session binding follows the resumed segment; a runtime left over
    // from the CLI that just exited would mismatch the provider and silence
    // liveness checks for the resumed CLI.
    runtimeId: runtime.runtimeId,
    providerSessionId: target.providerSessionId,
    providerSessionFile: target.transcript.file,
    providerLaunchedAt: attempt.launchStartedAt ?? now,
    launchProfile: target.launchProfile ? structuredClone(target.launchProfile) : null,
    activeConversationId: target.id,
    conversations: conversations.map((conversation) => {
      if (conversation.id === target.id) {
        return { ...conversation, endedAt: null, endReason: null, pendingInteraction: null, deliveryUnconfirmedText: null };
      }
      if (conversation.id === attempt.conversationId && !conversation.endedAt) {
        return { ...conversation, endedAt: now, endReason: 'relaunch' as const };
      }
      return conversation;
    }),
    clearPending: null,
    startupPrompt: null,
    ...lifecycleTransition(current, 'ready'),
    lastError: null,
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    pendingInteraction: null,
    turns: target.turns,
    turnsSourceFile: target.transcript.file,
  };
}

export async function failPendingClear(
  id: string,
  attemptId: string,
  message: string | null,
  options: { exited: boolean; tmuxMissing?: boolean },
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    const attempt = current?.clearPending;
    if (!current || !attempt || attempt.attemptId !== attemptId) return { result: undefined };
    transitionOwners.delete(clearOwnerKey(id, attemptId));
    if (!options.exited) {
      const restored = {
        ...current,
        ...(options.tmuxMissing
          ? lifecycleTransition(current, 'dead')
          : lifecycleTransition(current, attempt.previousStatus, attempt.previousTurnPhase)),
        clearPending: null,
        lastError: message,
      };
      return { next: restored, result: restored };
    }
    const now = new Date().toISOString();
    const next: ManagedSession = {
      ...current,
      conversations: (current.conversations ?? []).map((conversation) => conversation.id === attempt.conversationId
        ? { ...conversation, endedAt: now, endReason: attempt.targetConversationId ? 'relaunch' as const : 'clear' as const }
        : conversation),
      provider: null,
      providerSessionId: null,
      providerSessionFile: null,
      providerLaunchedAt: null,
      launchProfile: null,
      activeConversationId: null,
      clearPending: null,
      startupPrompt: null,
      ...lifecycleTransition(current, 'idle'),
      lastError: message,
      ...emptyActiveMirror(),
    };
    return { next, result: next };
  });
}

export function ownsLaunchAttemptLocally(id: string, providerLaunchedAt: string): boolean {
  return transitionOwners.has(ownerKey('launch', id, providerLaunchedAt));
}

export function releaseLaunchAttempt(id: string, providerLaunchedAt: string): void {
  transitionOwners.delete(ownerKey('launch', id, providerLaunchedAt));
}

// Cancellation and startup observation share ownership with dispatch. Claim
// against the latest committed attempt before touching the pane, and retain
// ownership through its commit/rollback. No new durable phase is needed: on
// restart the existing pending launch is resolved from actual pane liveness.
export async function claimPendingLaunch(id: string, providerLaunchedAt: string): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    const key = ownerKey('launch', id, providerLaunchedAt);
    if (!current || isTrashed(current) || current.status !== 'launching'
      || current.launchPending?.providerLaunchedAt !== providerLaunchedAt
      || transitionOwners.has(key)) return { result: undefined };
    transitionOwners.add(key);
    return { result: current };
  });
}

// Atomically reserves a provider launch before any CLI command is sent. This
// closes the read-then-write race between simultaneous launch requests. The
// caller owns the attempt until releaseLaunchAttempt; only then may the
// poller judge its startup.
export async function beginPendingLaunch(
  id: string,
  attempt: NonNullable<ManagedSession['launchPending']>,
): Promise<ManagedSession | null | undefined> {
  const key = ownerKey('launch', id, attempt.providerLaunchedAt);
  return claimed(key, store.commit(id, (current) => {
    if (!current || isTrashed(current)) return { result: undefined };
    if (current.status === 'dead' || current.provider !== null || (current.status === 'launching' && current.launchPending)) return { result: null };
    const next = { ...current, ...lifecycleTransition(current, 'launching'), lastError: null, launchPending: attempt };
    transitionOwners.add(key);
    return { next, result: next };
  }));
}

export async function commitConversationLaunch(
  id: string,
  input: { provider: Provider; runtimeId?: RuntimeId; providerSessionId: string | null; providerLaunchedAt: string; launchProfile: LaunchProfileSnapshot | null },
  expectedPendingLaunchAt?: string,
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current) return { result: undefined };
    if (expectedPendingLaunchAt && current.launchPending?.providerLaunchedAt !== expectedPendingLaunchAt) {
      // The route and restart-recovery poller may both observe the same CLI as
      // alive. Only the request that still owns the persisted claim may commit;
      // a duplicate resolver returns the already-committed state instead.
      return {
        result: current.provider === input.provider && current.providerLaunchedAt === expectedPendingLaunchAt
          ? current
          : undefined,
      };
    }
    const conversations = [...(current.conversations ?? [])];
    const active = conversations.find((conversation) => conversation.id === current.activeConversationId);
    // A branch line's CLI forked from another conversation: its transcript
    // may start with that one's turns, which the baseline skips.
    const forked = !!current.launchPending?.fork;
    const startReason = !active ? (forked ? 'fork' : 'launch') : active.provider !== input.provider ? 'provider_switch' : 'relaunch';
    const endedAt = new Date().toISOString();
    const closed = active
      ? conversations.map((conversation) => conversation.id === active.id
        ? { ...conversation, endedAt, endReason: startReason as 'provider_switch' | 'relaunch' }
        : conversation)
      : conversations;
    const conversationId = randomUUID();
    const segment = newSegment(conversations, {
      id: conversationId,
      provider: input.provider,
      runtimeId: input.runtimeId ?? input.launchProfile?.runtimeId ?? runtimeForProvider(input.provider),
      launchProfile: input.launchProfile ? structuredClone(input.launchProfile) : null,
      providerSessionId: input.providerSessionId,
      startedAt: input.providerLaunchedAt,
      startReason,
      // Set once the transcript is bound (sync/binding.ts establishTurnBaseline).
      transcriptTurnOffset: startReason === 'fork' ? null : 0,
    });
    const next: ManagedSession = {
      ...current,
      provider: input.provider,
      runtimeId: input.runtimeId ?? input.launchProfile?.runtimeId ?? runtimeForProvider(input.provider),
      providerSessionId: input.providerSessionId,
      providerSessionFile: null,
      providerLaunchedAt: input.providerLaunchedAt,
      launchProfile: input.launchProfile,
      launchPending: null,
      startupPrompt: null,
      activeConversationId: conversationId,
      conversations: [...closed, segment],
      ...lifecycleTransition(current, 'ready'),
      ...emptyActiveMirror(),
      lastError: null,
    };
    return { next, result: next };
  });
}

// Reattaches a pre-conversation-model runtime only after liveness has been
// positively verified. The migrated legacy segment remains untouched; its
// old turns are never copied into this new, initially empty runtime segment.
export async function attachRuntimeRecoveryConversation(id: string): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current || !current.provider || current.activeConversationId || current.status === 'dead' || current.launchPending) return { result: current };
    const conversations = [...(current.conversations ?? [])];
    const conversationId = randomUUID();
    const segment = newSegment(conversations, {
      id: conversationId,
      provider: current.provider,
      runtimeId: current.runtimeId ?? current.launchProfile?.runtimeId ?? runtimeForProvider(current.provider),
      launchProfile: current.launchProfile ? structuredClone(current.launchProfile) : null,
      providerSessionId: current.providerSessionId,
      startedAt: current.providerLaunchedAt ?? current.createdAt,
      startReason: 'runtime_recovery',
      // Set once the transcript is proven ours (see the recovery baseline in
      // polling), so turns already in it are not imported.
      transcriptTurnOffset: null,
    });
    const next: ManagedSession = {
      ...current,
      activeConversationId: conversationId,
      conversations: [...conversations, segment],
      // A runtime already past 'launching' keeps its status and turn.
      ...(current.status === 'launching' ? lifecycleTransition(current, 'ready') : {}),
      providerSessionFile: null,
      ...emptyActiveMirror(),
    };
    return { next, result: next };
  });
}

export async function rollbackPendingLaunch(id: string, lastError: string | null, expectedPendingLaunchAt?: string): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current?.launchPending) return { result: current };
    // A caller that names the attempt (cancelling it) never undoes a newer one.
    if (expectedPendingLaunchAt && current.launchPending.providerLaunchedAt !== expectedPendingLaunchAt) return { result: current };
    const next = {
      ...current,
      launchPending: null,
      ...lifecycleTransition(current, current.launchPending.previousStatus, current.launchPending.previousTurnPhase),
      lastError,
    };
    return { next, result: next };
  });
}

// Claim a single explicit recovery attempt against the latest active
// segment, whose runtime reopens conversations in place. The caller must
// have verified the native transcript and profile before this durable
// reservation; keeping the transition here closes the race between two UI
// confirmations.
export async function beginPendingResume(
  id: string,
  attempt: NonNullable<ManagedSession['resumePending']>,
): Promise<ManagedSession | null | undefined> {
  const key = ownerKey('resume', id, attempt.attemptId);
  return claimed(key, store.commit(id, (current) => {
    if (!current || isTrashed(current)) return { result: undefined };
    const recovery = deadSessionRecovery(current);
    if (!recovery.ok || recovery.conversation.id !== attempt.conversationId || !current.launchProfile) return { result: null };
    const next = { ...current, ...lifecycleTransition(current, 'launching'), resumePending: { ...attempt }, lastError: null };
    transitionOwners.add(key);
    return { next, result: next };
  }));
}

export async function commitPendingResume(id: string, attemptId: string): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current || current.resumePending?.attemptId !== attemptId) return { result: undefined };
    const active = current.conversations?.find((conversation) => conversation.id === current.resumePending?.conversationId);
    if (!active || current.activeConversationId !== active.id || active.provider !== current.provider) return { result: undefined };
    const next = { ...current, ...lifecycleTransition(current, 'ready'), resumePending: null, lastError: null };
    return { next, result: next };
  });
}

export async function rollbackPendingResume(
  id: string,
  attemptId: string,
  lastError: string,
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current || current.resumePending?.attemptId !== attemptId) return { result: current };
    const next = { ...current, ...lifecycleTransition(current, 'dead'), resumePending: null, lastError };
    return { next, result: next };
  });
}

export async function updateConversation(
  sessionId: string,
  conversationId: string,
  patch: Partial<Omit<ConversationSegment, 'id' | 'sequence'>>,
  sessionPatch: Partial<Omit<ManagedSession, 'conversations'>> = {},
): Promise<ManagedSession | undefined> {
  return store.commit(sessionId, (current) => {
    if (!current) return { result: undefined };
    const conversations = current.conversations ?? [];
    if (!conversations.some((conversation) => conversation.id === conversationId)) return { result: undefined };
    const next: ManagedSession = {
      ...current,
      ...sessionPatch,
      conversations: conversations.map((conversation) => conversation.id === conversationId ? { ...conversation, ...patch } : conversation),
    };
    const target = next.conversations?.find((conversation) => conversation.id === conversationId);
    if (conversationId === next.activeConversationId && target) {
      next.turns = target.turns;
      next.turnsSourceFile = target.transcript.file;
      next.providerSessionFile = target.transcript.file;
      next.lastUserMessageAt = target.lastUserMessageAt;
      next.lastUserMessageText = target.lastUserMessageText;
      next.deliveryUnconfirmedText = target.deliveryUnconfirmedText;
      next.pendingInteraction = target.pendingInteraction;
    }
    return { next, result: next };
  });
}

/** Bind an ID only while the exact runtime segment is still active and unbound. */
export async function bindObservedSessionId(
  sessionId: string,
  conversationId: string,
  runtimeId: RuntimeId,
  providerSessionId: string,
): Promise<ManagedSession | undefined> {
  // Only a runtime whose identity is observed after start may be bound
  // this way; a pinned runtime's ID was fixed at launch.
  if (getRuntimeDriver(runtimeId)?.identity.kind !== 'observed_after_start'
    || !UUID_SHAPE.test(providerSessionId)) return undefined;
  return store.commit(sessionId, (current) => {
    if (!current || current.status === 'dead' || current.status === 'launching'
      || current.activeConversationId !== conversationId || current.runtimeId !== runtimeId
      || current.providerSessionId !== null || current.clearPending) return { result: undefined };
    const conversations = current.conversations ?? [];
    const active = conversations.find((conversation) => conversation.id === conversationId);
    if (!active || active.provider !== current.provider || active.runtimeId !== runtimeId
      || active.providerSessionId !== null || active.endedAt) return { result: undefined };
    const next: ManagedSession = {
      ...current,
      providerSessionId,
      conversations: conversations.map((conversation) => conversation.id === conversationId
        ? { ...conversation, providerSessionId }
        : conversation),
    };
    return { next, result: next };
  });
}

export async function endActiveConversation(
  id: string,
  endReason: 'cli_exit' | 'unknown',
): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current) return { result: undefined };
    const now = new Date().toISOString();
    const conversations = (current.conversations ?? []).map((conversation) => conversation.id === current.activeConversationId
      ? { ...conversation, endedAt: now, endReason }
      : conversation);
    const next: ManagedSession = {
      ...current,
      conversations,
      activeConversationId: null,
      provider: null,
      runtimeId: null,
      providerSessionId: null,
      providerSessionFile: null,
      providerLaunchedAt: null,
      launchProfile: null,
      launchPending: null,
      startupPrompt: null,
      ...lifecycleTransition(current, 'idle'),
      ...emptyActiveMirror(),
    };
    return { next, result: next };
  });
}

// Moves the record to the trash. Its tmux is the caller's to end
// (services/sessions.ts). A trashed record is always dead and holds no
// transition claim, so nothing can start in it until it is restored.
// Notes are project-scoped, not session-scoped — deleting a session must
// not touch the notes shared with the rest of its project, nor its
// dialogue archive. Idempotent: an already-trashed record keeps its
// deletedAt. Returns the record, or undefined when there is none.
export async function trashSession(id: string, now: string = new Date().toISOString()): Promise<ManagedSession | undefined> {
  return store.commit(id, (current) => {
    if (!current) return { result: undefined };
    if (isTrashed(current)) return { result: current };
    const next: ManagedSession = {
      ...current,
      ...lifecycleTransition(current, 'dead'),
      deletedAt: now,
      launchPending: null,
      resumePending: null,
      clearPending: null,
      startupPrompt: null,
    };
    return { next, result: next };
  });
}

// Takes a record back out of the trash, as a dead tmux: nothing is
// relaunched — the user recovers or reopens it from there like any other
// ended session. undefined: no such record; null: it isn't in the trash.
export async function restoreSession(id: string): Promise<ManagedSession | null | undefined> {
  return store.commit(id, (current) => {
    if (!current) return { result: undefined };
    if (!isTrashed(current)) return { result: null };
    const next: ManagedSession = {
      ...current,
      ...lifecycleTransition(current, 'dead'),
      deletedAt: null,
      launchPending: null,
      resumePending: null,
      clearPending: null,
      startupPrompt: null,
    };
    return { next, result: next };
  });
}

// Drops a trashed record for good. Only the registry record: the dialogue
// archive and the CLI's own transcripts stay where they are.
// undefined: no such record; null: it isn't in the trash.
export async function purgeSession(id: string): Promise<ManagedSession | null | undefined> {
  return store.transact((current) => {
    const session = current.get(id);
    if (!session) return { result: undefined };
    if (!isTrashed(session)) return { result: null };
    return { result: session, remove: [id] };
  });
}

// Marks 'dead' every managed session whose tmux is not among the running
// ones (killed outside this tool, tmux server restarted, machine rebooted,
// ...) rather than silently dropping it, so the frontend can show why it
// stopped responding. Returns the sessions it just marked dead, so the
// caller can clear what their last turn left behind (see
// services/sessions.ts reconcileWithTmux).
export async function markDeadUnlessRunning(runningTmuxNames: ReadonlySet<string>): Promise<ManagedSession[]> {
  return store.transact((current) => {
    const died = [...current.values()]
      .filter((session) => !isTrashed(session) && !runningTmuxNames.has(session.tmuxName) && session.status !== 'dead')
      .map((session) => ({ ...session, ...lifecycleTransition(session, 'dead') }));
    return { result: died, write: died };
  });
}

export function __resetForTests(): void {
  store.__resetStoreForTests();
  transitionOwners.clear();
}
