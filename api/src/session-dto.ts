import { NATIVE_ACCOUNT_NAME, accountIdFor } from './account-status/types.js';
import { attachmentsInText } from './attachments.js';
import { countUserMessages } from './contract/continuity.js';
import type { ConversationDetail, ConversationSummary, LegacySessionDto, SegmentHandoff, SessionDto, TrashedSessionDto, Turn } from './contract/index.js';
import { LEGACY_INTERRUPTED_MARKER, TRASH_LAST_MESSAGE_CHARS } from './contract/sessions.js';
import { type PastedTextMark, pastedTextRanges } from './pastedText.js';
import { conversationResumeBlocked } from './runtimes/conversation-blocks.js';
import { accountRuntimeFor } from './runtimes/index.js';
import { deadSessionRecovery } from './runtimes/resume.js';
import { runtimeForProvider } from './runtimes/types.js';
import { type ConversationSegment, type LaunchProfileSnapshot, type ManagedSession, type SegmentHandoffRecord, activeTurnPhase, deriveSessionActivity, legacyStatusOf } from './types.js';
import { t } from './i18n/index.js';

// What a session and its conversations look like to a client (the
// contract's DTOs), from the stored records (types.ts): the public fields
// only, the deprecated ones older PWAs still read, and what is derived for
// display (activity, quota account, attachments in the turns).

/** What of a conversation's handoff a client sees: all but the brief's file. */
export function publicSegmentHandoff(record: SegmentHandoffRecord | null | undefined): SegmentHandoff | null {
  if (!record) return null;
  return {
    handoffId: record.handoffId,
    trigger: record.trigger,
    fromConversationId: record.fromConversationId,
    briefSource: record.briefSource,
    source: record.source,
    briefNote: record.briefNote,
    briefNoteCode: record.briefNoteCode ?? null,
    confirm: record.confirm,
    briefAmended: record.briefAmended,
    ...(record.derived ? { derived: true } : {}),
  };
}

export type PublicConversation = ConversationDetail;

export function toPublicConversation(conversation: ConversationSegment): PublicConversation {
  return {
    id: conversation.id,
    sequence: conversation.sequence,
    kind: conversation.kind,
    provider: conversation.provider,
    ...(conversation.runtimeId ? { runtimeId: conversation.runtimeId } : {}),
    launchProfile: conversation.launchProfile ? {
      id: conversation.launchProfile.id,
      provider: conversation.launchProfile.provider,
      ...(conversation.launchProfile.runtimeId ? { runtimeId: conversation.launchProfile.runtimeId } : {}),
      source: conversation.launchProfile.source,
      ...(conversation.launchProfile.profileName ? { profileName: conversation.launchProfile.profileName } : {}),
      permissionMode: conversation.launchProfile.permissionMode ?? 'cli_default',
    } : null,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    startReason: conversation.startReason,
    endReason: conversation.endReason,
    transcript: { state: conversation.transcript.state, identity: conversation.transcript.identity },
    lastUserMessageAt: conversation.lastUserMessageAt,
    lastUserMessageText: conversation.lastUserMessageText,
    deliveryUnconfirmedText: conversation.deliveryUnconfirmedText,
    pendingInteraction: conversation.pendingInteraction,
    transcriptError: conversation.transcriptError,
    turns: publicTurns(conversation.turns, conversation.terminalMessageAts, conversation.pastedTexts),
    handoff: publicSegmentHandoff(conversation.handoff),
    userMessagesCount: conversation.transcript.state === 'resolved' ? countUserMessages(conversation.turns) : null,
  };
}

/**
 * Turns as they are sent: each message with the uploads it refers to
 * (attachments.ts; recognized here, never stored, so old messages get them
 * too), and the parts the app sent as pasted text (pastedText.ts). An
 * interrupted reply is flagged, and its text still ends with the
 * old marker, as it did when the marker was the only sign, for PWAs cached
 * before the flag (removal: docs/reference/api-contract-v1.md). Stored turns never
 * carry the marker.
 */
export function publicTurns(turns: Turn[], terminalMessageAts?: readonly string[], pastedTexts?: readonly PastedTextMark[]): Turn[] {
  const fromTerminal = new Set(terminalMessageAts ?? []);
  return turns.map((turn) => {
    const withAttachments = (message: Turn['user']) => {
      const pastes = pastedTexts?.length ? pastedTextRanges(message.text, pastedTexts) : [];
      return {
        ...message,
        attachments: attachmentsInText(message.text),
        ...(pastes.length > 0 ? { pastes } : {}),
        ...(message.at && fromTerminal.has(message.at) ? { fromTerminal: true as const } : {}),
      };
    };
    const assistant = turn.assistant.interrupted
      ? { ...turn.assistant, text: turn.assistant.text ? `${turn.assistant.text}\n\n${LEGACY_INTERRUPTED_MARKER}` : LEGACY_INTERRUPTED_MARKER }
      : turn.assistant;
    return {
      ...turn,
      user: withAttachments(turn.user),
      ...(turn.followUps ? { followUps: turn.followUps.map(withAttachments) } : {}),
      assistant,
    };
  });
}

/**
 * Which account-status entry (api/src/account-status/accounts.ts ids) holds
 * the quota of the CLI running in this session. A Janus launch runs that
 * Janus account; a native launch runs the provider CLI's own default
 * account. A provider none of whose runtimes reports usage (Gemini, for
 * now) has no quota source.
 */
export function quotaAccountIdFor(session: Pick<ManagedSession, 'provider' | 'runtimeId' | 'status'> & {
  launchProfile?: Pick<LaunchProfileSnapshot, 'provider' | 'source' | 'profileName'> | null;
}): string | null {
  const profile = session.launchProfile;
  if (!session.provider || session.status === 'dead' || !profile || profile.provider !== session.provider) return null;
  if (!accountRuntimeFor(session.provider)) return null;
  if (profile.source === 'janus') return profile.profileName ? accountIdFor('janus', profile.provider, profile.profileName) : null;
  return accountIdFor('native', profile.provider, NATIVE_ACCOUNT_NAME);
}

function resumeBlockedFields(conversation: ConversationSegment): Pick<ConversationSummary, 'resumeBlockedReason' | 'resumeBlocked'> {
  const blocked = conversationResumeBlocked(conversation);
  return {
    resumeBlockedReason: blocked?.message ?? null,
    resumeBlocked: blocked ? { code: blocked.code, ...(blocked.params ? { params: blocked.params } : {}) } : null,
  };
}

function turnsFingerprint(turns: readonly Turn[]): string {
  const last = turns.at(-1);
  // A follow-up (Turn.followUps) can join the last turn without its reply
  // changing; the suffix only appears once there is one.
  const followUps = last?.followUps?.length ? `:${last.followUps.length}` : '';
  // And being marked interrupted can land after its text did.
  const interrupted = last?.assistant.interrupted ? ':i' : '';
  return `${turns.length}:${last?.assistant.text.length ?? 0}${followUps}${interrupted}`;
}

// The session DTO (contract/sessions.ts), with the fields cached older
// PWAs still read: what the endpoints that predate contract v1 send.
export type PublicManagedSession = LegacySessionDto;

export function toPublicManagedSession(session: ManagedSession): PublicManagedSession {
  const active = session.conversations?.find((conversation) => conversation.id === session.activeConversationId);
  return {
    ...toSessionDto(session),
    // Deprecated in contract v1; see docs/reference/api-contract-v1.md.
    status: legacyStatusOf(session),
    claudeClearPending: !!session.clearPending,
    turns: publicTurns(active?.turns ?? []),
  };
}

/** A legacy DTO without the fields only cached PWAs read. */
const LEGACY_SESSION_FIELDS: ReadonlySet<string> = new Set<keyof LegacySessionDto>(['status', 'claudeClearPending', 'turns']);

export function withoutLegacyFields(dto: LegacySessionDto): SessionDto {
  return Object.fromEntries(Object.entries(dto).filter(([key]) => !LEGACY_SESSION_FIELDS.has(key))) as SessionDto;
}

// When anything last happened in the session's active conversation: its
// last reply (or message), else its last send, else when the tmux opened.
function lastActivityAt(session: ManagedSession, active: ConversationSegment | undefined): string {
  const lastTurn = active?.turns.at(-1);
  return lastTurn?.assistant.at ?? lastTurn?.user.at ?? session.lastUserMessageAt ?? session.createdAt;
}

/** The contract-v1 session DTO, as the endpoints added with it send it. */
// Only while the CLI sits idle at its prompt: a stored one outlives the
// moment it was read until the next poll clears it.
function cliSuggestionOf(session: ManagedSession): string | null {
  if (!session.cliSuggestion || session.clearPending || session.pendingInteraction || session.startupPrompt) return null;
  return deriveSessionActivity(session) === 'idle' && activeTurnPhase(session) === 'idle' ? session.cliSuggestion : null;
}

// Only while the CLI runs: a stored one outlives it until the next poll.
function actualPermissionModeOf(session: ManagedSession): Pick<SessionDto, 'actualPermissionMode' | 'permissionModeChangedInTerminal'> {
  const actual = session.status === 'ready' && session.provider ? session.actualPermissionMode : null;
  return {
    actualPermissionMode: actual ? { mode: actual.mode, cli: actual.cli } : null,
    permissionModeChangedInTerminal: !!actual?.changedInTerminal,
  };
}

export function toSessionDto(session: ManagedSession): SessionDto {
  const profile = session.launchProfile;
  const conversations = session.conversations ?? [];
  const active = conversations.find((conversation) => conversation.id === session.activeConversationId);
  const pending = session.clearPending;
  const isSwitch = pending?.operation === 'conversation_switch' || !!pending?.targetConversationId;
  return {
    id: session.id,
    tmuxName: session.tmuxName,
    tmuxSocket: session.tmuxSocket ?? null,
    cwd: session.cwd,
    projectId: session.projectId,
    alias: session.alias,
    sessionNumber: session.sessionNumber ?? 1,
    createdAt: session.createdAt,
    provider: session.provider,
    ...(session.runtimeId ? { runtimeId: session.runtimeId } : {}),
    providerLaunchedAt: session.providerLaunchedAt,
    lastActivityAt: lastActivityAt(session, active),
    turnPhase: activeTurnPhase(session),
    activity: deriveSessionActivity(session),
    backgroundAgents: session.status === 'ready' ? (session.backgroundAgents ?? 0) : 0,
    backgroundTurn: session.status === 'ready' && session.backgroundTurn === true,
    cliSuggestion: cliSuggestionOf(session),
    ...actualPermissionModeOf(session),
    clearPending: pending && !isSwitch
      ? {
        runtimeId: pending.runtimeId
          ?? session.launchProfile?.runtimeId
          ?? (session.provider ? runtimeForProvider(session.provider) : 'legacy-unknown'),
        phase: pending.phase,
        delivery: pending.delivery ?? 'not_sent',
      }
      : null,
    conversationSwitch: isSwitch && pending?.targetConversationId
      ? { targetConversationId: pending.targetConversationId, phase: pending.phase }
      : null,
    launchStartedAt: session.launchPending?.providerLaunchedAt ?? null,
    quotaAccountId: quotaAccountIdFor(session),
    recoverable: deadSessionRecovery(session).ok,
    workspace: session.workspace ?? null,
    startupPrompt: session.startupPrompt
      ? { kind: session.startupPrompt.kind, ...(session.runtimeId ? { runtimeId: session.runtimeId } : {}) }
      : null,
    undeliveredMessages: (active?.unconfirmedSends ?? [])
      .filter((send) => send.flagged)
      .map((send) => ({ text: send.text, sentAt: send.at })),
    lastUserMessageAt: session.lastUserMessageAt,
    lastUserMessageText: session.lastUserMessageText,
    deliveryUnconfirmedText: session.deliveryUnconfirmedText,
    // PWAs cached before stuckSince read the stuck hint from lastError, so
    // it is still written there for them (see "相容性與棄用" in
    // docs/reference/api-contract-v1.md). Current clients read stuckSince.
    lastError: session.lastError ?? (session.stuckSince ? t('session.stuck.hint') : null),
    stuckSince: session.stuckSince ?? null,
    pendingInteraction: session.pendingInteraction,
    activeConversationId: session.activeConversationId ?? null,
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      sequence: conversation.sequence,
      provider: conversation.provider,
      ...(conversation.runtimeId ? { runtimeId: conversation.runtimeId } : {}),
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      startReason: conversation.startReason,
      endReason: conversation.endReason,
      transcriptState: conversation.transcript.state,
      transcriptError: conversation.transcriptError,
      turnsCount: conversation.turns.length,
      turnsFingerprint: turnsFingerprint(conversation.turns),
      ...resumeBlockedFields(conversation),
      launchProfile: conversation.launchProfile ? {
        id: conversation.launchProfile.id,
        source: conversation.launchProfile.source,
        ...(conversation.launchProfile.runtimeId ? { runtimeId: conversation.launchProfile.runtimeId } : {}),
        ...(conversation.launchProfile.profileName ? { profileName: conversation.launchProfile.profileName } : {}),
        permissionMode: conversation.launchProfile.permissionMode ?? 'cli_default',
      } : null,
      handoff: publicSegmentHandoff(conversation.handoff),
      userMessagesCount: conversation.transcript.state === 'resolved' ? countUserMessages(conversation.turns) : null,
    })),
    fork: session.forkOrigin ? { ...session.forkOrigin } : null,
    delegation: session.delegationOrigin ? { ...session.delegationOrigin } : null,
    closable: session.closable ? { ...session.closable } : null,
    spawnClosedAt: session.spawnClosedAt ?? null,
    launchProfile: profile ? {
      id: profile.id,
      provider: profile.provider,
      ...(profile.runtimeId ? { runtimeId: profile.runtimeId } : {}),
      source: profile.source,
      ...(profile.profileName ? { profileName: profile.profileName } : {}),
      delegate: profile.delegate.kind,
      permissionMode: profile.permissionMode ?? 'cli_default',
    } : null,
  };
}

// The last thing said in a turn: its reply, or its message when the reply
// has no text (yet). null when neither has any.
function lastMessageOf(turn: Turn | undefined): TrashedSessionDto['lastMessage'] {
  const reply = typeof turn?.assistant?.text === 'string' ? turn.assistant.text.trim() : '';
  const sent = typeof turn?.user?.text === 'string' ? turn.user.text.trim() : '';
  const [role, text, at] = reply
    ? ['assistant' as const, reply, turn?.assistant.at ?? null]
    : ['user' as const, sent, turn?.user.at ?? null];
  if (!text) return null;
  return { role, text: Array.from(text).slice(0, TRASH_LAST_MESSAGE_CHARS).join(''), at: typeof at === 'string' ? at : null };
}

/**
 * A trashed session as the trash lists it (contract TrashedSessionDto):
 * the public session plus when it was deleted and its last message — the
 * active conversation's last turn, else the latest conversation that has
 * any (a record from before conversations: its own turns). Records of any
 * age come through: no conversations, no provider, empty texts.
 */
export function toTrashedSessionDto(session: ManagedSession): TrashedSessionDto {
  const conversations = Array.isArray(session.conversations) ? session.conversations : [];
  const hasTurns = (conversation: ConversationSegment | undefined) => Array.isArray(conversation?.turns) && conversation.turns.length > 0;
  const active = conversations.find((conversation) => conversation.id === session.activeConversationId);
  const source = hasTurns(active)
    ? active!.turns
    : [...conversations].reverse().find(hasTurns)?.turns ?? (Array.isArray(session.turns) ? session.turns : []);
  return {
    ...toSessionDto(session),
    deletedAt: typeof session.deletedAt === 'string' ? session.deletedAt : '',
    lastMessage: lastMessageOf(source.at(-1)),
  };
}
