import * as notesStore from '../notes-store.js';
import * as projectStore from '../project-store.js';
import { getRuntimeDriverForProvider, runtimeForProvider } from '../runtimes/index.js';
import { LEGACY_INTERRUPTED_MARKER } from '../contract/sessions.js';
import { STUCK_HINT_TEXT, turnPhaseOf, type ConversationSegment, type LaunchProfileSnapshot, type LegacySessionStatus, type ManagedSession, type Provider, type SessionStatus, type Turn, type TurnPhase } from '../types.js';

// Every older registry.json shape, upgraded to the current one on load.

// The project sessions from before projects existed are put in.
const DEFAULT_PROJECT_NAME = 'hestia';

type StoredSession = ManagedSession & { claudeClearPending?: ManagedSession['clearPending'] };

// Registry files written before the turn phase was split out of `status`:
// 'waiting' / 'needs_interaction' become 'ready' plus the matching phase,
// and a record without turnPhase has no turn in progress.
function isLegacyStatus(status: LegacySessionStatus): boolean {
  return status === 'waiting' || status === 'needs_interaction';
}

function splitLegacyStatus(status: LegacySessionStatus): { status: SessionStatus; turnPhase: TurnPhase | undefined } {
  return isLegacyStatus(status)
    ? { status: 'ready', turnPhase: turnPhaseOf(status) ?? 'idle' }
    : { status: status as SessionStatus, turnPhase: undefined };
}

function needsTurnPhaseMigration(s: ManagedSession): boolean {
  return s.turnPhase === undefined
    || isLegacyStatus(s.status)
    || (!!s.launchPending && isLegacyStatus(s.launchPending.previousStatus))
    || (!!s.clearPending && isLegacyStatus(s.clearPending.previousStatus))
    || (!!(s as ManagedSession & { claudeClearPending?: ManagedSession['clearPending'] }).claudeClearPending
      && isLegacyStatus((s as ManagedSession & { claudeClearPending: NonNullable<ManagedSession['clearPending']> }).claudeClearPending.previousStatus));
}

function migrateTurnPhase(s: ManagedSession): ManagedSession {
  if (!needsTurnPhaseMigration(s)) return s;
  const split = splitLegacyStatus(s.status);
  let next: ManagedSession = { ...s, status: split.status, turnPhase: split.turnPhase ?? s.turnPhase ?? 'idle' };
  // A pending attempt's previous status is what its rollback restores.
  for (const key of ['launchPending', 'clearPending'] as const) {
    const attempt = next[key];
    if (!attempt || !isLegacyStatus(attempt.previousStatus)) continue;
    const previous = splitLegacyStatus(attempt.previousStatus);
    next = { ...next, [key]: { ...attempt, previousStatus: previous.status, previousTurnPhase: previous.turnPhase } };
  }
  return next;
}

// registry.json written before turnsSourceFile existed has no such key at
// all (not null — genuinely absent), which is indistinguishable at the
// type level from "we know this session's turns came from a different file
// than the current one". Without this, polling.ts would read that absence
// as "file changed", replaying (and duplicating) every turn already in
// `turns` on the very first poll after upgrading. Best-available guess for
// pre-existing data: assume the turns on file already match whatever file
// the session is currently pointed at, same as before this field existed.
//
// defaultProjectId is only used for the projectId backfill (see
// migrateLoadedRegistry()) — it's guaranteed non-null whenever a session actually
// needs it, because the caller pre-resolves it before calling this function
// on any legacy (missing-projectId) session.
function migrateSession(s: StoredSession, defaultProjectId: string | null): ManagedSession {
  let next = s;
  if (next.turnsSourceFile === undefined) {
    next = { ...next, turnsSourceFile: next.providerSessionFile };
  }
  if ((next as { projectId?: string }).projectId === undefined) {
    next = { ...next, projectId: defaultProjectId as string };
  }
  if (next.launchProfile === undefined) {
    next = { ...next, launchProfile: next.provider ? legacyNativeProfile(next.provider) : null };
  }
  if (next.runtimeId === undefined) {
    next = { ...next, runtimeId: next.launchProfile?.runtimeId ?? (next.provider ? runtimeForProvider(next.provider) : null) };
  }
  if (next.launchProfile && next.launchProfile.runtimeId === undefined && next.provider) {
    next = { ...next, launchProfile: { ...next.launchProfile, runtimeId: runtimeForProvider(next.provider) } };
  }
  if (next.conversations === undefined) {
    const hasLegacyHistory = next.turns.length > 0;
    const legacy: ConversationSegment[] = hasLegacyHistory ? [{
      id: `${next.id}:legacy`,
      sequence: 1,
      kind: 'cli',
      // The flat turns array may span several providers. The current runtime
      // provider is not evidence for the owner of historical turns.
      provider: null,
      runtimeId: null,
      launchProfile: null,
      providerSessionId: null,
      startedAt: next.createdAt,
      endedAt: null,
      startReason: 'legacy_migration',
      endReason: null,
      transcript: { state: 'legacy_unverified', identity: null, file: null },
      transcriptTurnOffset: null,
      lastUserMessageAt: next.lastUserMessageAt,
      lastUserMessageText: next.lastUserMessageText,
      deliveryUnconfirmedText: next.deliveryUnconfirmedText,
      pendingInteraction: next.pendingInteraction,
      transcriptError: null,
      turns: next.turns.map((turn) => ({ ...turn })),
    }] : [];
    next = { ...next, conversations: legacy, activeConversationId: null };
  } else if (next.activeConversationId === undefined) {
    next = { ...next, activeConversationId: null };
  }
  if (next.conversations) {
    const conversations = next.conversations.map((conversation) => {
      const runtimeId = conversation.runtimeId
        ?? conversation.launchProfile?.runtimeId
        ?? (conversation.provider ? runtimeForProvider(conversation.provider) : null);
      const launchProfile = conversation.launchProfile && conversation.launchProfile.runtimeId === undefined && conversation.provider
        ? { ...conversation.launchProfile, runtimeId: runtimeForProvider(conversation.provider) }
        : conversation.launchProfile;
      return { ...conversation, runtimeId, launchProfile };
    });
    next = { ...next, conversations };
  }
  if (next.launchPending === undefined) next = { ...next, launchPending: null };
  if (next.resumePending === undefined) next = { ...next, resumePending: null };
  const { claudeClearPending: legacyPending, ...currentShape } = next as ManagedSession & { claudeClearPending?: ManagedSession['clearPending'] };
  if (currentShape.clearPending && legacyPending) {
    throw new Error(`Conflicting pending clear claims in registry for session ${next.id}`);
  }
  const pending = currentShape.clearPending ?? legacyPending;
  const pendingProvider = pending?.provider ?? 'claude';
  const inferredOperation = pending?.targetConversationId ? 'conversation_switch' : 'clear';
  if (pending?.operation && pending.operation !== inferredOperation) {
    throw new Error(`Conflicting pending clear operation in registry for session ${next.id}`);
  }
  next = {
    ...currentShape,
    clearPending: pending ? {
      ...pending,
      operation: inferredOperation,
      provider: pendingProvider,
      runtimeId: pending.runtimeId
        ?? (next.provider === pendingProvider ? next.runtimeId ?? next.launchProfile?.runtimeId : undefined)
        ?? runtimeForProvider(pendingProvider),
      ...(!pending.targetConversationId ? { newConversationId: pending.newConversationId ?? `${next.id}:clear:${pending.attemptId}` } : {}),
    } : null,
  };
  return migrateTurnPhase(next);
}

// A record from before launch profiles was launched natively by the runtime
// its provider had then; it is given that runtime's native profile.
function legacyNativeProfile(provider: Provider): LaunchProfileSnapshot {
  const runtime = getRuntimeDriverForProvider(provider);
  const { home, conversationRoot } = runtime.nativeLocations();
  return {
    id: `native:${runtime.nativeProfile.configKey}`,
    provider,
    runtimeId: runtime.runtimeId,
    source: 'native',
    home,
    conversationRoot,
    delegate: { kind: 'native', executable: runtime.nativeProfile.defaultExecutable },
  };
}

/**
 * The record shape registry.json holds. Every record is written stamped with
 * it (the stamp never lives in memory or reaches the API). A record without
 * it, or with an older one, was written before versioning or by an older
 * build: it goes through the upgrades below once and is written back
 * stamped, so a current file is loaded without re-checking any old shape.
 * The file stays a plain array of session records, so an older build can
 * still read it (it ignores the stamp and re-checks shapes as it always did).
 *
 * To change the shape: bump this, and add an upgrade from the previous
 * version run on records older than the new one.
 */
export const REGISTRY_SCHEMA_VERSION = 4;

export function encodeSession(session: ManagedSession): Record<string, unknown> {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, ...session };
}

/**
 * Upgrades a parsed registry.json to the current shape. `changed` says the
 * file needs writing back, i.e. some record was older than the current
 * version. Each upgrade runs only on the records older than its version.
 */
export async function migrateLoadedRegistry(records: unknown[]): Promise<{ sessions: ManagedSession[]; changed: boolean }> {
  const entries = (records as Array<StoredSession & { schemaVersion?: number }>).map(({ schemaVersion, ...session }) => ({
    session: session as StoredSession,
    // A newer build's record is taken as it is: it has at least our shape.
    version: typeof schemaVersion === 'number' ? schemaVersion : 0,
  }));
  const outdated = entries.filter((entry) => entry.version < REGISTRY_SCHEMA_VERSION);
  if (outdated.length === 0) return { sessions: entries.map((entry) => entry.session), changed: false };
  const beforeV1 = outdated.filter((entry) => entry.version < 1).map((entry) => entry.session);
  const upgraded = beforeV1.length > 0 ? await upgradeToV1(beforeV1, entries.map((entry) => entry.session)) : new Map<string, ManagedSession>();
  const sessions = entries.map((entry) => {
    const session = upgraded.get(entry.session.id) ?? entry.session;
    const v2 = entry.version < 2 ? upgradeToV2(session) : session;
    const v3 = entry.version < 3 ? upgradeToV3(v2) : v2;
    return entry.version < 4 ? { ...v3, sessionNumber: undefined } : v3;
  });
  const counts = new Map<string, number>();
  for (const session of [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const count = counts.get(session.projectId) ?? 0;
    if (session.sessionNumber === undefined || session.sessionNumber === null) session.sessionNumber = (count % 100) + 1;
    counts.set(session.projectId, count + 1);
  }
  return { sessions, changed: true };
}

/**
 * v2: the stuck hint moved out of lastError (where it was a zh-TW sentence
 * compared by text) into stuckSince. When it was raised isn't recorded, so
 * the upgrade stamps the load time; it only needs to be set.
 */
function upgradeToV2(session: ManagedSession): ManagedSession {
  if (session.lastError !== STUCK_HINT_TEXT) return session;
  return { ...session, lastError: null, stuckSince: new Date().toISOString() };
}

/**
 * v3: an interrupted reply is flagged (Turn.assistant.interrupted) instead
 * of ending in the zh-TW marker the Claude parser used to write into it.
 * Every stored copy of the turns is upgraded — the conversations' and the
 * session's legacy mirror — so the next transcript diff compares like with
 * like (sync/turns.ts diffTurns).
 */
function upgradeToV3(session: ManagedSession): ManagedSession {
  const upgradeTurns = (turns: Turn[]) => (turns.some(endsInMarker) ? turns.map(flagInterrupted) : turns);
  const conversations = session.conversations?.map((conversation) => {
    const turns = upgradeTurns(conversation.turns);
    return turns === conversation.turns ? conversation : { ...conversation, turns };
  });
  const turns = upgradeTurns(session.turns);
  const conversationsChanged = conversations?.some((conversation, i) => conversation !== session.conversations?.[i]) ?? false;
  if (turns === session.turns && !conversationsChanged) return session;
  return { ...session, turns, ...(conversations ? { conversations } : {}) };
}

function endsInMarker(turn: Turn): boolean {
  return !turn.assistant.interrupted && turn.assistant.text.endsWith(LEGACY_INTERRUPTED_MARKER);
}

function flagInterrupted(turn: Turn): Turn {
  if (!endsInMarker(turn)) return turn;
  const text = turn.assistant.text.slice(0, -LEGACY_INTERRUPTED_MARKER.length).replace(/\n\n$/, '');
  return { ...turn, assistant: { ...turn.assistant, text, interrupted: true } };
}

/**
 * Every shape from before versioning (all idempotent: a record already in
 * the v1 shape comes out unchanged). Sessions from before projects are
 * placed in the default project, which also takes over their notes and
 * learns their paths. `all` is every record in the file, for the project
 * path backfill.
 */
async function upgradeToV1(records: StoredSession[], all: StoredSession[]): Promise<Map<string, ManagedSession>> {
  const legacySessions = records.filter((s) => (s as { projectId?: string }).projectId === undefined);
  let defaultProjectId: string | null = null;
  if (legacySessions.length > 0) {
    const defaultProject = await projectStore.resolveOrCreateProjectByName(DEFAULT_PROJECT_NAME);
    defaultProjectId = defaultProject.id;
  }
  const sessions = new Map(records.map((s) => [s.id, migrateSession(s, defaultProjectId)]));
  // Notes migration (per-legacy-session file → one file for the project it
  // now belongs to) runs here, in the same load, triggered by the same
  // legacySessions batch.
  for (const legacy of legacySessions) {
    const migrated = sessions.get(legacy.id) as ManagedSession;
    await notesStore.migrateLegacySessionNotes(legacy.id, migrated.projectId);
  }
  // The default project those sessions just joined may be new itself, so it
  // learns their paths here rather than from the backfill below.
  for (const legacy of [...legacySessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    await projectStore.addProjectPath((sessions.get(legacy.id) as ManagedSession).projectId, legacy.cwd);
  }
  // Projects stored before they had paths learn them from their sessions.
  await projectStore.backfillPathsFromSessions(all.map((session) => sessions.get(session.id) ?? session));
  return sessions;
}
