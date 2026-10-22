import { Router } from 'express';
import { z } from 'zod';
import * as registry from '../registry.js';
import * as tmuxCli from '../tmux.js';
import { CONTROL_KEYS } from '../tmux.js';
import { legacyStatusOf } from '../types.js';
import { publicTurns, toPublicManagedSession } from '../session-dto.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import { noteControlKey, refreshPendingInteraction } from '../polling.js';
import { applyTurnEffects } from '../sync/turnEffects.js';
import { nextTurn, turnStateOf } from '../sync/turnMachine.js';
import * as transitions from '../services/transitions.js';
import { sendTransitionResult } from './transition-response.js';
import { recordRequestEvent, transitionOutcome } from './session-event.js';
import { dismissSend } from '../sync/delivery.js';
import { sendRuntimeText } from '../sync/input.js';
import { answerInteraction, type AnswerOutcome } from '../sync/interaction.js';
import { answerStartupPrompt, refreshStartupPrompt } from '../sync/startupPrompt.js';
import { gateRunningConversation, sendUserMessage, stopReply, type RunningSession } from '../services/messages.js';
import { sendError } from './errors.js';

export const messagesRouter = Router();

// pastes (capability composer_attachments): the parts of `text` that were
// pasted text, so the chat can show each as one block (pastedText.ts).
const sendSchema = z.object({
  text: z.string().min(1),
  pastes: z.array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) })).max(100).optional(),
});
const STARTUP_PROMPT_BLOCKS_SEND = 'the CLI is asking whether to trust this folder; the message was not sent';
const STARTUP_PROMPT_BLOCKS_CLEAR = 'the CLI is asking whether to trust this folder; answer it before a new conversation';
const INTERACTION_BLOCKS_SEND = 'the CLI is waiting on a confirmation or question; the message was not sent';
// Time for the CLI to move on after an answer, before it is read again.
const INTERACTION_REDRAW_MS = 400;
const INTERACTION_BLOCKS_CLEAR = 'the CLI is waiting on a confirmation or question; answer it before a new conversation';

// The app's "建立新的對話": the same restart a /clear typed into the
// composer triggers (transitions.clearAndRelaunch), as its own action so
// a client needn't send a magic string. Old conversation stays listed.
messagesRouter.post('/:id/clear', async (req, res) => {
  const gate = await gateRunningConversation(await registry.getSession(req.params.id), { startupPrompt: STARTUP_PROMPT_BLOCKS_CLEAR, interaction: INTERACTION_BLOCKS_CLEAR });
  if (!gate.ok) {
    sendError(res, gate.status, gate.code, gate.message);
    return;
  }
  const result = await transitions.clearAndRelaunch(gate.session);
  await recordRequestEvent(req, gate.session.id, 'clear', transitionOutcome(result));
  sendTransitionResult(res, result);
});

// When the old CLI didn't exit in time (the poller moves the clear to
// 'awaiting_force'): reset the pane and carry on, or drop the clear and
// leave the CLI running. Same as a conversation switch's.
messagesRouter.post('/:id/clear/force', async (req, res) => {
  const result = await transitions.forceClear(req.params.id);
  await recordRequestEvent(req, req.params.id, 'clear_force', transitionOutcome(result));
  sendTransitionResult(res, result);
});

messagesRouter.post('/:id/clear/cancel', async (req, res) => {
  const result = await transitions.cancelClear(req.params.id);
  await recordRequestEvent(req, req.params.id, 'clear_cancel', transitionOutcome(result));
  sendTransitionResult(res, result);
});

// Fire-and-forget from the frontend's point of view: this returns as soon
// as the text has been typed into the pane. The reply shows up later via
// GET, once polling.ts finds a finalized turn in the provider's session
// log — the frontend is expected to poll that endpoint and show "等待中"
// in between.
//
// Deliberately no longer gated on session.status === 'ready'. It used to
// 409 otherwise, but our own "is it ready" detection is structurally
// unable to recognize some real cases (a CLI-native slash command like
// `/rc` never produces a transcript entry our parser treats as real
// conversation — see conversation notes — so a turn could get stuck
// replying forever with no way to clear it). A real terminal doesn't
// block you from typing just because it isn't sure the foreground
// process is ready to read stdin either; the worst case there (and here,
// now) is a keystroke that doesn't do anything, which is a far smaller
// problem than a permanently unusable composer. polling.ts's delivery-echo
// check (see its own comment) is what actually tells the user when a
// send seems to have gone nowhere, instead of preventing the send itself.
messagesRouter.post('/:id/messages', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const gate = await gateRunningConversation(await registry.getSession(req.params.id), { startupPrompt: STARTUP_PROMPT_BLOCKS_SEND, interaction: INTERACTION_BLOCKS_SEND });
  if (!gate.ok) {
    sendError(res, gate.status, gate.code, gate.message);
    return;
  }
  const { session, runtime: activeRuntime } = gate;

  const text = parsed.data.text.trim();
  if (text === '/clear') {
    const result = await transitions.clearAndRelaunch(session);
    await recordRequestEvent(req, session.id, 'clear', transitionOutcome(result), { typed: true });
    sendTransitionResult(res, result);
    return;
  }

  const updated = await sendUserMessage(session, activeRuntime, parsed.data.text, parsed.data.pastes);
  res.status(202).json(updated ? toPublicManagedSession(updated) : undefined);
});

// Deprecated (contract v1): a chat reads its turns from
// GET /sessions/:id/conversations/:id. Kept only for older clients; see
// "相容性與棄用" in docs/reference/api-contract-v1.md.
messagesRouter.get('/:id/messages', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.json({
    // The legacy six-value status, as in the session DTO.
    status: legacyStatusOf(session),
    turns: publicTurns(session.turns),
    lastError: session.lastError,
    pendingInteraction: session.pendingInteraction,
  });
});

const respondSchema = z.union([
  z.object({ key: z.enum(CONTROL_KEYS) }),
  z.object({ text: z.string().min(1) }),
]);

// A pure keystroke/text forward — nothing more. It does NOT assume sending
// a key resolves anything: pressing Right to move to the next item in an
// open menu doesn't end the interaction, so `status`/`pendingInteraction`
// are left exactly as they are. Only polling.ts (which keeps watching
// awaiting_approval turns, not just replying ones) decides when a pending
// interaction has actually gone away, by re-checking the transcript for a
// tool_result. Available any time the CLI is actually running (not just
// mid-interaction) — sending Esc to interrupt a normal reply is a
// legitimate thing to want to do too.
messagesRouter.post('/:id/respond', async (req, res) => {
  const parsed = respondSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (!session.provider || session.status === 'dead') {
    sendError(res, 409, 'no_running_cli', `no running CLI to send to (status: ${session.status})`, { status: session.status });
    return;
  }
  if (!session.activeConversationId) {
    sendError(res, 409, 'no_active_conversation', 'no active CLI conversation is bound to this tmux session');
    return;
  }

  if ('key' in parsed.data) {
    await tmuxCli.sendKey(session.tmuxName, parsed.data.key);
  } else {
    const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
    await sendRuntimeText(session.tmuxName, recordedRuntime(session, conversation), parsed.data.text);
  }

  // Resets the stuck-hint clock — but does NOT clear lastError itself.
  // Same mistake as forcing status/pendingInteraction used to be: sending a
  // key doesn't confirm anything got fixed, so clearing the hint here just
  // makes the warning banner (and its buttons) vanish after one keypress
  // even though nothing is actually known to have changed. Deliberately not
  // lastUserMessageAt anymore: that one means "when the last real message
  // was sent", and a keypress bumping it made a message typed straight into
  // tmux a moment earlier look older than it, so it was never picked up as
  // new (see polling.ts pollIdle).
  noteControlKey(session.id);
  res.status(202).json(toPublicManagedSession(session));
});

// Answers a recognized start-up prompt (e.g. Agy's workspace trust) on the
// user's behalf. The option is selected by re-reading the pane after every
// key, and confirmed only once it is positively under the cursor.
const startupAnswerSchema = z.object({ choice: z.enum(['trust', 'decline']) });
messagesRouter.post('/:id/startup-prompt', async (req, res) => {
  const parsed = startupAnswerSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'invalid body');
    return;
  }
  const session = await registry.getSession(req.params.id);
  const conversation = session?.conversations?.find((item) => item.id === session.activeConversationId);
  if (!session || !conversation) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const runtime = recordedRuntime(session, conversation);
  if (!runtime?.readStartupPrompt || session.status !== 'ready') {
    sendError(res, 409, 'no_startup_prompt', 'this CLI has no start-up prompt the app can answer');
    return;
  }
  let answer;
  try {
    answer = await answerStartupPrompt(session.tmuxName, runtime, parsed.data.choice);
  } catch {
    answer = 'unsure' as const;
  }
  // Whatever happened, the next read decides whether the prompt is gone.
  const refreshed = (await registry.getSession(session.id)) ?? session;
  if (answer !== 'unsure') await refreshStartupPrompt(refreshed, runtime).catch(() => null);
  const latest = (await registry.getSession(session.id)) ?? refreshed;
  if (answer === 'unsure') {
    sendError(res, 409, 'startup_prompt_unconfirmed', 'the option could not be found, so nothing was sent; answer in the terminal');
    return;
  }
  res.json(toPublicManagedSession(latest));
});

// Answers the prompt the CLI waits on — a permission or a question, as read
// from its screen (PendingInteraction.screen) — with one of its options,
// plus text for a free-text row or a note sent along with a permission (see
// sync/interaction.ts). `promptId` names the prompt the user answered: a
// different one on screen by now (the next question) is left alone.
const interactionSchema = z.object({
  promptId: z.string().min(1).max(200),
  option: z.union([z.number().int().positive(), z.literal('next')]),
  text: z.string().max(4000).optional(),
});
const answering = new Set<string>();
messagesRouter.post('/:id/interaction', async (req, res) => {
  const parsed = interactionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const session = await registry.getSession(req.params.id);
  const conversation = session?.conversations?.find((item) => item.id === session.activeConversationId);
  if (!session || !conversation) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const runtime = recordedRuntime(session, conversation);
  const read = runtime?.readPaneInteraction;
  if (!read || session.status !== 'ready' || answering.has(session.id)) {
    sendError(res, 409, 'no_interaction', 'the CLI has no confirmation or question the app can answer');
    return;
  }
  answering.add(session.id);
  let outcome: AnswerOutcome;
  try {
    outcome = await answerInteraction({
      capture: () => tmuxCli.capturePane(session.tmuxName),
      sendKey: (key) => tmuxCli.sendKey(session.tmuxName, key),
      type: (text) => tmuxCli.typeText(session.tmuxName, text),
    }, (pane) => read(pane), parsed.data);
  } catch {
    outcome = 'unsure';
  } finally {
    answering.delete(session.id);
  }
  if (outcome === 'answered') {
    noteControlKey(session.id);
    // Whatever comes next — the next question, or the reply — shows now.
    await new Promise((resolve) => setTimeout(resolve, INTERACTION_REDRAW_MS));
  }
  await refreshPendingInteraction(session.id).catch(() => {});
  const latest = (await registry.getSession(session.id)) ?? session;
  switch (outcome) {
    case 'answered':
      res.json(toPublicManagedSession(latest));
      return;
    case 'not_shown':
      sendError(res, 409, 'no_interaction', 'the CLI is no longer waiting on this confirmation or question');
      return;
    case 'changed':
      sendError(res, 409, 'interaction_changed', 'the confirmation or question on screen has changed');
      return;
    case 'invalid':
      sendError(res, 409, 'interaction_answer_invalid', 'this option can\'t be answered that way');
      return;
    case 'unsure':
      sendError(res, 409, 'interaction_unconfirmed', 'the option or typed text could not be confirmed, so nothing was sent');
      return;
  }
});

// Stops tracking one send the CLI never showed (see sync/delivery.ts): the
// user dismissed it, or put its text back into the composer to send again.
// Only the tracking entry is dropped; nothing is sent to the pane.
const dismissSchema = z.object({ sentAt: z.string().min(1) });
messagesRouter.post('/:id/undelivered/dismiss', async (req, res) => {
  const parsed = dismissSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'invalid body');
    return;
  }
  const session = await registry.getSession(req.params.id);
  const conversation = session?.conversations?.find((item) => item.id === session.activeConversationId);
  if (!session || !conversation) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const next = dismissSend(conversation.unconfirmedSends, parsed.data.sentAt);
  if (!next) {
    res.json(toPublicManagedSession(session));
    return;
  }
  const latest = next.at(-1);
  const updated = await registry.updateConversation(session.id, conversation.id, {
    unconfirmedSends: next,
    deliveryUnconfirmedText: latest?.flagged && latest.text === conversation.lastUserMessageText ? latest.text : null,
  });
  res.json(toPublicManagedSession(updated ?? session));
});

// The composer's stop button: interrupts the in-flight reply the same way
// pressing Esc in the terminal does, then unlocks the session straight to
// an idle turn. Unlike /respond, this one does assume the key resolved
// things — an interrupted reply never gets the structural completion signal
// polling.ts waits for (see isTurnComplete), so leaving the turn
// replying would keep the stop button (and the "生成中…" bubble) around
// until the stuck-hint timeout instead of ending right away. The
// interrupted turn itself is imported in the background right after (see
// polling.ts importTurnsAfterStop) and reaches the frontend over SSE.
messagesRouter.post('/:id/stop', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (!session.provider || session.status === 'dead' || !session.activeConversationId) {
    sendError(res, 409, 'no_running_cli', `no running CLI to stop (status: ${session.status})`, { status: session.status });
    return;
  }
  if (session.clearPending) {
    sendError(res, 409, 'clear_in_progress', 'CLI is restarting after /clear');
    return;
  }

  const updated = await stopReply(session as RunningSession);
  res.json(updated ? toPublicManagedSession(updated) : undefined);
});

// For when the user resolved something by hand directly in the terminal
// (pressed Esc themselves, answered a prompt, ...) without going through
// this API at all — we have no way to confirm that from the transcript, so
// this is a deliberate, explicit "trust me" unlock rather than something
// auto-detected. Goes straight to an idle turn (not replying): nothing was just
// sent for polling to watch for, the session is simply free to accept a new
// message again.
// Deprecated (contract v1): its name is easily confused with
// /conversations/:id/resume. Kept only for older clients; see
// docs/reference/api-contract-v1.md.
messagesRouter.post('/:id/resume', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  // Only a replying / awaiting_approval session has anything to unlock.
  const resumed = nextTurn(turnStateOf(session), { type: 'manual_resume' });
  if (resumed.effects.length === 0) {
    sendError(res, 409, 'nothing_to_resume', `session isn't in a state that needs resuming (status: ${session.status})`, { status: session.status });
    return;
  }

  const updated = await applyTurnEffects(session, session.activeConversationId ? { id: session.activeConversationId } : null, resumed.effects);
  res.json(updated ? toPublicManagedSession(updated) : undefined);
});
