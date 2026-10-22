import { codexSourcedMessages } from '../providers/codex.js';
import { buildTurns, openTail, wholeTurn } from './turns.js';
import { clipDetail, linesDiff, relativeTo } from './text.js';
import { listProcessImages, type RawProcessImage } from './images.js';
import type { ItemStatus, ProcessEvent, ProcessItemDetail, ProcessTurn, ToolKind } from './types.js';

// Codex rollouts (verified 0.153.4–0.162.1, docs/reference/cli-version-
// alignment.md): every message carries `phase` (commentary / final_answer);
// what it did is in `event_msg` / `item_completed` items (CommandExecution
// with Codex's own parse of the command, FileChange with unified diffs,
// Reasoning, …). The `response_item` tool calls are not read: from 0.162.1
// they are code-mode scripts, not tool calls.

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function fromFileUrl(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value;
}

function commandText(item: Record<string, unknown>): string {
  const command = item.command;
  if (Array.isArray(command)) {
    // ["/bin/bash", "-lc", "<the command>"]
    const last = command.at(-1);
    return typeof last === 'string' ? last : command.join(' ');
  }
  return str(command) ?? '';
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function statusOf(item: Record<string, unknown>): ItemStatus {
  const exit = item.exit_code;
  if (item.status === 'failed' || (typeof exit === 'number' && exit !== 0)) return 'error';
  return item.status === 'completed' || item.status === undefined ? 'ok' : 'running';
}

function toolOf(item: Record<string, unknown>, cwd: string | null): { kind: ToolKind; label: string; name: string } | null {
  switch (item.type) {
    case 'CommandExecution': {
      const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
      const types = new Set(parsed.map((part) => part.type));
      if (parsed.length > 0 && [...types].every((type) => type === 'read')) {
        return { kind: 'read', name: 'read', label: parsed.map((part) => relativeTo(str(part.path) ?? str(part.name) ?? '', cwd)).join(', ') };
      }
      if (parsed.length > 0 && [...types].every((type) => type === 'search' || type === 'list_files')) {
        return { kind: 'search', name: 'search', label: firstLine(commandText(item)) };
      }
      return { kind: 'run', name: 'exec', label: firstLine(commandText(item)) };
    }
    case 'FileChange': {
      const changes = rec(item.changes) ?? {};
      return { kind: 'edit', name: 'apply_patch', label: Object.keys(changes).map((file) => relativeTo(file, cwd)).join(', ') };
    }
    case 'Extension': {
      const kind = str(item.kind) ?? '';
      return { kind: kind.startsWith('web') ? 'web' : 'other', name: kind || 'extension', label: str(item.query) ?? kind };
    }
    case 'McpToolCall':
      return { kind: 'other', name: 'mcp', label: [str(item.server), str(item.tool)].filter(Boolean).join(' · ') };
    case 'CollabAgentToolCall':
      return { kind: 'agent', name: 'agent', label: str(item.tool) ?? 'agent' };
    case 'ImageView':
      return { kind: 'read', name: 'view_image', label: relativeTo(fromFileUrl(str(item.path)) ?? '', cwd) };
    default:
      return null;
  }
}

function codexEvents(records: readonly unknown[], from: number, to: number, textSrcs: ReadonlySet<number>, texts: Map<number, { text: string; at: string | null }>): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  let cwd: string | null = null;
  // The folder in force at the turn's start: the last turn_context before it.
  for (let i = from - 1; i >= 0 && cwd === null; i--) {
    const record = rec(records[i]);
    if (record?.type === 'turn_context' || record?.type === 'session_meta') cwd = str(rec(record.payload)?.cwd);
  }
  for (let i = from; i < to; i++) {
    const record = rec(records[i]);
    if (!record) continue;
    const payload = rec(record.payload);
    const at = str(record.timestamp);
    if (record.type === 'turn_context') {
      cwd = str(payload?.cwd) ?? cwd;
      continue;
    }
    if (record.type === 'response_item' && textSrcs.has(i)) {
      const text = texts.get(i)!;
      events.push({ type: 'text', src: i, text: text.text, at: text.at });
      continue;
    }
    if (record.type !== 'event_msg' || !payload) continue;
    if (payload.type === 'task_complete') events.push({ type: 'end', src: i });
    else if (payload.type === 'turn_aborted') events.push({ type: 'interrupt', src: i });
    if (payload.type !== 'item_completed') continue;
    const item = rec(payload.item);
    if (!item) continue;
    const id = str(item.id) ?? `item-${i}`;
    if (item.type === 'Reasoning') {
      const summary = Array.isArray(item.summary_text) ? item.summary_text.filter((part) => typeof part === 'string' && part.trim()) : [];
      events.push({ type: 'thinking', id, src: i, at, hasText: summary.length > 0 });
      continue;
    }
    if (item.type === 'ContextCompaction') {
      events.push({ type: 'compaction', id, src: i, at });
      continue;
    }
    const tool = toolOf(item, cwd);
    if (!tool) continue;
    events.push({ type: 'tool', id, src: i, name: tool.name, kind: tool.kind, label: tool.label, at, status: statusOf(item), interactive: false, resultSrc: i });
  }
  return events;
}

// `offset`: where to start reading (a subagent's own records start after
// the parent history its rollout copies).
export function codexProcessTurns(records: readonly unknown[], offset = 0): ProcessTurn[] {
  return buildTurns(records.length, codexSourcedMessages(records, offset), (from, to, textSrcs, texts) => codexEvents(records, from, to, textSrcs, texts));
}

// A subagent's rollout as one turn: its tasks come from the parent as
// encrypted agent messages, not user messages.
export function codexWholeTurn(records: readonly unknown[]): ProcessTurn | null {
  return wholeTurn(records.length, codexSourcedMessages(records), (from, to, textSrcs, texts) => codexEvents(records, from, to, textSrcs, texts));
}

export function codexOpenTurn(records: readonly unknown[], offset = 0): ProcessTurn | null {
  return openTail(records.length, codexSourcedMessages(records, offset), (from, to, textSrcs, texts) => codexEvents(records, from, to, textSrcs, texts));
}

export function codexItemDetail(records: readonly unknown[], turn: ProcessTurn, itemId: string): ProcessItemDetail | null {
  const event = turn.events.find((candidate) => (candidate.type === 'tool' || candidate.type === 'thinking') && candidate.id === itemId);
  if (!event || (event.type !== 'tool' && event.type !== 'thinking')) return null;
  const item = rec(rec(rec(records[event.src])?.payload)?.item);
  if (!item) return null;
  if (event.type === 'thinking') {
    const summary = Array.isArray(item.summary_text) ? item.summary_text.filter((part): part is string => typeof part === 'string' && part.trim() !== '') : [];
    return clipDetail({ thinking: summary.length ? summary.join('\n\n') : null });
  }
  switch (item.type) {
    case 'CommandExecution': {
      const output = str(item.aggregated_output) ?? str(item.stdout) ?? '';
      return clipDetail({ input: commandText(item), output, ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}) });
    }
    case 'FileChange': {
      const diffs = Object.entries(rec(item.changes) ?? {}).map(([file, change]) => {
        const c = rec(change) ?? {};
        if (typeof c.unified_diff === 'string') return `--- ${file}\n+++ ${file}\n${c.unified_diff}`;
        if (c.type === 'add' && typeof c.content === 'string') return linesDiff(file, '', c.content);
        if (c.type === 'delete') return `--- ${file}\n+++ /dev/null`;
        return `--- ${file}\n+++ ${file}`;
      });
      return clipDetail({ diff: diffs.join('\n'), ...(statusOf(item) === 'error' ? { output: str(item.stderr) ?? str(item.stdout) ?? '' } : {}) });
    }
    default: {
      const rest = Object.fromEntries(Object.entries(item).filter(([field]) => field !== 'type' && field !== 'id'));
      const images = listProcessImages(itemImages(item));
      return clipDetail({ input: JSON.stringify(rest, null, 2), ...(images ? { images } : {}) });
    }
  }
}

// view_image: the file it looked at, where the transcript says it is.
function itemImages(item: Record<string, unknown>): RawProcessImage[] {
  const file = item.type === 'ImageView' ? fromFileUrl(str(item.path)) : null;
  return file ? [{ source: 'file', path: file }] : [];
}

/** One tool item's images, looked up only among this turn's events; null when there is no such item. */
export function codexItemImages(records: readonly unknown[], turn: ProcessTurn, itemId: string): RawProcessImage[] | null {
  const event = turn.events.find((candidate) => candidate.type === 'tool' && candidate.id === itemId);
  if (!event || event.type !== 'tool') return null;
  const item = rec(rec(rec(records[event.src])?.payload)?.item);
  return item ? itemImages(item) : null;
}
