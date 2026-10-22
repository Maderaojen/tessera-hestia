import type { TurnPhase } from '../contract/sessions.js';
import type { ScreenReading } from '../launch-guard/decide.js';

// What spawn/startup.ts reads from or does to a session's CLI. Delegation
// and branch lines pass their own ports (real ones in their wiring.ts,
// fakes in tests), which carry these among the rest.

/** A session's CLI as a delegation or a branch line sees it. */
export type SessionView = {
  running: boolean;
  switching: boolean;
  phase: TurnPhase | null;
  lastTurnAt: string | null;
  lastSentAt: string | null;
  // The active conversation's launch profile (continuity may hand it to
  // another one in the same tmux).
  profileId: string | null;
  // A CLI is bound to it (launched, or being launched).
  provider: string | null;
  launching: boolean;
  // The start-up prompt on screen, if the app recognizes one.
  startupPrompt: 'workspace_trust' | null;
  // A permission or question the CLI waits on.
  interaction: boolean;
  lastError: string | null;
};

export type SendOutcome =
  | { status: 'sent' }
  // The CLI is waiting on a prompt; try again later.
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string };

export type SpawnPorts = {
  // Any session's CLI; null when the session is gone.
  readChild(sessionId: string): Promise<SessionView | null>;
  // Answers the CLI's start-up trust prompt with "trust".
  answerTrust(sessionId: string): Promise<'answered' | 'unsure'>;
  send(sessionId: string, text: string): Promise<SendOutcome>;
  // Whether the CLI took `text` in whole as its latest user message since
  // `since` (continuity's read-back).
  checkDelivered(sessionId: string, text: string, since: string): Promise<'exact' | 'partial' | 'missing' | 'unknown'>;
  // One look at the CLI's screen (launch-guard/screen.ts); null when it
  // can't be read.
  readScreen(sessionId: string): Promise<ScreenReading | null>;
  // Chooses "Skip" in the CLI's update menu, cursor confirmed first.
  skipUpdate(sessionId: string): Promise<'answered' | 'not_shown' | 'unsure'>;
};
