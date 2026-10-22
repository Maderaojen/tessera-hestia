// What a turn did besides its text, read from the CLI's own transcript on
// request and never stored (ADR 0029).

import type { ProcessCounts, ProcessItemStatus, ToolKind, TurnPart } from '../contract/process.js';

export type { ProcessCounts, ProcessItem, ProcessItemDetail, ToolKind, TurnPart } from '../contract/process.js';
export type { TurnPartKind as PartKind } from '../contract/process.js';
export type ItemStatus = ProcessItemStatus;

export type ProcessEvent =
  // One of the turn's text messages: exactly the ones its stored text was
  // joined from, in order. `phase` is the CLI's own label when it has one.
  | { type: 'text'; src: number; text: string; at: string | null; phase?: string }
  // `interactive`: a tool that asks the user (its preceding text is for them).
  | { type: 'tool'; id: string; src: number; name: string; kind: ToolKind; label: string; at: string | null; status: ItemStatus; interactive: boolean; resultSrc: number | null }
  | { type: 'thinking'; id: string; src: number; at: string | null; hasText: boolean }
  | { type: 'compaction'; id: string; src: number; at: string | null }
  // The CLI finished a round of its own (Claude's turn_duration, Codex's
  // task_complete) or was stopped (Esc).
  | { type: 'end'; src: number }
  | { type: 'interrupt'; src: number };

/** One turn as the transcript has it: the records it spans and what is in them. */
export type ProcessTurn = {
  // Record positions: the user message, and the next user message (or the
  // end of the transcript) — the turn's start and end.
  userSrc: number;
  endSrc: number;
  user: { text: string; at: string | null };
  // The turn's text as the turn parser joins it (what gets stored).
  assistantText: string;
  interrupted: boolean;
  events: ProcessEvent[];
  parts: TurnPart[];
  counts: ProcessCounts;
};

export function emptyCounts(): ProcessCounts {
  return { read: 0, edit: 0, run: 0, search: 0, web: 0, agent: 0, other: 0, failed: 0, runFailed: 0, thinking: 0 };
}
