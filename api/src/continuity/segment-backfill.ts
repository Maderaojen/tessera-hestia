import { handoffMessageKind } from '../contract/continuity.js';
import type { ConversationSegment, ManagedSession, SegmentHandoffRecord } from '../types.js';

// Conversations started by a handoff before handoffs were written on them
// (ConversationSegment.handoff): found from the briefing message the
// handoff typed, at start-up. The
// brief's file name carries only the handoff id's first 8 characters, so
// that is all an older one is known by. Only fills in what is missing, so
// running it again changes nothing.

const BRIEF_FILE = /\.hestia[/\\]handoffs[/\\]([^/\\\s（）()]+-([0-9a-f]{8})\.md)/;
// The briefing is the conversation's first message; a few are looked at in
// case something came before it.
const LOOKED_AT = 3;

export type SegmentBackfillPorts = {
  // Trashed sessions too: one restored later shows its handoffs.
  sessions(): Promise<ManagedSession[]>;
  updateConversation(sessionId: string, conversationId: string, patch: Partial<ConversationSegment>): Promise<unknown>;
};

/** The handoff an older conversation started from, when its briefing says so. */
export function derivedHandoff(conversation: ConversationSegment, previous: ConversationSegment | undefined): SegmentHandoffRecord | null {
  if (conversation.handoff || conversation.startReason !== 'provider_switch') return null;
  for (const turn of conversation.turns.slice(0, LOOKED_AT)) {
    const text = turn.user?.text ?? '';
    if (handoffMessageKind(text) !== 'brief') continue;
    const match = BRIEF_FILE.exec(text);
    if (!match) return null;
    return {
      handoffId: match[2]!,
      trigger: null,
      fromConversationId: previous?.id ?? null,
      briefSource: null,
      source: null,
      briefNote: null,
      briefNoteCode: null,
      confirm: null,
      briefAmended: null,
      derived: true,
      briefFile: `.hestia/handoffs/${match[1]}`,
    };
  }
  return null;
}

/** How many conversations it filled in. */
export async function backfillSegmentHandoffs(ports: SegmentBackfillPorts): Promise<number> {
  let filled = 0;
  for (const session of await ports.sessions()) {
    const conversations = [...(session.conversations ?? [])].sort((a, b) => a.sequence - b.sequence);
    for (const [index, conversation] of conversations.entries()) {
      const handoff = derivedHandoff(conversation, conversations[index - 1]);
      if (!handoff) continue;
      await ports.updateConversation(session.id, conversation.id, { handoff });
      filled += 1;
    }
  }
  return filled;
}
