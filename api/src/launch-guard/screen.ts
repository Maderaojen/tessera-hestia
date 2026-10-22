import * as registry from '../registry.js';
import { readLaunchScreen, paneTail } from '../runtimes/launch-screen.js';
import { recordedRuntime, segmentRuntime } from '../runtimes/resolve.js';
import { answerMenu, type StartupAnswer } from '../runtimes/startup-prompt-menu.js';
import type { RuntimeDriver } from '../runtimes/types.js';
import { activeConversation } from '../sync/binding.js';
import * as tmuxCli from '../tmux.js';
import type { ManagedSession } from '../types.js';
import type { ScreenReading } from './decide.js';

// The launch guard's looks at a real pane (ADR 0030), one implementation
// for every caller: continuity's and spawn's wiring both pass these as
// their ports.

// The runtime of the CLI on screen; once it has quit, of the conversation
// it was on (whose screen it left behind).
function screenRuntime(session: ManagedSession): RuntimeDriver | undefined {
  const active = activeConversation(session);
  if (active) return recordedRuntime(session, active);
  const last = [...(session.conversations ?? [])].reverse().find((conversation) => conversation.provider);
  return last ? segmentRuntime(last) : undefined;
}

/** One look at the session's pane, read as a launch screen; null when it can't be read. */
export async function readScreen(sessionId: string): Promise<ScreenReading | null> {
  const session = await registry.getSession(sessionId);
  const runtime = session ? screenRuntime(session) : undefined;
  if (!session || !runtime) return null;
  const pane = await tmuxCli.capturePane(session.tmuxName).catch(() => null);
  if (pane === null) return null;
  return { screen: readLaunchScreen(runtime, pane), tail: paneTail(pane) };
}

/**
 * Chooses "Skip" in the CLI's update menu, only once the cursor is
 * positively on it (answerMenu). 'unsure': nothing was confirmed.
 */
export async function skipUpdatePrompt(sessionId: string): Promise<StartupAnswer> {
  const session = await registry.getSession(sessionId);
  const runtime = session ? screenRuntime(session) : undefined;
  const read = runtime?.updatePrompt?.read;
  if (!session || !read) return 'unsure';
  return answerMenu(
    { capture: () => tmuxCli.capturePane(session.tmuxName), sendKey: (key) => tmuxCli.sendKey(session.tmuxName, key) },
    read,
    'skip',
  ).catch(() => 'unsure' as const);
}
