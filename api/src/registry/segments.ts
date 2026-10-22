import type { ConversationSegment, ManagedSession } from '../types.js';

type SegmentStart = Pick<ConversationSegment,
  'id' | 'provider' | 'runtimeId' | 'launchProfile' | 'providerSessionId' | 'startedAt' | 'startReason' | 'transcriptTurnOffset'>;

/**
 * A new, still-open CLI segment after the session's existing ones: no
 * transcript bound yet, nothing sent, no turns. The one place a segment is
 * built, so every way one starts (launch, /clear, runtime recovery) records
 * the same fields.
 */
export function newSegment(existing: readonly ConversationSegment[], start: SegmentStart): ConversationSegment {
  return {
    ...start,
    sequence: existing.reduce((max, conversation) => Math.max(max, conversation.sequence), 0) + 1,
    kind: 'cli',
    endedAt: null,
    endReason: null,
    transcript: { state: 'pending', file: null, identity: null },
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    pendingInteraction: null,
    transcriptError: null,
    turns: [],
  };
}

/**
 * The session's copy of its active segment's fields, emptied: what it holds
 * once the active segment is a fresh one or there is none. (Those fields
 * mirror the active segment — see updateConversation.)
 */
export function emptyActiveMirror(): Pick<ManagedSession,
  'lastUserMessageAt' | 'lastUserMessageText' | 'deliveryUnconfirmedText' | 'pendingInteraction' | 'turns' | 'turnsSourceFile'> {
  return {
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    pendingInteraction: null,
    turns: [],
    turnsSourceFile: null,
  };
}
