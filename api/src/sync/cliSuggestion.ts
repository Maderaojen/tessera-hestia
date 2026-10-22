import { CLI_SUGGESTION_RECHECK_MS, CLI_SUGGESTION_REUSE_MS, CLI_SUGGESTION_SAMPLE_MS, CLI_SUGGESTION_WATCH_MS } from '../config.js';
import { recentAnsiCapture } from '../pane-stream.js';
import { stripAnsi } from '../providers/claude-suggestion.js';
import * as registry from '../registry.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import type { RuntimeDriver } from '../runtimes/types.js';
import * as tmuxCli from '../tmux.js';
import { activeTurnPhase, deriveSessionActivity, type ManagedSession } from '../types.js';

// The next message the CLI itself suggests (Claude Code's dim ghost text,
// providers/claude-suggestion.ts), kept on the session for the chat to
// offer. Display only: what decides delivery, idleness and prompts reads
// the pane without attributes and never looks at this.
//
// Cheap by design. Idle sessions aren't otherwise captured, so the pane is
// read only for CLI_SUGGESTION_WATCH_MS after a turn goes idle (every
// CLI_SUGGESTION_SAMPLE_MS), then only every CLI_SUGGESTION_RECHECK_MS while
// a suggestion stands. An open terminal view already captures the pane with
// attributes; its capture is used instead when it is fresh.

type Watch = { idleSince: number; sampledAt: number };

const watches = new Map<string, Watch>();
// More than a pane's rows (the app opens them 40 high); the input box and
// footer are its last few.
const SCREEN_TAIL_LINES = 60;

export type SuggestionPorts = {
  now: () => number;
  // The pane with attributes, screen only; null when it can't be read.
  capture: (tmuxName: string) => Promise<string | null>;
  recent: (tmuxName: string, maxAgeMs: number) => string | null;
};

const defaultPorts: SuggestionPorts = {
  now: () => Date.now(),
  capture: (tmuxName) => tmuxCli.capturePane(tmuxName, { ansi: true }).catch(() => null),
  recent: (tmuxName, maxAgeMs) => recentAnsiCapture(tmuxName, maxAgeMs),
};

function readerFor(session: ManagedSession): RuntimeDriver | undefined {
  const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
  const runtime = recordedRuntime(session, conversation);
  return runtime?.readPaneSuggestion ? runtime : undefined;
}

function sittingIdle(session: ManagedSession): boolean {
  return session.status === 'ready' && !session.clearPending && !session.pendingInteraction && !session.startupPrompt
    && activeTurnPhase(session) === 'idle' && deriveSessionActivity(session) === 'idle' && session.backgroundTurn !== true;
}

/** Reads (when due) and stores the session's suggestion; writes only on change. */
export async function refreshCliSuggestion(session: ManagedSession, ports: SuggestionPorts = defaultPorts): Promise<void> {
  const runtime = readerFor(session);
  const current = session.cliSuggestion ?? null;
  if (!runtime || !sittingIdle(session)) {
    watches.delete(session.id);
    if (current !== null) await registry.updateSession(session.id, { cliSuggestion: null });
    return;
  }
  const now = ports.now();
  let watch = watches.get(session.id);
  if (!watch) {
    watch = { idleSince: now, sampledAt: Number.NEGATIVE_INFINITY };
    watches.set(session.id, watch);
  }
  const reused = ports.recent(session.tmuxName, CLI_SUGGESTION_REUSE_MS);
  const watching = now - watch.idleSince < CLI_SUGGESTION_WATCH_MS;
  const interval = watching ? CLI_SUGGESTION_SAMPLE_MS : current !== null ? CLI_SUGGESTION_RECHECK_MS : null;
  const due = interval !== null && now - watch.sampledAt >= interval;
  if (reused === null && !due) return;
  // A terminal view's capture reaches back into history; only its end is
  // the screen the CLI is drawing now.
  const pane = reused !== null ? reused.split('\n').slice(-SCREEN_TAIL_LINES).join('\n') : await ports.capture(session.tmuxName);
  watch.sampledAt = now;
  if (pane === null) return;
  // Only the input box at rest counts: a local panel, a prompt or a busy
  // footer means whatever looks like one isn't offered.
  const idle = runtime.paneShowsIdle ? runtime.paneShowsIdle(stripAnsi(pane)) : true;
  const next = idle ? runtime.readPaneSuggestion!(pane) : null;
  if (next === current) return;
  await registry.updateSession(session.id, { cliSuggestion: next });
}

export function __resetCliSuggestionsForTests(): void {
  watches.clear();
}
