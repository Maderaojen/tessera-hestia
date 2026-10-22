import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PROVIDER_ROOTS } from '../config.js';
import { RFC4122_UUID } from '../ids.js';
import type { Turn } from '../types.js';
import { fileExists } from './locate.js';
import { readClaudeInteraction } from './claude-interaction.js';
import { readClaudeSuggestion } from './claude-suggestion.js';
import { claudeLimitHit } from './claude-limit.js';
import { listClaudeSubagents, locateClaudeSubagentFile, openClaudeSubagents } from './claude-subagents.js';
import { readJsonlLines } from './jsonl.js';
import { claudePermissionModes } from './permission-mode.js';
import { assembleCompleteTurns, dedupe, isWrapper, textFromContent, type Msg, type SourcedMsg } from './msg.js';
import type { LocateOpts, OpenTurn, TranscriptAdapter } from './types.js';

export const INTERRUPTED_MARKER = /^\[Request interrupted by user(?: for tool use)?\]$/;

// User-role entries the CLI itself injects to wake the model — a background
// task's <task-notification>, a peer/coordinator message — without isMeta.
// Claude Code tags who a prompt came from: human input is `origin.kind:
// "human"` (promptSource typed / queued / suggestion_accepted), anything
// the harness sent is another kind and/or `promptSource: "system"`. Older
// transcripts carry neither field; those fall through to the other checks.
export function isHarnessInjected(rec: Record<string, unknown>): boolean {
  if (rec.promptSource === 'system') return true;
  const origin = rec.origin;
  if (!origin || typeof origin !== 'object') return false;
  const kind = (origin as Record<string, unknown>).kind;
  return typeof kind === 'string' && kind !== 'human';
}

// The summary Claude Code writes when it compacts a conversation: a
// user-role record (isCompactSummary, "This session is being continued from
// a previous conversation…") right after a `system` compact_boundary, then
// attachments re-reading files. Nobody typed it, and no reply follows when
// the CLI compacted on its own while idle ("Compacted while idle, before the
// prompt cache expired", 2.1.296) — read as a message, it opened a turn that
// never ended. Mid-turn auto-compaction writes the same record (2.1.269,
// 2.1.283); the reply that follows belongs to the turn already going on.
export function isCompactSummary(rec: Record<string, unknown>): boolean {
  return rec.type === 'user' && rec.isCompactSummary === true;
}

export const CLAUDE_SESSION_ID = RFC4122_UUID;
// Enough to hold the few trailing/leading records these checks need without
// reading a multi-megabyte transcript on every poll.
const PEEK_BYTES = 64 * 1024;
const MAX_CONTINUATION_HOPS = 20;

async function peek(filePath: string, from: 'head' | 'tail'): Promise<Record<string, unknown>[] | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, PEEK_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from === 'head' ? 0 : size - length);
    const lines = buffer.toString('utf-8').split('\n');
    // The cut end (last line of a head read, first line of a tail read that
    // doesn't start at byte 0) can be a partial record; parsing just skips it.
    const records: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === 'object') records.push(parsed as Record<string, unknown>);
      } catch { /* partial or blank line */ }
    }
    return records;
  } finally {
    await handle.close();
  }
}

// A message the user sent while a reply was still being written. Claude
// queues it, then takes it in mid-turn, recording only a `queued_command`
// attachment — never a user message (the queue-operation records around
// it say `absorbed_mid_turn`). The same attachment also carries harness
// wake-ups (task notifications, peer messages); only a human prompt counts.
// Older transcripts have no `origin`; the wrapper check covers those.
function queuedFollowUp(rec: Record<string, unknown>): Msg | null {
  const attachment = rec.attachment;
  if (!attachment || typeof attachment !== 'object') return null;
  const a = attachment as Record<string, unknown>;
  if (a.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  const origin = a.origin;
  const kind = origin && typeof origin === 'object' ? (origin as Record<string, unknown>).kind : undefined;
  if (kind !== undefined && kind !== 'human') return null;
  const prompt = textFromContent(a.prompt);
  const text = prompt ? unwrapPastedContent(prompt) : prompt;
  if (!text || isWrapper(text)) return null;
  const ts = typeof a.timestamp === 'string' ? a.timestamp : typeof rec.timestamp === 'string' ? rec.timestamp : null;
  return { role: 'user', text, ts, followUp: true };
}

// A message as it was typed or pasted, from how Claude Code records it
// (seen 2.1.278–2.1.300): a paste it folded into "[Pasted text #N +M
// lines]" is kept between <pasted_content id="…"> tags; a paste that was
// nothing but an image's path becomes "[Image #N]" (the image itself
// attached), the path written only in a companion meta record ("[Image:
// source: <path>]") of the same prompt. Read back to the text that was sent,
// so the chat, its attachments and delivery checks see what the app sent.
const PASTED_CONTENT = /<pasted_content id="([0-9a-zA-Z]+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;
const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/;

export function unwrapPastedContent(text: string): string {
  if (!text.includes('<pasted_content id=')) return text;
  return text.replace(PASTED_CONTENT, (_whole, _id: string, body: string) => body).trim();
}

function asTyped(text: string, rec: Record<string, unknown>, records: readonly unknown[], index: number): string {
  const unwrapped = unwrapPastedContent(text);
  const ids = Array.isArray(rec.imagePasteIds) ? rec.imagePasteIds.filter((id): id is number => typeof id === 'number') : [];
  if (ids.length === 0 || !unwrapped.includes('[Image #')) return unwrapped;
  const sources = imageSources(rec, records, index);
  let result = unwrapped;
  ids.forEach((id, n) => {
    const source = sources[n];
    if (source) result = result.replace(`[Image #${id}]`, source);
  });
  return result;
}

// The "[Image: source: …]" companions written right after a prompt, in order.
function imageSources(rec: Record<string, unknown>, records: readonly unknown[], index: number): string[] {
  const sources: string[] = [];
  for (let j = index + 1; j < records.length && j <= index + 20; j++) {
    const next = records[j] as Record<string, unknown> | null;
    if (!next || typeof next !== 'object' || next.type !== 'user') continue;
    if (next.isMeta !== true) break;
    if (rec.promptId !== undefined && next.promptId !== rec.promptId) continue;
    const content = (next.message as Record<string, unknown> | undefined)?.content;
    const source = IMAGE_SOURCE.exec(textFromContent(content)?.trim() ?? '')?.[1];
    if (source) sources.push(source);
  }
  return sources;
}

// Claude Code 2.1.304+ writes the notes it shows the user between steps
// ("Found it: …") as a thinking block with text; only its signature tells
// such a note from reasoning. The signature is opaque protobuf whose head
// carries a label field: "thinking" for reasoning (2.1.304–2.1.305: always
// signature only), "narration" for these notes. A signature that can't be
// read this way stays reasoning.
const NARRATION_LABEL = Buffer.concat([Buffer.from([0x42, 0x09]), Buffer.from('narration')]);

export function isNarration(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  if (b.type !== 'thinking' || typeof b.signature !== 'string' || typeof b.thinking !== 'string' || !b.thinking.trim()) return false;
  return Buffer.from(b.signature.slice(0, 64), 'base64').includes(NARRATION_LABEL);
}

// An assistant record's content with its narration read as text.
function withNarration(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => isNarration(block) ? { type: 'text', text: (block as Record<string, unknown>).thinking } : block);
}

async function readClaudeMessages(sessionFilePath: string, withFollowUps: boolean): Promise<Msg[]> {
  return claudeMessagesFromRecords(await readJsonlLines(sessionFilePath), withFollowUps).map(({ src: _src, ...message }) => message);
}

// The messages among a transcript's records, each with its record's
// position (process/claude.ts reads the records around them).
export function claudeMessagesFromRecords(records: readonly unknown[], withFollowUps: boolean, offset = 0): SourcedMsg[] {
  const messages: SourcedMsg[] = [];
  for (let i = offset; i < records.length; i++) {
    const record = records[i];
    if (typeof record !== 'object' || record === null) continue;
    const rec = record as Record<string, unknown>;
    const typ = rec.type;
    if (withFollowUps && typ === 'attachment') {
      const followUp = queuedFollowUp(rec);
      if (followUp) messages.push({ ...followUp, src: i });
      continue;
    }
    if (typ !== 'user' && typ !== 'assistant') continue;
    const message = rec.message;
    if (typeof message !== 'object' || message === null) continue;
    const msgRec = message as Record<string, unknown>;
    const role = (typeof msgRec.role === 'string' ? msgRec.role : typ) as string;
    if (role !== 'user' && role !== 'assistant') continue;
    // The CLI injects its own synthetic "user" entries alongside a real
    // one when a prompt makes it read an image — e.g. a companion line
    // whose content is literally "[Image: original 935x2048, displayed
    // at 913x2000. ...]", tagged isMeta/turnCompanion, not something the
    // human typed. Without this, assembleCompleteTurns' "every new
    // user-role message resets curUser" rule lets this synthetic entry
    // silently overwrite the real one as "the" user turn.
    if (rec.isMeta === true) continue;
    if (role === 'user' && (isHarnessInjected(rec) || isCompactSummary(rec))) continue;
    const content = msgRec.content;
    // Tool results arrive as user turns with a tool_result content block;
    // tool calls as assistant turns with a tool_use block. Neither is
    // conversation the human should see.
    if (
      Array.isArray(content) &&
      content.some((b) => {
        if (!b || typeof b !== 'object') return false;
        const t = (b as Record<string, unknown>).type;
        return t === 'tool_result' || t === 'tool_use';
      })
    ) {
      continue;
    }
    const raw = textFromContent(role === 'assistant' ? withNarration(content) : content);
    const text = role === 'user' && raw ? asTyped(raw, rec, records, i) : raw;
    if (!text || isWrapper(text)) continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    // Esc mid-reply makes the CLI append a user-role
    // "[Request interrupted by user]" entry right after whatever partial
    // text it had generated. Not something the human typed — read as the
    // end of the interrupted reply instead, so that turn closes out marked
    // interrupted (and a stop before any text still keeps the user's own
    // message as a turn).
    if (role === 'user' && INTERRUPTED_MARKER.test(text)) {
      messages.push({ role: 'assistant', text: '', ts, interrupted: true, src: i });
      continue;
    }
    messages.push({ role: role as Msg['role'], text, ts, src: i });
  }
  return dedupe(messages);
}

export const claudeAdapter: TranscriptAdapter = {
  name: 'claude',

  // Claude Code encodes the cwd into the project directory name under
  // ~/.claude/projects/ using an undocumented scheme. Rather than
  // reimplementing that guesswork, we lean on the one thing we do control:
  // the transcript's filename is exactly `<uuid>.jsonl` for the id we
  // picked, so just check every project dir for that name.
  async locateSessionFile({ providerSessionId, conversationRoot }: LocateOpts) {
    if (!providerSessionId) return { status: 'not_found' } as const;
    const root = conversationRoot ?? PROVIDER_ROOTS.claude;
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return { status: 'not_found' } as const;
    }
    for (const dir of projectDirs) {
      const candidate = path.join(root, dir, `${providerSessionId}.jsonl`);
      if (await fileExists(candidate)) return { status: 'resolved', file: candidate, identity: 'pinned_id' } as const;
    }
    return { status: 'not_found' } as const;
  },

  // Only real user/assistant messages: callers read "the latest user
  // message" from this (a terminal-typed prompt, delivery), and a mid-turn
  // follow-up is neither. parseTurns and parseFollowUps add those.
  async parseMessages(sessionFilePath: string): Promise<Msg[]> {
    return readClaudeMessages(sessionFilePath, false);
  },

  async parseFollowUps(sessionFilePath: string): Promise<Msg[]> {
    return (await readClaudeMessages(sessionFilePath, true)).filter((message) => message.followUp);
  },

  async parseTurns(sessionFilePath: string): Promise<Turn[]> {
    return assembleCompleteTurns(await readClaudeMessages(sessionFilePath, true));
  },

  async parseCompactionSummaryTimes(sessionFilePath: string): Promise<string[]> {
    const times: string[] = [];
    for (const record of await readJsonlLines(sessionFilePath)) {
      const rec = record as Record<string, unknown> | null;
      if (rec && typeof rec === 'object' && isCompactSummary(rec) && typeof rec.timestamp === 'string') times.push(rec.timestamp);
    }
    return times;
  },

  // Every assistant message record carries a `stop_reason`: 'tool_use' when
  // more generation is still coming after the tool result (still mid-turn,
  // however long that tool takes), anything else ('end_turn', ...) once
  // there's nothing left to wait for. Looking at only the chronologically
  // last assistant record is deliberate — after a tool_result comes back the
  // CLI always appends another assistant record, so the last one always
  // reflects the true current state, never a stale mid-turn one from an
  // earlier, already-finished turn.
  async isTurnComplete(sessionFilePath: string) {
    const records = await readJsonlLines(sessionFilePath);
    let lastStopReason: string | null = null;
    let sawAssistant = false;
    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue;
      const rec = record as Record<string, unknown>;
      if (rec.type !== 'assistant') continue;
      const message = rec.message;
      if (typeof message !== 'object' || message === null) continue;
      const msgRec = message as Record<string, unknown>;
      sawAssistant = true;
      lastStopReason = typeof msgRec.stop_reason === 'string' ? msgRec.stop_reason : null;
    }
    // No assistant record yet, or an older/unexpected shape with no
    // stop_reason at all — nothing to gate on, so don't block finalizing.
    if (!sawAssistant || lastStopReason === null) return { status: 'supported', value: true } as const;
    return { status: 'supported', value: lastStopReason !== 'tool_use' } as const;
  },

  // Empirically verified against Claude Code 2.1.276 (see
  // docs/reference/human-in-the-loop.md): a pending tool-permission prompt shows up in
  // the transcript as an assistant `tool_use` block (~2-3s after the
  // triggering message — ordinary generation latency, not the approval
  // itself) with no matching `user`-message `tool_result` block yet. Both
  // approving and denying eventually append that matching `tool_result`
  // (denial: `is_error: true`), so this clears itself either way once a
  // human responds — no separate "approved" vs "denied" handling needed
  // here.
  async findPendingInteraction(sessionFilePath: string) {
    const records = await readJsonlLines(sessionFilePath);
    const resolvedIds = new Set<string>();
    const toolUses: { id: string; name: string; input: unknown; ts: string | null }[] = [];

    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue;
      const rec = record as Record<string, unknown>;
      const message = rec.message;
      if (typeof message !== 'object' || message === null) continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          toolUses.push({ id: b.id, name: typeof b.name === 'string' ? b.name : 'unknown', input: b.input, ts });
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          resolvedIds.add(b.tool_use_id);
        }
      }
    }

    const unresolved = toolUses.filter((t) => !resolvedIds.has(t.id));
    const last = unresolved[unresolved.length - 1];
    if (!last) return { status: 'supported', value: null } as const;
    return { status: 'supported', value: {
      kind: 'tool_permission',
      toolUseId: last.id,
      toolName: last.name,
      input: last.input,
      detectedAt: last.ts ?? new Date().toISOString(),
    } } as const;
  },

  // Claude Code sometimes carries a running conversation on in a new
  // transcript file (observed 2.1.281, while idle, after /status, after a
  // cancelled /resume — the process keeps running). The old file then ends
  // with {"type":"continued-in","sessionId":<old>,"continuedInSessionId":
  // <new>}, and <new>.jsonl, in the same project directory, holds a full
  // copy of the history (original timestamps) followed by everything since.
  // Followed hop by hop; each hop must be the file's final record, name a
  // well-formed id, and land on a file whose own records carry that id.
  async followContinuation(sessionFilePath: string) {
    let file = sessionFilePath;
    let providerSessionId: string | null = null;
    for (let hop = 0; hop < MAX_CONTINUATION_HOPS; hop++) {
      const last = (await peek(file, 'tail'))?.at(-1);
      const nextId = last?.type === 'continued-in' ? last.continuedInSessionId : undefined;
      if (typeof nextId !== 'string' || !CLAUDE_SESSION_ID.test(nextId) || last?.sessionId !== path.basename(file, '.jsonl')) break;
      const candidate = path.join(path.dirname(file), `${nextId}.jsonl`);
      const head = await peek(candidate, 'head');
      if (!head?.some((record) => record.sessionId === nextId)) break;
      file = candidate;
      providerSessionId = nextId;
    }
    return providerSessionId ? { file, providerSessionId } : null;
  },

  // Only the file's tail: the hit, if any, is its last conversation record.
  async readLimitHit(sessionFilePath: string) {
    const records = await peek(sessionFilePath, 'tail');
    return records ? claudeLimitHit(records) : null;
  },

  readPermissionModes: async (sessionFilePath: string) => claudePermissionModes(await readJsonlLines(sessionFilePath)),

  listSubagents: listClaudeSubagents,
  openTurnAtEnd: async (sessionFilePath: string) => claudeOpenTurnAtEnd(await readJsonlLines(sessionFilePath)),
  // A background agent's end is always written to the main transcript (its
  // task notification), so there is nothing further to check.
  openBackgroundSubagents: openClaudeSubagents,

  // Only an agent this conversation's own transcript names: the id never
  // reaches the filesystem otherwise.
  async readSubagentMessages(sessionFilePath: string, agentId: string) {
    const known = (await listClaudeSubagents(sessionFilePath)).some((agent) => agent.agentId === agentId);
    if (!known) return null;
    const file = await locateClaudeSubagentFile(sessionFilePath, agentId);
    return file ? readClaudeMessages(file, false) : null;
  },

  // Verified against Claude Code 2.1.281 by capturing a real pane: a
  // permission prompt renders "Do you want to proceed?" (edits: "Do you
  // want to make this edit to …?" / "create …?") above numbered options
  // starting "❯ 1. Yes"; a merely running tool shows "⎿ Running…" and none
  // of that.
  // Claude Code 2.1.284 writes nothing to the transcript while a permission
  // prompt or a question waits (docs/reference/human-in-the-loop.md), so this is how
  // one is found; see providers/claude-interaction.ts.
  readPaneInteraction: readClaudeInteraction,

  // Claude Code 2.1.296's prompt suggestion (providers/claude-suggestion.ts).
  readPaneSuggestion: readClaudeSuggestion,

  paneShowsPermissionPrompt(paneText: string) {
    return /Do you want to [^\n]*\?/.test(paneText) && /^\s*(?:❯\s*)?1\.\s+Yes\b/m.test(paneText);
  },

  // Same verification: the footer reads "esc to interrupt" whenever the CLI
  // is generating, thinking or running a tool, and "? for shortcuts" when
  // idle at the prompt.
  paneShowsBusy(paneText: string) {
    return /esc to interrupt/i.test(paneText);
  },

  // Verified against Claude Code 2.1.281 by capturing real panes (manual
  // and auto mode idle, busy, /status open). The footer can't be the signal:
  // auto mode's idle footer has no "? for shortcuts", and a /status panel
  // shows neither footer. What every idle screen does have is the input
  // box — a "❯" line with a full-width "───" rule directly above it and
  // another closing it below (not necessarily the next line: a multi-line
  // draft wraps inside the box). A submitted prompt echoed in the scrollback
  // ("❯ /status") has no rule right above it, and a local panel replaces the
  // box entirely. The box is also
  // on screen while busy, hence the explicit busy/prompt exclusions.
  paneShowsIdle(paneText: string) {
    if (this.paneShowsBusy?.(paneText) || this.paneShowsPermissionPrompt?.(paneText)) return false;
    const lines = paneText.split('\n');
    // A session with a name (`-n`, which the app passes) carries it at the
    // right end of the box's top rule: "────── my-session ─".
    const isRule = (line: string | undefined) => line !== undefined && /^─{20,}(?: .+ ─+)?\s*$/.test(line);
    return lines.some((line, i) => /^❯(?:\s|$)/.test(line) && isRule(lines[i - 1]) && lines.slice(i + 1).some(isRule));
  },
};

// Claude Code closes every turn it finishes with a `system` record of
// subtype `turn_duration` (2.1.294–2.1.296, real transcripts: every
// end_turn and API error reply is followed by one); a turn stopped with Esc
// ends on the interrupt marker instead, with no turn_duration. A wake-up — a background agent's task
// notification (a `queued_command` attachment, or a user record whose
// `origin.kind` isn't human), a peer message — or a reply written after the
// last one means a turn is going on. Only the transcript's tail since that
// record is looked at. A transcript with no turn_duration at all (older
// CLIs) never says so. The turn was opened by a person when the first
// message after that record is theirs (2.1.299: a prompt typed right after
// an Esc, `origin.kind: human`), by the CLI when it is a wake-up.
export function claudeOpenTurnAtEnd(records: readonly unknown[]): OpenTurn | null {
  const known = openTurnMemo.get(records);
  if (known && known.length === records.length) return known.open;
  let sawTurn = false;
  let opener: OpenTurn | null = null;
  let open: OpenTurn | null = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i] as Record<string, unknown> | null;
    if (!rec || typeof rec !== 'object' || rec.isSidechain === true) continue;
    if (isTurnDuration(rec) || isInterruptMarker(rec)) {
      open = sawTurn ? opener ?? { openedBy: 'cli', at: null } : null;
      break;
    }
    // Walking back, the last one assigned is the first after the boundary.
    if (isWakeUp(rec)) {
      sawTurn = true;
      opener = { openedBy: 'cli', at: null };
    } else if (isHumanPrompt(rec)) {
      opener = { openedBy: 'user', at: typeof rec.timestamp === 'string' ? rec.timestamp : null };
    } else if (rec.type === 'assistant') {
      sawTurn = true;
    }
  }
  openTurnMemo.set(records, { length: records.length, open });
  return open;
}

export function claudeTurnOpenAtEnd(records: readonly unknown[]): boolean {
  return claudeOpenTurnAtEnd(records) !== null;
}

// Asked every poll: the parse cache hands back the same array, grown in
// place, so a transcript with no turn_duration (older CLIs) is walked once
// per change, not once per poll.
const openTurnMemo = new WeakMap<readonly unknown[], { length: number; open: OpenTurn | null }>();

// A message a person sent: what claudeMessagesFromRecords reads as the
// user's, short of a mid-turn follow-up.
function isHumanPrompt(rec: Record<string, unknown>): boolean {
  if (rec.type !== 'user' || rec.isMeta === true || isHarnessInjected(rec) || isCompactSummary(rec)) return false;
  const content = (rec.message as Record<string, unknown> | null | undefined)?.content;
  if (Array.isArray(content) && content.some((b) => !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result')) return false;
  const text = textFromContent(content);
  return !!text && !isWrapper(text) && !INTERRUPTED_MARKER.test(text.trim());
}

function isInterruptMarker(rec: Record<string, unknown>): boolean {
  if (rec.type !== 'user') return false;
  const content = (rec.message as Record<string, unknown> | null | undefined)?.content;
  const text = textFromContent(content);
  return !!text && INTERRUPTED_MARKER.test(text.trim());
}

function isTurnDuration(record: unknown): boolean {
  const rec = record as Record<string, unknown> | null;
  return !!rec && rec.type === 'system' && rec.subtype === 'turn_duration';
}

function isWakeUp(rec: Record<string, unknown>): boolean {
  if (rec.type === 'user') return !isCompactSummary(rec) && isHarnessInjected(rec);
  const attachment = rec.attachment as Record<string, unknown> | null | undefined;
  return rec.type === 'attachment' && !!attachment && attachment.type === 'queued_command'
    && attachment.commandMode === 'task-notification';
}
