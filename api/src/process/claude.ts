import { claudeMessagesFromRecords, INTERRUPTED_MARKER, isCompactSummary } from '../providers/claude.js';
import { textFromContent } from '../providers/msg.js';
import { buildTurns, openTail, wholeTurn } from './turns.js';
import { clipDetail, linesDiff, relativeTo, structuredPatchDiff } from './text.js';
import { listProcessImages, type RawProcessImage } from './images.js';
import type { ProcessEvent, ProcessItemDetail, ProcessTurn, ToolKind } from './types.js';

// Claude Code transcripts (verified 2.1.296, docs/reference/cli-version-
// alignment.md): one content block per assistant record — text, tool_use
// or thinking (a 2.1.304+ narration block is read as text, see
// providers/claude.ts) — so record order is the order things happened. A tool's
// result is a user record whose content holds a tool_result with the
// tool_use's id (plus `toolUseResult`, the CLI's structured copy).

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Bash: 'run', BashOutput: 'run', KillShell: 'run', KillBash: 'run', PowerShell: 'run',
  Grep: 'search', Glob: 'search', LS: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Task: 'agent', Agent: 'agent', SendMessage: 'agent',
};
// Tools that ask the user: the text leading up to one is meant for them.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function contentBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const content = rec(record.message)?.content;
  return Array.isArray(content) ? content.map(rec).filter((block): block is Record<string, unknown> => !!block) : [];
}

function toolLabel(name: string, input: Record<string, unknown> | null, cwd: string | null): string {
  const file = str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path);
  switch (TOOL_KINDS[name]) {
    case 'read':
    case 'edit':
      return file ? relativeTo(file, cwd) : name;
    case 'run':
      return firstLine(str(input?.command) ?? str(input?.description) ?? name);
    case 'search': {
      const pattern = str(input?.pattern) ?? '';
      return file ? `${pattern} · ${relativeTo(file, cwd)}` : pattern || name;
    }
    case 'web':
      return str(input?.url) ?? str(input?.query) ?? name;
    case 'agent':
      return str(input?.description) ?? str(input?.subagent_type) ?? name;
    default:
      if (name === 'Skill') return str(input?.skill) ?? name;
      return name.startsWith('mcp__') ? name.slice(5).replace('__', ' · ') : name;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

// The turn's records turned into events. Only the text messages the turn
// parser kept (`textSrcs`) become text events, so the texts are exactly
// the stored ones.
function claudeEvents(records: readonly unknown[], from: number, to: number, textSrcs: ReadonlySet<number>, texts: Map<number, { text: string; at: string | null }>): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  const toolAt = new Map<string, number>();
  // A subagent's own transcript is all sidechain records; in a main
  // transcript sidechain records belong to (older CLIs') subagents.
  const sidechain = rec(records[from])?.isSidechain === true;
  for (let i = from; i < to; i++) {
    const record = rec(records[i]);
    if (!record || (record.isSidechain === true && !sidechain)) continue;
    const at = str(record.timestamp);
    if (record.type === 'system') {
      if (record.subtype === 'turn_duration') events.push({ type: 'end', src: i });
      else if (record.subtype === 'compact_boundary') events.push({ type: 'compaction', id: str(record.uuid) ?? `compact-${i}`, src: i, at });
      continue;
    }
    if (record.type === 'assistant') {
      if (textSrcs.has(i)) {
        const text = texts.get(i)!;
        events.push({ type: 'text', src: i, text: text.text, at: text.at });
        continue;
      }
      for (const block of contentBlocks(record)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = str(block.name) ?? 'tool';
          toolAt.set(block.id, events.length);
          events.push({
            type: 'tool', id: block.id, src: i, name, kind: TOOL_KINDS[name] ?? 'other',
            label: toolLabel(name, rec(block.input), str(record.cwd)), at, status: 'running',
            interactive: INTERACTIVE_TOOLS.has(name), resultSrc: null,
          });
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const hasText = typeof block.thinking === 'string' && block.thinking.trim() !== '';
          events.push({ type: 'thinking', id: str(record.uuid) ?? `thinking-${i}`, src: i, at, hasText });
        }
      }
      continue;
    }
    if (record.type === 'user') {
      if (isCompactSummary(record)) continue;
      let sawResult = false;
      for (const block of contentBlocks(record)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        sawResult = true;
        const at = toolAt.get(block.tool_use_id);
        const event = at === undefined ? undefined : events[at];
        if (event?.type === 'tool') {
          event.status = block.is_error === true ? 'error' : 'ok';
          event.resultSrc = i;
        }
      }
      if (!sawResult && INTERRUPTED_MARKER.test(textFromContent(rec(record.message)?.content))) events.push({ type: 'interrupt', src: i });
    }
  }
  return events;
}

export function claudeProcessTurns(records: readonly unknown[], offset = 0): ProcessTurn[] {
  const messages = claudeMessagesFromRecords(records, true, offset);
  return buildTurns(records.length, messages, (from, to, textSrcs, texts) => claudeEvents(records, from, to, textSrcs, texts));
}

// A subagent's transcript as one turn when it has no user message of its own.
export function claudeWholeTurn(records: readonly unknown[]): ProcessTurn | null {
  return wholeTurn(records.length, claudeMessagesFromRecords(records, true), (from, to, textSrcs, texts) => claudeEvents(records, from, to, textSrcs, texts));
}

export function claudeOpenTurn(records: readonly unknown[], offset = 0): ProcessTurn | null {
  return openTail(records.length, claudeMessagesFromRecords(records, true, offset), (from, to, textSrcs, texts) => claudeEvents(records, from, to, textSrcs, texts));
}

// Level 4: one item's details, looked up only among this turn's events.
export function claudeItemDetail(records: readonly unknown[], turn: ProcessTurn, itemId: string): ProcessItemDetail | null {
  const event = turn.events.find((candidate) => (candidate.type === 'tool' || candidate.type === 'thinking') && candidate.id === itemId);
  if (!event) return null;
  const record = rec(records[event.src]);
  if (!record) return null;
  if (event.type === 'thinking') {
    const block = contentBlocks(record).find((candidate) => candidate.type === 'thinking' || candidate.type === 'redacted_thinking');
    const text = str(block?.thinking)?.trim();
    return clipDetail({ thinking: text ? text : null });
  }
  if (event.type !== 'tool') return null;
  const block = contentBlocks(record).find((candidate) => candidate.type === 'tool_use' && candidate.id === event.id);
  const input = rec(block?.input);
  const result = event.resultSrc === null ? null : rec(records[event.resultSrc]);
  const resultBlock = result ? contentBlocks(result).find((candidate) => candidate.type === 'tool_result' && candidate.tool_use_id === event.id) : undefined;
  const output = resultBlock ? resultText(resultBlock.content) : undefined;
  const detail: { input?: string; output?: string; diff?: string } = {};
  const cwd = str(record.cwd);
  if (event.kind === 'run') detail.input = str(input?.command) ?? JSON.stringify(input, null, 2);
  else if (event.kind !== 'edit') detail.input = input ? JSON.stringify(input, null, 2) : undefined;
  if (event.kind === 'edit') {
    const file = str(input?.file_path) ?? str(input?.notebook_path) ?? '';
    const name = relativeTo(file, cwd);
    const patch = rec(result?.toolUseResult)?.structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) detail.diff = structuredPatchDiff(name, patch);
    else if (typeof input?.old_string === 'string' && typeof input.new_string === 'string') detail.diff = linesDiff(name, input.old_string, input.new_string);
    else if (Array.isArray(input?.edits)) {
      detail.diff = input.edits.map((edit) => rec(edit)).filter(Boolean)
        .map((edit) => linesDiff(name, str(edit!.old_string) ?? '', str(edit!.new_string) ?? '')).join('\n');
    } else if (typeof input?.content === 'string') detail.diff = linesDiff(name, '', input.content);
    if (event.status === 'error' && output) detail.output = output;
  } else if (output !== undefined) detail.output = output;
  // Claude Code writes a failed command's code at the head of its result.
  const exit = event.kind === 'run' && event.status === 'error' ? /^Exit code (\d+)/.exec(output ?? '') : null;
  const images = listProcessImages(resultImages(resultBlock?.content));
  return clipDetail({ ...detail, ...(exit ? { exitCode: Number(exit[1]) } : {}), ...(images ? { images } : {}) });
}

// A tool result's own images: base64 blocks (a screenshot, an image file Read).
function resultImages(content: unknown): RawProcessImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): RawProcessImage[] => {
    const source = rec(rec(block)?.type === 'image' ? rec(block)?.source : null);
    const data = source?.type === 'base64' ? str(source.data) : null;
    return data ? [{ source: 'result', data }] : [];
  });
}

/** One tool item's images, looked up only among this turn's events; null when there is no such item. */
export function claudeItemImages(records: readonly unknown[], turn: ProcessTurn, itemId: string): RawProcessImage[] | null {
  const event = turn.events.find((candidate) => candidate.type === 'tool' && candidate.id === itemId);
  if (!event || event.type !== 'tool') return null;
  const result = event.resultSrc === null ? null : rec(records[event.resultSrc]);
  const resultBlock = result ? contentBlocks(result).find((candidate) => candidate.type === 'tool_result' && candidate.tool_use_id === event.id) : undefined;
  return resultImages(resultBlock?.content);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    const b = rec(block);
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
    if (b?.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}
