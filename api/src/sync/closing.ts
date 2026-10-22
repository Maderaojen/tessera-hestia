// Sessions whose tmux the app is closing right now (services/sessions.ts
// closeSession). Their CLI is asked to exit first, and the poller must not
// take that exit for the user leaving the CLI (checkProviderStillAlive ends
// the conversation as 'cli_exit'): closing the tmux leaves the conversation
// as a tmux that died does, which Claude Code can be resumed from.
const closing = new Set<string>();

/** Marks the session as closing; false if it already was. */
export function beginClosing(sessionId: string): boolean {
  if (closing.has(sessionId)) return false;
  closing.add(sessionId);
  return true;
}

export function endClosing(sessionId: string): void {
  closing.delete(sessionId);
}

export function isClosing(sessionId: string): boolean {
  return closing.has(sessionId);
}
