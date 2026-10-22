import * as registry from '../registry.js';
import { answerTrustMenu, type StartupAnswer } from '../runtimes/startup-prompt-menu.js';
import type { RuntimeDriver, StartupChoice, StartupPromptReading } from '../runtimes/types.js';
import * as tmuxCli from '../tmux.js';
import type { ConversationSegment, ManagedSession } from '../types.js';

/**
 * Whether a start-up prompt can still be on screen: only before the
 * conversation has a transcript (a CLI shows it before accepting its first
 * input), or while one is already recorded. Keeps pane reads off ordinary
 * running sessions.
 */
export function startupPromptPossible(session: ManagedSession, conversation: ConversationSegment | undefined, runtime: RuntimeDriver | undefined): boolean {
  if (!runtime?.readStartupPrompt || session.status !== 'ready' || session.clearPending) return false;
  return !!session.startupPrompt || !!conversation && conversation.transcript.state !== 'resolved';
}

/**
 * Reads the pane once and records whether the runtime's start-up prompt is
 * showing (written only when that changes). A failed capture changes
 * nothing. Returns the reading, or null when no prompt is visible.
 */
export async function refreshStartupPrompt(session: ManagedSession, runtime: RuntimeDriver): Promise<StartupPromptReading | null> {
  let pane: string;
  try { pane = await tmuxCli.capturePane(session.tmuxName); }
  catch { return session.startupPrompt ? { kind: session.startupPrompt.kind, selected: null } : null; }
  const reading = runtime.readStartupPrompt?.(pane) ?? null;
  if (reading && !session.startupPrompt) {
    await registry.updateSession(session.id, { startupPrompt: { kind: reading.kind, detectedAt: new Date().toISOString() } });
  } else if (!reading && session.startupPrompt) {
    await registry.updateSession(session.id, { startupPrompt: null });
  }
  return reading;
}

export type { StartupAnswer };

/**
 * Selects `choice` in the runtime's start-up prompt in this tmux and
 * confirms it (see answerTrustMenu). 'unsure' means nothing was confirmed;
 * the user should look at the terminal.
 */
export async function answerStartupPrompt(tmuxName: string, runtime: RuntimeDriver, choice: StartupChoice): Promise<StartupAnswer> {
  return answerTrustMenu(
    { capture: () => tmuxCli.capturePane(tmuxName), sendKey: (key) => tmuxCli.sendKey(tmuxName, key) },
    (pane) => runtime.readStartupPrompt?.(pane) ?? null,
    choice,
  );
}
