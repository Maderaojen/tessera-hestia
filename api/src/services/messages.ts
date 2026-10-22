import type { TextRange } from '../contract/attachments.js';
import { pastedTextMarks } from '../pastedText.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import type { RuntimeDriver } from '../runtimes/types.js';
import { importTurnsAfterStop } from '../polling.js';
import { sendRuntimeText, stopKeyFor } from '../sync/input.js';
import { refreshStartupPrompt, startupPromptPossible } from '../sync/startupPrompt.js';
import { applyTurnEffects } from '../sync/turnEffects.js';
import { endIfTmuxGone } from './sessions.js';
import { nextTurn, turnStateOf } from '../sync/turnMachine.js';
import * as tmuxCli from '../tmux.js';
import type { ManagedSession, Provider } from '../types.js';

// Typing into a session's running CLI: the app's send and /clear
// (routes/messages.ts), and an automatic carry-on after a usage limit
// (continuity/), all go through the same checks.

export type RunningSession = ManagedSession & { provider: Provider; activeConversationId: string };

export type Gate =
  | { ok: true; session: RunningSession; runtime: RuntimeDriver | undefined }
  | { ok: false; status: number; code: 'not_found' | 'session_dead' | 'no_active_conversation' | 'startup_prompt_pending' | 'interaction_pending'; message: string };

/**
 * What anything typed into the running CLI needs first — a message, or the
 * app's /clear (typed or from its own endpoint): a tmux that still exists
 * with a bound conversation, and no prompt on screen that the CLI waits on — its
 * start-up prompt, a permission or a question. Those are the cases input is
 * held back: anything typed would be eaten by the prompt, and its Enter
 * would answer it (a permission's highlighted "Yes" approves the tool). The
 * pane is read right before sending, since the poller may not have seen a
 * prompt that just opened. An unrecognized screen never blocks (see the
 * send route's comment).
 */
export async function gateRunningConversation(
  session: ManagedSession | null | undefined,
  messages: { startupPrompt: string; interaction: string },
): Promise<Gate> {
  if (!session) return { ok: false, status: 404, code: 'not_found', message: 'not found' };
  if (session.status === 'dead') return { ok: false, status: 409, code: 'session_dead', message: 'session is dead' };
  // The record can lag behind tmux (killed outside the app, its server gone).
  if (await endIfTmuxGone(session)) return { ok: false, status: 409, code: 'session_dead', message: 'session is dead' };
  if (!session.provider || !session.activeConversationId) {
    return { ok: false, status: 409, code: 'no_active_conversation', message: 'no active CLI conversation is bound to this tmux session' };
  }
  const activeSegment = session.conversations?.find((item) => item.id === session.activeConversationId);
  const runtime = activeSegment ? recordedRuntime(session, activeSegment) : undefined;
  if (runtime && startupPromptPossible(session, activeSegment, runtime) && await refreshStartupPrompt(session, runtime)) {
    return { ok: false, status: 409, code: 'startup_prompt_pending', message: messages.startupPrompt };
  }
  if (session.pendingInteraction || await interactionOnScreen(session, runtime)) {
    return { ok: false, status: 409, code: 'interaction_pending', message: messages.interaction };
  }
  return { ok: true, session: session as RunningSession, runtime };
}

async function interactionOnScreen(session: ManagedSession, runtime: RuntimeDriver | undefined): Promise<boolean> {
  if (!runtime?.readPaneInteraction) return false;
  const pane = await tmuxCli.capturePane(session.tmuxName).catch(() => null);
  return pane !== null && runtime.readPaneInteraction(pane) !== null;
}

/**
 * Types `text` into the CLI and records it as the app's send: the turn goes
 * to replying and the send is tracked until the transcript shows it. Only
 * after gateRunningConversation let it through.
 */
/**
 * The stop button: the runtime's interrupt key, the turn unlocked, and the
 * interrupted reply imported in the background. Only a replying /
 * awaiting_approval turn is unlocked; otherwise the key is all this does.
 */
export async function stopReply(session: RunningSession): Promise<ManagedSession | undefined> {
  const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
  await tmuxCli.sendKey(session.tmuxName, stopKeyFor(recordedRuntime(session, conversation)));
  const stopped = nextTurn(turnStateOf(session), { type: 'stop' });
  const updated = await applyTurnEffects(session, { id: session.activeConversationId }, stopped.effects);
  importTurnsAfterStop(session.id).catch((err: unknown) => console.error(`[stop] importing the interrupted turn for ${session.id} failed`, err));
  return updated;
}

export async function sendUserMessage(
  session: RunningSession,
  runtime: RuntimeDriver | undefined,
  text: string,
  pastes: readonly TextRange[] = [],
): Promise<ManagedSession | undefined> {
  await sendRuntimeText(session.tmuxName, runtime, text);
  const sent = nextTurn(turnStateOf(session), { type: 'send', text, at: new Date().toISOString(), pastes: pastedTextMarks(text, pastes) });
  return applyTurnEffects(session, { id: session.activeConversationId }, sent.effects);
}
