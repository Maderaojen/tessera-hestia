import { PROVIDER_ROOTS } from '../config.js';
import { UUID_SHAPE } from '../ids.js';
import path from 'node:path';
import type { Turn } from '../types.js';
import { open } from 'node:fs/promises';
import { walkFiles } from './locate.js';
import { codexLimitHit } from './codex-limit.js';
import { readCodexInteraction } from './codex-interaction.js';
import { codexSubagentStillRunning, listCodexSubagents, openCodexSubagents, readCodexSubagentMessages } from './codex-subagents.js';
import { readJsonlLines, readTailRecords } from './jsonl.js';
import { codexPermissionModes } from './permission-mode.js';
import { assembleCompleteTurns, dedupe, isWrapper, textFromContent, type Msg, type SourcedMsg } from './msg.js';
import type { LocateOpts, OpenTurn, TranscriptAdapter } from './types.js';

// Codex rollout JSONL transcripts. Codex cannot pin a session id at launch;
// locating waits for an ID observed from this exact pane (runtimes/codex-cli.ts).
export const codexAdapter: TranscriptAdapter = {
  name: 'codex',

  async locateSessionFile({ providerSessionId, cwd, conversationRoot }: LocateOpts) {
    if (!providerSessionId || !UUID_SHAPE.test(providerSessionId)) return { status: 'pending' } as const;
    const root = conversationRoot ?? PROVIDER_ROOTS.codex;
    const roots = rolloutSearchRoots(root, providerSessionId);
    const files = (await Promise.all(roots.map((candidate) => walkFiles(candidate, (name) =>
      name.startsWith('rollout-') && name.endsWith(`-${providerSessionId.toLowerCase()}.jsonl`),
    )))).flat();
    const matching: string[] = [];
    for (const file of files) {
      if (!path.basename(file).toLowerCase().endsWith(`-${providerSessionId.toLowerCase()}.jsonl`)) continue;
      if (await hasMatchingIdentity(file, providerSessionId, cwd)) matching.push(file);
    }
    if (matching.length > 1) return { status: 'ambiguous' } as const;
    return matching.length === 1
      ? { status: 'resolved', file: matching[0], identity: 'verified_metadata' } as const
      : { status: 'not_found' } as const;
  },

  async parseMessages(sessionFilePath: string): Promise<Msg[]> {
    return codexMessages(await readJsonlLines(sessionFilePath));
  },

  // A turn's task_started is written the moment Codex takes the message in;
  // the message follows once the turn gets to it — after an automatic
  // compaction of a long conversation, over a minute later (0.161.0,
  // test/fixtures/turn-boundaries/codex.compaction-before-user-message).
  async parseTurnStarts(sessionFilePath: string): Promise<string[]> {
    const starts: string[] = [];
    for (const record of await readJsonlLines(sessionFilePath)) {
      const rec = record as Record<string, unknown> | null;
      if (rec?.type !== 'event_msg' || typeof rec.timestamp !== 'string') continue;
      if ((rec.payload as Record<string, unknown> | null)?.type === 'task_started') starts.push(rec.timestamp);
    }
    return starts;
  },

  async parseTurns(sessionFilePath: string): Promise<Turn[]> {
    return assembleCompleteTurns(await this.parseMessages(sessionFilePath));
  },

  // UNVERIFIED — Codex approval records have not been empirically checked.
  // Preserve that fact rather than asserting there is no pending prompt.
  async findPendingInteraction() {
    return { status: 'unknown' } as const;
  },

  // Every turn opens with a task_started event and closes with task_complete
  // (also when it ends on an error) or, when stopped with Esc, turn_aborted
  // — verified against 0.160.0 (test/fixtures/turn-boundaries/). Codex
  // writes `commentary` messages mid-turn and goes quiet for a minute at a
  // time while it waits on a sub-agent, so file quiescence alone would end
  // the turn early. The last boundary decides; a rollout with none (older
  // CLIs, or a turn that hasn't started) leaves quiescence in charge.
  async isTurnComplete(sessionFilePath: string) {
    const boundary = lastTurnBoundary(await readJsonlLines(sessionFilePath));
    if (!boundary) return { status: 'unknown' } as const;
    return { status: 'supported', value: boundary !== 'task_started' } as const;
  },

  // Its approval prompts are only on screen (codex-interaction.ts).
  readPaneInteraction: readCodexInteraction,

  // Only the rollout's tail: the hit, if any, is its last turn event.
  async readLimitHit(sessionFilePath: string) {
    const records = await readTailRecords(sessionFilePath);
    return records ? codexLimitHit(records) : null;
  },

  // Every turn's turn_context (permission-mode.ts).
  readPermissionModes: async (sessionFilePath: string) => codexPermissionModes(await readJsonlLines(sessionFilePath)),

  // A turn opens with task_started and always closes with task_complete or
  // turn_aborted (see isTurnComplete). One still open is a person's when a
  // user message follows its task_started — which can come over a minute
  // later (parseTurnStarts) — and otherwise taken as Codex's own.
  async openTurnAtEnd(sessionFilePath: string) {
    return codexOpenTurnAtEnd(await readJsonlLines(sessionFilePath));
  },

  // Its native subagents, each a rollout of its own (codex-subagents.ts).
  listSubagents: (sessionFilePath: string) => listCodexSubagents(sessionFilePath),
  readSubagentMessages: (sessionFilePath: string, agentId: string) => readCodexSubagentMessages(sessionFilePath, agentId),
  // Still out by the parent's rollout; confirmed by the child's own tail,
  // since the parent need not record a background child's end.
  openBackgroundSubagents: (sessionFilePath: string) => openCodexSubagents(sessionFilePath),
  subagentStillRunning: (sessionFilePath: string, agentId: string) => codexSubagentStillRunning(sessionFilePath, agentId),
};

// A message as it was typed or pasted. A paste that was nothing but an
// image's path Codex attaches as the image (0.162.1): `<image name=[Image
// #N] path="…">`, the image, `</image>`, then "[Image #N]" where it stood.
// Read back to the path, so the chat, its attachments and delivery checks
// see what the app sent.
const IMAGE_BLOCK = /<image name=\[Image #(\d+)\] path="([^"]+)">\s*<\/image>\s*/g;

export function codexTypedText(text: string): string {
  if (!text.includes('<image name=[Image #')) return text;
  const paths = new Map<string, string>();
  const rest = text.replace(IMAGE_BLOCK, (_whole, id: string, path: string) => {
    paths.set(id, path);
    return '';
  });
  return rest.replace(/\[Image #(\d+)\]/g, (placeholder, id: string) => paths.get(id) ?? placeholder).trim();
}

// The user and assistant messages among a rollout's records.
export function codexMessages(records: readonly unknown[]): Msg[] {
  return codexSourcedMessages(records).map(({ src: _src, phase: _phase, ...message }) => message);
}

// codexMessages with each message's record position and, for a reply,
// Codex's own `phase` (commentary / final_answer) — process/codex.ts.
export function codexSourcedMessages(records: readonly unknown[], offset = 0): (SourcedMsg & { phase?: string })[] {
  const messages: (SourcedMsg & { phase?: string })[] = [];
  for (let i = offset; i < records.length; i++) {
    const record = records[i];
    if (typeof record !== 'object' || record === null) continue;
    const rec = record as Record<string, unknown>;
    if (rec.type !== 'response_item') continue;
    const payload = rec.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    const payloadRec = payload as Record<string, unknown>;
    if (payloadRec.type !== 'message') continue;
    const role = payloadRec.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const raw = textFromContent(payloadRec.content);
    const text = role === 'user' ? codexTypedText(raw) : raw;
    if (!text || isWrapper(text)) continue;
    const ts =
      (typeof rec.timestamp === 'string' && rec.timestamp) ||
      (typeof payloadRec.timestamp === 'string' && payloadRec.timestamp) ||
      null;
    messages.push({ role, text, ts, src: i, ...(typeof payloadRec.phase === 'string' ? { phase: payloadRec.phase } : {}) });
  }
  return dedupe(messages);
}

const TURN_BOUNDARIES = new Set(['task_started', 'task_complete', 'turn_aborted']);

// Records come from the shared parse cache (jsonl.ts), so walking back from
// the end costs nothing per poll even when the turn began megabytes ago.
export function codexOpenTurnAtEnd(records: readonly unknown[]): OpenTurn | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i] as Record<string, unknown> | null;
    if (rec?.type !== 'event_msg') continue;
    const type = (rec.payload as Record<string, unknown> | null)?.type;
    if (typeof type !== 'string' || !TURN_BOUNDARIES.has(type)) continue;
    if (type !== 'task_started') return null;
    const message = codexSourcedMessages(records, i + 1).find((candidate) => candidate.role === 'user');
    return message ? { openedBy: 'user', at: message.ts } : { openedBy: 'cli', at: null };
  }
  return null;
}

export function lastTurnBoundary(records: readonly unknown[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i] as Record<string, unknown> | null;
    if (rec?.type !== 'event_msg') continue;
    const type = (rec.payload as Record<string, unknown> | null)?.type;
    if (typeof type === 'string' && TURN_BOUNDARIES.has(type)) return type;
  }
  return null;
}

async function hasMatchingIdentity(file: string, id: string, cwd: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
    const bytes = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return false;
    const row = JSON.parse(bytes.toString('utf8', 0, end)) as Record<string, unknown>;
    if (row.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') return false;
    const meta = row.payload as Record<string, unknown>;
    return typeof meta.id === 'string' && meta.id.toLowerCase() === id.toLowerCase()
      && (meta.session_id === undefined || (typeof meta.session_id === 'string' && meta.session_id.toLowerCase() === id.toLowerCase()))
      && typeof meta.cwd === 'string' && path.resolve(meta.cwd) === path.resolve(cwd);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export function rolloutSearchRoots(root: string, id: string): string[] {
  // Codex 0.156.1 uses UUIDv7 IDs and stores rollouts under
  // sessions/YYYY/MM/DD. The UUID itself supplies the creation date, so a
  // pending session need not recursively scan years of history every poll.
  // Probe adjacent UTC dates to cover the CLI's local timezone partition.
  if (id.split('-')[2]?.[0]?.toLowerCase() !== '7') return [root];
  const millis = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
  const stamp = new Date(millis);
  if (!Number.isFinite(millis) || Number.isNaN(stamp.getTime())) return [root];
  return [-1, 0, 1].map((offset) => {
    const day = new Date(millis + offset * 86_400_000).toISOString().slice(0, 10);
    const [year, month, date] = day.split('-');
    return path.join(root, year, month, date);
  });
}
