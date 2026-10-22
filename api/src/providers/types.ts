import type { LimitHit } from '../contract/continuity.js';
import type { InteractionScreen } from '../contract/sessions.js';
import type { PendingInteraction, Provider, Turn } from '../types.js';
import type { Msg } from './msg.js';
import type { ObservedPermissionModes } from './permission-mode.js';

export type LocateOpts = {
  cwd: string;
  providerSessionId: string | null;
  launchedAfter: string; // ISO timestamp
  conversationRoot?: string;
};

export type TranscriptLookupResult =
  | { status: 'resolved'; file: string; identity: 'pinned_id' | 'verified_metadata' | 'claude_clear_heuristic' }
  | { status: 'pending' | 'not_found' | 'ambiguous' };

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped';

// One subagent the CLI delegated to from this conversation, as its main
// transcript records it. The subagent's own messages live elsewhere and
// are only read on request (readSubagentMessages).
export type SubagentSummary = {
  agentId: string;
  description: string;
  subagentType: string | null;
  background: boolean;
  status: SubagentStatus;
  startedAt: string | null;
  endedAt: string | null;
  // The CLI's own one-line summary from the ending notification, if any.
  summary: string | null;
  // The model it runs on, when the CLI records it (Codex does).
  model?: string | null;
};

// A turn still going at the end of the transcript (TranscriptAdapter.openTurnAtEnd).
// `at` is the opening message's time, for a `user` turn whose message has one.
export type OpenTurn = { openedBy: 'user' | 'cli'; at: string | null };

// A background subagent the main transcript says is still out (started or
// set running again, no end recorded since): the cheap signal the poller
// reads every tick (sync/backgroundAgents.ts). `since` is when the main
// transcript last said anything of it, so a check of the subagent's own
// transcript can be told apart from a later one.
export type OpenSubagent = {
  agentId: string;
  startedAt: string | null;
  since: string | null;
};

/**
 * A prompt the CLI is waiting on, read from its pane: the screen as the app
 * shows it, the tool it is about, and which option the cursor is on (an
 * index into `screen.options`, null when it can't be told).
 */
export type PaneInteraction = {
  screen: InteractionScreen;
  toolName: string;
  cursor: number | null;
};

export type CapabilityResult<T> =
  | { status: 'supported'; value: T }
  | { status: 'unsupported' }
  | { status: 'unknown' };

/**
 * A CLI's transcript format: where a conversation's transcript lives and how
 * to read it. Everything about running the CLI itself (argv, process
 * identity, exit, session identity) belongs to its runtime driver
 * (runtimes/types.ts RuntimeDriver).
 */
export type TranscriptAdapter = {
  name: Provider;
  locateSessionFile(opts: LocateOpts): Promise<TranscriptLookupResult>;
  // The real (non-wrapper) messages parseTurns pairs up into turns, exposed
  // on their own so callers that need to know "did anything real show up
  // at all" (e.g. confirming a just-sent message was actually delivered,
  // regardless of whether it's been replied to yet) don't have to wait for
  // a complete user+assistant pair — a lone user message with no reply yet
  // never becomes a Turn, but it's still real evidence of delivery.
  parseMessages(sessionFilePath: string): Promise<Msg[]>;
  // Messages the user sent mid-reply that the CLI took into the turn in
  // progress rather than recording as user messages (see Turn.followUps).
  // Also delivery evidence. Optional: only a CLI that records them this
  // way needs it.
  parseFollowUps?(sessionFilePath: string): Promise<Msg[]>;
  // When each turn started, for a CLI that records the start as soon as it
  // takes a message in but writes the message itself only later (Codex
  // compacts a long conversation first). Evidence a send was received, not
  // of what arrived. Optional: a CLI that writes the message at once needs
  // none.
  parseTurnStarts?(sessionFilePath: string): Promise<string[]>;
  parseTurns(sessionFilePath: string): Promise<Turn[]>;
  // When the CLI wrote its own compaction summaries: records shaped like a
  // user message that nobody sent (Claude Code's isCompactSummary), never
  // among parseMessages. Lets a turn that was opened on one — by a Hestia
  // that still read it as a message — end on its own (polling.ts). Optional:
  // a CLI that records compaction apart from its messages (Codex's
  // `compacted` item) needs none.
  parseCompactionSummaryTimes?(sessionFilePath: string): Promise<string[]>;
  // Structural "is the model still mid-turn" check, used to gate
  // finalizing a turn in polling.ts — a transcript can sit unchanged for
  // several seconds between two tool calls in the same turn (waiting on a
  // slow tool, or just the model thinking), which the file-quiescence
  // heuristic alone can't tell apart from "actually done". The result is
  // explicit: supported means the adapter has a structural answer;
  // unknown/unsupported leaves the poller's separate file-quiescence
  // fallback in charge.
  isTurnComplete(sessionFilePath: string): Promise<CapabilityResult<boolean>>;
  // Structurally-confirmed "the CLI is blocked on a decision" detection —
  // read from the transcript itself, never from scraping pane text. Returns
  // supported + null means the adapter confirmed there is no pending
  // interaction. Unknown/unsupported is not the same as that assertion.
  findPendingInteraction(sessionFilePath: string): Promise<CapabilityResult<PendingInteraction | null>>;
  // Reads of the CLI's own TUI, used only to qualify the transcript-based
  // signals above, never on their own: the transcript can't tell "waiting
  // for approval" apart from "approved, tool still running" (both are a
  // tool_use with no tool_result yet), nor "stuck on a panel" apart from
  // "busy thinking/running a slow tool" (both write nothing for a while),
  // nor "done, back at the prompt" apart from "mid-turn" when the
  // transcript's own shape says the turn never finished (e.g. a tool
  // interrupted before its tool_result was written). paneShowsIdle means
  // "not busy, no permission prompt, and the CLI's input box is on screen" —
  // a local panel such as /status is none of busy/idle.
  // Absent means the adapter has no verified pane reading; callers then
  // fall back to the transcript-only behavior.
  paneShowsPermissionPrompt?(paneText: string): boolean;
  paneShowsBusy?(paneText: string): boolean;
  paneShowsIdle?(paneText: string): boolean;
  // The prompt (permission, question) the pane ends with, read in full so
  // the app can show and answer it; null when none is on screen. Unlike the
  // readings above it stands on its own: a CLI may write nothing to its
  // transcript while a prompt waits (Claude Code 2.1.284). Absent means the
  // CLI's prompts can't be read from its pane.
  readPaneInteraction?(paneText: string): PaneInteraction | null;
  // The next message the CLI itself suggests, drawn as dim ghost text in its
  // empty input box (Claude Code's prompt suggestion), read from a capture
  // that keeps attributes (`capture-pane -e`): without them it looks exactly
  // like typed text. Null when there is none. Display only: nothing that
  // decides delivery, idleness or prompts reads it. Absent means the CLI
  // has no such suggestion the app can read.
  readPaneSuggestion?(ansiPaneText: string): string | null;
  // The CLI's own explicit "this conversation carries on in another
  // transcript" pointer, followed to the newest file. Returns null when the
  // given file is still the current one. Explicit provenance only — never a
  // guess from mtimes or directory listings.
  followContinuation?(sessionFilePath: string): Promise<{ file: string; providerSessionId: string } | null>;
  // Subagents this conversation delegated to, oldest first, and one's own
  // messages (null when it isn't one of those, or its transcript is gone).
  // Absent means the CLI's subagents can't be read.
  listSubagents?(sessionFilePath: string): Promise<SubagentSummary[]>;
  readSubagentMessages?(sessionFilePath: string, agentId: string): Promise<Msg[] | null>;
  // The background subagents still out by the main transcript alone, read
  // every poll: it must cost no more than the (cached) main transcript.
  // Absent means the CLI's background subagents can't be told.
  openBackgroundSubagents?(sessionFilePath: string): Promise<OpenSubagent[]>;
  // Whether one of those is really still running by its own transcript's
  // tail: true running, false ended, null can't tell. Costlier (a lookup
  // and a tail read), so callers throttle it. Absent when the main
  // transcript is already the authority (Claude's task notifications).
  subagentStillRunning?(sessionFilePath: string, agentId: string): Promise<boolean | null>;
  // The turn the transcript ends on, if it is still going (the CLI wrote no
  // end for it), and who opened it: `user` a person's message (typed in the
  // terminal or sent from the app), `cli` the CLI itself — woken by a
  // background task's result (a subagent's end), a peer, or nothing the
  // transcript names. Read every poll while the session is idle, so it must
  // only look back from the end of the (cached) transcript. Absent means
  // the CLI's turns can't be told apart this way.
  openTurnAtEnd?(sessionFilePath: string): Promise<OpenTurn | null>;
  // The usage limit the conversation stopped on, read from the transcript by
  // this CLI's own version-verified rule: non-null only while the latest
  // thing in the conversation is that limit error. Absent means this CLI's
  // limit hits can't be recognized.
  readLimitHit?(sessionFilePath: string): Promise<LimitHit | null>;
  // The conversation's first and latest permission mode, as the CLI itself
  // records it (permission-mode.ts). Read every poll from the cached
  // transcript. Absent means this CLI's mode can't be read.
  readPermissionModes?(sessionFilePath: string): Promise<ObservedPermissionModes>;
};
