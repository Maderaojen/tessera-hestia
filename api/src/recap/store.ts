import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { RECAP_ERROR_CODES, RECAP_STATUSES, type ConversationRecapItem, type RecapErrorCode, type RecapStatus } from '../contract/recap.js';
import { PROVIDERS, RUNTIME_IDS, type Provider, type RuntimeId } from '../contract/runtimes.js';
import type { Turn } from '../contract/sessions.js';
import { ARCHIVE_HOST, dialogueFile } from '../dialogue-store.js';
import { writeFileAtomic } from '@maderaojen/json-file-store';
import { mergeRecap } from './merge.js';
import type { RecapOutput } from './schema.js';

// One conversation's recap file, beside its archive
// (DIALOGUE_ROOT/<host>/<provider>/<tmux>/<conversation>.recap.json). Background batches and the user's status changes both
// read-modify-write it, one at a time per file. An unreadable file reads as
// no recap rather than failing whoever asked.

/** Which conversation a recap belongs to: what names its file and what it records of itself. */
export type RecapOwner = {
  sessionId: string;
  tmuxName: string;
  projectId: string | null;
  conversationId: string;
  provider: Provider | null;
};

export type RecapGenerator = { profileId: string; profileLabel: string; runtimeId: RuntimeId; model: string; effort: string | null };
export type RecapLastError = { code: RecapErrorCode; at: string; retryAt: string | null; params?: Record<string, string> };

export type ConversationRecapFile = {
  version: 1;
  identity: { host: string; sessionId: string; conversationId: string; tmuxName: string; provider: Provider; projectId: string | null };
  language: 'zh-TW';
  items: ConversationRecapItem[];
  // The first coveredTurns turns (array order) are in the recap.
  coveredTurns: number;
  // The last of them, to notice the turns being parsed again and shifting
  // (docs/decisions/0006): then the recap is made again from the start.
  lastCovered: { index: number; userAt: string | null; userTextHash: string } | null;
  // When a batch was last written.
  updatedAt: string | null;
  generator: RecapGenerator | null;
  lastError: RecapLastError | null;
  // Failures in a row; 0 after a success.
  failures: number;
  // The user asked for it (更新／建立摘要); cleared once caught up.
  requestedAt: string | null;
};

const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(RECAP_STATUSES),
  statusSource: z.enum(['auto', 'user']),
  turns: z.object({ from: z.number().int(), to: z.number().int() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  statusChangedAt: z.string().nullable(),
});

const fileSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    host: z.string(), sessionId: z.string(), conversationId: z.string(), tmuxName: z.string(),
    provider: z.enum(PROVIDERS), projectId: z.string().nullable(),
  }),
  language: z.literal('zh-TW'),
  items: z.array(itemSchema),
  coveredTurns: z.number().int().min(0),
  lastCovered: z.object({ index: z.number().int(), userAt: z.string().nullable(), userTextHash: z.string() }).nullable(),
  updatedAt: z.string().nullable(),
  generator: z.object({
    profileId: z.string(), profileLabel: z.string(), runtimeId: z.enum(RUNTIME_IDS), model: z.string(), effort: z.string().nullable(),
  }).nullable(),
  lastError: z.object({
    code: z.enum(RECAP_ERROR_CODES), at: z.string(), retryAt: z.string().nullable(), params: z.record(z.string(), z.string()).optional(),
  }).nullable(),
  failures: z.number().int().min(0),
  requestedAt: z.string().nullable(),
});

/** Where a conversation's recap is kept. Throws for a conversation without a provider (it has no archive). */
export function recapFilePath(owner: RecapOwner): string {
  return dialogueFile({ tmuxName: owner.tmuxName }, { id: owner.conversationId, provider: owner.provider }, '.recap.json');
}

export function emptyRecapFile(owner: RecapOwner): ConversationRecapFile {
  if (!owner.provider) throw new Error('a conversation without a provider has no recap');
  return {
    version: 1,
    identity: {
      host: ARCHIVE_HOST, sessionId: owner.sessionId, conversationId: owner.conversationId, tmuxName: owner.tmuxName,
      provider: owner.provider, projectId: owner.projectId,
    },
    language: 'zh-TW',
    items: [],
    coveredTurns: 0,
    lastCovered: null,
    updatedAt: null,
    generator: null,
    lastError: null,
    failures: 0,
    requestedAt: null,
  };
}

async function readAt(file: string): Promise<ConversationRecapFile | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[recap] could not read ${file}: ${(err as Error).message}`);
    return null;
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    console.warn(`[recap] ${file} is not a recap file, treated as none: ${parsed.error.message}`);
  } catch (err) {
    console.warn(`[recap] ${file} is not JSON, treated as none: ${(err as Error).message}`);
  }
  return null;
}

/** The conversation's recap, or null when it has none (or its file can't be read). */
export async function readRecapFile(owner: RecapOwner): Promise<ConversationRecapFile | null> {
  return readAt(recapFilePath(owner));
}

const queues = new Map<string, Promise<unknown>>();

// One read-modify-write at a time per file, in call order.
function serial<T>(file: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return next;
}

async function write(file: string, recap: ConversationRecapFile): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(recap, null, 2)}\n`);
}

/**
 * Changes the recap (made empty if there is none) as `mutate` says, in the
 * file's queue; `mutate` returning null leaves the file as it was.
 */
export function updateRecapFile(
  owner: RecapOwner, mutate: (recap: ConversationRecapFile, existed: boolean) => ConversationRecapFile | null,
): Promise<ConversationRecapFile | null> {
  const file = recapFilePath(owner);
  return serial(file, async () => {
    const found = await readAt(file);
    const next = mutate(found ? structuredClone(found) : emptyRecapFile(owner), found !== null);
    if (!next) return found;
    await write(file, next);
    return next;
  });
}

export function userTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function sameTurn(seen: NonNullable<ConversationRecapFile['lastCovered']>, turn: Turn | undefined): boolean {
  return !!turn && turn.index === seen.index && turn.user.at === seen.userAt && userTextHash(turn.user.text) === seen.userTextHash;
}

function coverOf(turn: Turn): NonNullable<ConversationRecapFile['lastCovered']> {
  return { index: turn.index, userAt: turn.user.at, userTextHash: userTextHash(turn.user.text) };
}

/**
 * Where recapping picks up, given every turn of the conversation now:
 * after the recap's coveredTurns, or from the start (`rebuild`) when the
 * turns it covered are no longer where it left them.
 */
export function recapProgress(recap: ConversationRecapFile | null, turns: readonly Turn[]): { coveredTurns: number; rebuild: boolean } {
  if (!recap || recap.coveredTurns === 0) return { coveredTurns: 0, rebuild: false };
  const shifted = recap.coveredTurns > turns.length || !recap.lastCovered || !sameTurn(recap.lastCovered, turns[recap.coveredTurns - 1]);
  return shifted ? { coveredTurns: 0, rebuild: true } : { coveredTurns: recap.coveredTurns, rebuild: false };
}

export type RecapBatchWrite = {
  output: RecapOutput;
  // The batch's turns, and where they start in the conversation's turns
  // (the coveredTurns the batch was planned from; 0 on a rebuild).
  batch: Turn[];
  startAt: number;
  // Every turn of the conversation now, to check the batch still fits.
  turns: readonly Turn[];
  generator: RecapGenerator;
  now: string;
  // Caught up with this batch: the user's request is done.
  clearRequest: boolean;
};

export type RecapBatchResult =
  | { ok: true; recap: ConversationRecapFile }
  // The answer broke the rules (merge.ts); nothing written.
  | { ok: false; code: 'invalid_output'; reason: string }
  // The recap or the turns moved on while the batch ran; plan it again.
  | { ok: false; code: 'stale'; reason: string };

/**
 * One batch's answer folded into `recap` (§3.4): the recap as it is on
 * file now, `existed` false when there was none yet. Pure; applyBatch is
 * what writes it.
 */
export function foldBatch(recap: ConversationRecapFile, existed: boolean, request: RecapBatchWrite): RecapBatchResult {
  const { batch, startAt, turns } = request;
  const last = batch.at(-1);
  if (!last) throw new Error('an empty batch');
  const progress = recapProgress(existed ? recap : null, turns);
  const moved = batch.some((turn, offset) => {
    const now = turns[startAt + offset];
    return !now || now.index !== turn.index || now.user.at !== turn.user.at || now.user.text !== turn.user.text;
  });
  if (progress.coveredTurns !== startAt || moved) {
    return { ok: false, code: 'stale', reason: `planned from turn ${startAt}, the recap is at ${progress.coveredTurns}${moved ? ' and the turns moved' : ''}` };
  }
  const merged = mergeRecap({ current: recap.items, output: request.output, batch: { from: batch[0]!.index, to: last.index }, now: request.now });
  if (!merged.ok) return { ok: false, code: 'invalid_output', reason: merged.reason };
  return {
    ok: true,
    recap: {
      ...recap,
      items: merged.items,
      coveredTurns: startAt + batch.length,
      lastCovered: coverOf(last),
      updatedAt: request.now,
      generator: request.generator,
      lastError: null,
      failures: 0,
      requestedAt: request.clearRequest ? null : recap.requestedAt,
    },
  };
}

/** Folds one batch's answer into the recap as it is on file when written. */
export async function applyBatch(owner: RecapOwner, request: RecapBatchWrite): Promise<RecapBatchResult> {
  let result: RecapBatchResult | undefined;
  await updateRecapFile(owner, (recap, existed) => {
    result = foldBatch(recap, existed, request);
    return result.ok ? result.recap : null;
  });
  return result!;
}

/** The user's status for one item, kept from then on (§3.4). null when there is no such item. */
export async function setItemStatus(owner: RecapOwner, itemId: string, status: RecapStatus, now: string): Promise<ConversationRecapFile | null> {
  let found = false;
  const written = await updateRecapFile(owner, (recap, existed) => {
    const item = existed ? recap.items.find((candidate) => candidate.id === itemId) : undefined;
    if (!item) return null;
    found = true;
    Object.assign(item, { status, statusSource: 'user', statusChangedAt: now, updatedAt: now });
    return recap;
  });
  return found ? written : null;
}
