import type { LaunchOption } from '../contract/meta.js';
import { getLaunchProfileCatalog, launchOptionOf, type LaunchProfile } from '../launch-profiles.js';
import { listModels as listAccountModels } from '../model-lists.js';
import { accountLimit, cliProcessorProfile, cliProcessorRuntimeOf } from '../processors/cli/profiles.js';
import * as registry from '../registry.js';
import * as sessionStream from '../session-stream.js';
import { awaitedTurnLanded } from '../sync/turns.js';
import { activeTurnPhase, isTrashed, type ManagedSession } from '../types.js';
import { publishRecap } from './events.js';
import type { RecapConversation, RecapPorts } from './ports.js';
import { runRecapBatch } from './runner.js';
import { createRecapScheduler, type RecapScheduler } from './scheduler.js';
import { recapSettingsStore } from './settings-store.js';
import { applyBatch, readRecapFile, setItemStatus, updateRecapFile } from './store.js';

// The one place recap/ meets the rest of the app: the registry's
// conversations, the launch profiles and their models, what is known of
// an account's quota (processors/cli/profiles.ts), the runner, and the
// session events that start a conversation's idle wait.

// Nothing newly read: whether the turn being answered is stored already.
const NO_TURN_CHANGES = { newTurns: [], grownLast: null };

/** A session's conversations as recap/ sees them. */
export function recapConversationsOf(session: ManagedSession): RecapConversation[] {
  const trashed = isTrashed(session);
  const replying = activeTurnPhase(session) === 'replying' ? session.activeConversationId ?? null : null;
  return (session.conversations ?? []).map((conversation) => ({
    sessionId: session.id,
    tmuxName: session.tmuxName,
    projectId: session.projectId ?? null,
    conversationId: conversation.id,
    provider: conversation.provider,
    sequence: conversation.sequence,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    turns: conversation.turns,
    replying: conversation.id === replying,
    ...(conversation.id === replying ? { replyingTurnStored: awaitedTurnLanded(conversation, NO_TURN_CHANGES) } : {}),
    trashed,
  }));
}

/** The launch profiles a recap can run on: Codex and Claude Code only. */
export function recapLaunchOptions(profiles: LaunchProfile[]): LaunchOption[] {
  return profiles.filter((profile) => cliProcessorRuntimeOf(profile) !== null).map(launchOptionOf);
}

export const recapPorts: RecapPorts = {
  async listConversations() {
    return (await registry.listAllSessions()).flatMap(recapConversationsOf);
  },

  async listSessionConversations(sessionId) {
    const session = await registry.getSession(sessionId);
    return session ? recapConversationsOf(session) : null;
  },

  async getConversation(sessionId, conversationId) {
    const session = await registry.getSessionRecord(sessionId);
    return (session && recapConversationsOf(session).find((conversation) => conversation.conversationId === conversationId)) ?? null;
  },

  readRecap: readRecapFile,
  applyBatch,
  updateRecap: updateRecapFile,
  setItemStatus,

  async runBatch({ profileId, model, effort, prompt }) {
    const found = await cliProcessorProfile(profileId);
    if (!found) return { ok: false, code: 'profile_unavailable' };
    return runRecapBatch({ profile: found.snapshot, model, effort, prompt });
  },

  async listProfiles() {
    return recapLaunchOptions((await getLaunchProfileCatalog()).profiles);
  },

  async listModels(profileId, refresh) {
    const found = await cliProcessorProfile(profileId);
    if (!found?.driver.models) throw new Error('launch profile unavailable');
    const list = await listAccountModels(found.driver, found.snapshot, refresh);
    return { runtimeId: found.driver.runtimeId, source: found.driver.models.source, options: list.options, fetchedAt: list.fetchedAt };
  },

  async accountState(profileId) {
    const found = await cliProcessorProfile(profileId);
    if (!found) return { available: false };
    return { available: true, label: found.profile.label, runtimeId: found.driver.runtimeId, limited: await accountLimit(found.snapshot) };
  },

  now: () => new Date(),
  publish: publishRecap,
};

export const recap: RecapScheduler = createRecapScheduler(recapPorts, recapSettingsStore());

type SessionSeen = { fingerprints: Map<string, string>; replying: string | null };

/**
 * Tells the scheduler what session events mean for recaps: a conversation
 * whose turns changed (its turnsFingerprint) starts its idle wait over; a
 * reply finishing, or a session back from the trash, has its plans worked
 * out again; a deleted session leaves the queue.
 */
export function watchSessions(scheduler: RecapScheduler, observe: typeof sessionStream.observeAll = sessionStream.observeAll): () => void {
  const seen = new Map<string, SessionSeen>();
  const report = (work: Promise<void>) => void work.catch((err: unknown) => console.error('[recap] session update failed', err));
  return observe((sessionId, event) => {
    if (event.type === 'deleted') {
      seen.delete(sessionId);
      scheduler.sessionRemoved(sessionId);
      return;
    }
    const { session } = event;
    const now: SessionSeen = {
      fingerprints: new Map(session.conversations.map((conversation) => [conversation.id, conversation.turnsFingerprint])),
      replying: session.turnPhase === 'replying' ? session.activeConversationId : null,
    };
    const before = seen.get(sessionId);
    seen.set(sessionId, now);
    if (!before) {
      // Nothing to compare with yet (seen first since start-up): only the
      // conversation in use can be changing.
      if (session.activeConversationId) report(scheduler.conversationChanged(sessionId, session.activeConversationId));
      if (event.type === 'restored') report(scheduler.sessionChanged(sessionId));
      return;
    }
    for (const [conversationId, fingerprint] of now.fingerprints) {
      if (before.fingerprints.get(conversationId) !== fingerprint) report(scheduler.conversationChanged(sessionId, conversationId));
    }
    if (before.replying !== now.replying || event.type === 'restored') report(scheduler.sessionChanged(sessionId));
  });
}

/** Starts the recaps: watches the sessions, reads every conversation once, and works off the queue. */
export function startRecap(): void {
  watchSessions(recap);
  void recap.start().catch((err: unknown) => console.error('[recap] start failed', err));
}
