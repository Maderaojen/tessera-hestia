import * as registry from '../registry.js';
import { activeTurnPhase, type ConversationSegment, type ManagedSession } from '../types.js';
import { resetTurnWatch, trackerFor } from './tracker.js';
import { nextTurn, turnStateOf, type TurnEffect } from './turnMachine.js';
import { commitTurns, type TurnChanges } from './turns.js';
import { recordSend } from './delivery.js';

type SessionPatch = Partial<Omit<ManagedSession, 'conversations'>>;
// How many terminal-typed messages a conversation remembers, for marking them.
const TERMINAL_MESSAGES_KEPT = 200;
// How many pasted parts of the app's sends a conversation remembers.
const PASTED_TEXTS_KEPT = 200;
type ConversationPatch = Partial<Omit<ConversationSegment, 'id' | 'sequence'>>;

// The one place nextTurn's effects reach the registry: all of them folded
// into a single write (so a single SSE update), or none when there are no
// effects. Returns the updated session, or `session` itself when nothing
// was written. `conversation` is the active one — just its id is enough
// unless turns are imported; without one, everything lands on the session.
export async function applyTurnEffects(
  session: ManagedSession,
  conversation: ConversationSegment | Pick<ConversationSegment, 'id'> | null,
  effects: TurnEffect[],
): Promise<ManagedSession | undefined> {
  if (effects.length === 0) return session;
  const sessionPatch: SessionPatch = {};
  const conversationPatch: ConversationPatch = {};
  let imported: TurnChanges | null = null;

  for (const effect of effects) {
    switch (effect.kind) {
      // The one write of turnPhase besides the reset on entering 'ready'.
      case 'enter_phase':
        sessionPatch.turnPhase = effect.phase;
        // When the app ended a turn: one the transcript still shows open is
        // taken up again only if written after this (polling.ts pollIdle).
        if (effect.phase === 'idle' && activeTurnPhase(session) !== 'idle') trackerFor(session.id).turnEndedAt = Date.now();
        break;
      case 'record_sent': {
        conversationPatch.lastUserMessageAt = effect.at;
        conversationPatch.lastUserMessageText = effect.text;
        conversationPatch.deliveryUnconfirmedText = null;
        if (effect.pastes) {
          const known = session.conversations?.find((candidate) => candidate.id === conversation?.id)?.pastedTexts ?? [];
          conversationPatch.pastedTexts = [...known, ...effect.pastes].slice(-PASTED_TEXTS_KEPT);
        }
        if (effect.fromTerminal) {
          const known = session.conversations?.find((candidate) => candidate.id === conversation?.id)?.terminalMessageAts ?? [];
          conversationPatch.terminalMessageAts = [...known.filter((at) => at !== effect.at), effect.at].slice(-TERMINAL_MESSAGES_KEPT);
        }
        // Earlier unconfirmed sends stay tracked; the next send never erases them.
        if (conversation) {
          const tracked = session.conversations?.find((candidate) => candidate.id === conversation.id)?.unconfirmedSends;
          // `session` is still the state from before this send.
          const midReply = activeTurnPhase(session) === 'replying';
          conversationPatch.unconfirmedSends = recordSend(tracked, effect.text, effect.at, midReply);
        }
        break;
      }
      case 'import_turns':
        imported = effect.changes;
        break;
      // Written on both sides: the session mirrors its active conversation
      // anyway, and a session with no active conversation still has one.
      case 'set_pending':
        conversationPatch.pendingInteraction = effect.interaction;
        sessionPatch.pendingInteraction = effect.interaction;
        break;
      case 'clear_pending':
        conversationPatch.pendingInteraction = null;
        sessionPatch.pendingInteraction = null;
        break;
      case 'set_stuck_hint':
        sessionPatch.stuckSince = new Date().toISOString();
        break;
      case 'clear_stuck_hint':
        sessionPatch.stuckSince = null;
        break;
      case 'clear_last_error':
        sessionPatch.lastError = null;
        sessionPatch.stuckSince = null;
        break;
      case 'set_pane_activity':
        sessionPatch.paneActivity = effect.value;
        break;
      case 'restart_turn_watch':
        resetTurnWatch(session.id);
        break;
    }
  }

  // commitTurns writes only the turns on the conversation side; nextTurn
  // never pairs an import with another conversation field.
  const touchesConversation = Object.keys(conversationPatch).length > 0;
  if (imported) {
    if (!conversation || !('turns' in conversation)) throw new Error('importing turns needs the active conversation');
    if (touchesConversation) throw new Error('an import cannot carry other conversation fields');
    return commitTurns(session, conversation, imported, sessionPatch);
  }
  if (!touchesConversation) return registry.updateSession(session.id, sessionPatch);
  if (conversation) return registry.updateConversation(session.id, conversation.id, conversationPatch, sessionPatch);
  // The session-level copies share the conversation fields' names.
  return registry.updateSession(session.id, { ...conversationPatch, ...sessionPatch });
}

// The CLI runtime just left 'ready' (the CLI exited, its tmux is gone, a
// /clear or conversation switch began): clears what the ended turn left
// behind (a pending prompt, the stuck hint, the pane reading). `session` is
// the record after the lifecycle write. Nothing is written when there is
// nothing to clear.
export async function applyRuntimeLeftReady(session: ManagedSession): Promise<ManagedSession | undefined> {
  const { effects } = nextTurn(turnStateOf(session), { type: 'runtime_left_ready' });
  return applyTurnEffects(session, session.activeConversationId ? { id: session.activeConversationId } : null, effects);
}
