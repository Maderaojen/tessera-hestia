import { randomBytes } from 'node:crypto';
import type { ConversationRecapItem } from '../contract/recap.js';
import { RECAP_MAX_ITEMS, RECAP_TITLE_MAX_CHARS } from './constants.js';
import type { RecapOutput } from './schema.js';

// Folding the model's answer into the recap on file. The model is asked to keep ids, statuses the user set and every
// item; it is not trusted to. What it may do is enforced here: items only
// leave the list by being merged into another, never a user's item; a
// status the user set is the user's; ids are the app's own.

type Range = { from: number; to: number };

export type RecapMergeInput = {
  // The recap as it is on file when the answer is written (read again
  // then, so a status the user changed meanwhile is the one kept).
  current: ConversationRecapItem[];
  // The model's answer, already of the schema's shape (schema.ts).
  output: RecapOutput;
  // The batch's first and last turn, as Turn.index.
  batch: Range;
  now: string;
  // Tests pass their own; `taken` holds every id in use.
  newId?: (taken: ReadonlySet<string>) => string;
};

export type RecapMergeResult = { ok: true; items: ConversationRecapItem[] } | { ok: false; reason: string };

export function newRecapItemId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `r_${randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

/** A title on one line, cut to RECAP_TITLE_MAX_CHARS characters ending in '…'. */
export function normalizeRecapTitle(title: string): string {
  const line = title.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > RECAP_TITLE_MAX_CHARS ? `${chars.slice(0, RECAP_TITLE_MAX_CHARS - 1).join('')}…` : line;
}

function ordered(range: Range): Range {
  return range.from > range.to ? { from: range.to, to: range.from } : { ...range };
}

function clamp(range: Range, low: number, high: number): Range {
  const fit = (value: number) => Math.min(Math.max(value, low), high);
  return { from: fit(range.from), to: fit(range.to) };
}

function union(ranges: Range[]): Range {
  return { from: Math.min(...ranges.map((range) => range.from)), to: Math.max(...ranges.map((range) => range.to)) };
}

// Every rule an answer breaks as a whole (§3.4 step 1); null when none.
// The reason goes to the server log, so it never names an id: the model
// may have made one up out of the conversation.
function invalidReason(current: Map<string, ConversationRecapItem>, output: RecapOutput): string | null {
  if (output.items.length > RECAP_MAX_ITEMS) return `more than ${RECAP_MAX_ITEMS} items`;
  const ids = new Set<string>();
  for (const item of output.items) {
    if (item.id === null) continue;
    if (ids.has(item.id)) return 'duplicate id';
    ids.add(item.id);
  }
  const merged = new Set<string>();
  for (const item of output.items) {
    for (const id of item.mergedFrom) {
      if (!current.has(id)) return 'mergedFrom names an unknown id';
      if (ids.has(id)) return 'an id both kept and merged';
      if (merged.has(id)) return 'an id merged twice';
      merged.add(id);
    }
    if (!normalizeRecapTitle(item.title)) return 'empty title';
  }
  return null;
}

export function mergeRecap({ current, output, batch, now, newId = newRecapItemId }: RecapMergeInput): RecapMergeResult {
  const byId = new Map(current.map((item) => [item.id, item]));
  const invalid = invalidReason(byId, output);
  if (invalid) return { ok: false, reason: invalid };

  const span = ordered(batch);
  const taken = new Set(byId.keys());
  // Merged away for good: a user's item can't be (it is put back below).
  const removed = new Set<string>();
  const items: ConversationRecapItem[] = output.items.map((item) => {
    const existing = item.id === null ? undefined : byId.get(item.id);
    const absorbed = item.mergedFrom.map((id) => byId.get(id)!).filter((other) => other.statusSource !== 'user');
    for (const other of absorbed) removed.add(other.id);
    // A new item is about this batch, whatever the model said.
    const own = existing ? ordered(item.turns) : clamp(ordered(item.turns), span.from, span.to);
    const turns = clamp(union([own, ...absorbed.map((other) => other.turns)]), 0, span.to);
    const title = normalizeRecapTitle(item.title);
    if (!existing) {
      const id = newId(taken);
      taken.add(id);
      return { id, title, status: item.status, statusSource: 'auto', turns, createdAt: now, updatedAt: now, statusChangedAt: null };
    }
    const status = existing.statusSource === 'user' ? existing.status : item.status;
    const changed = title !== existing.title || status !== existing.status
      || turns.from !== existing.turns.from || turns.to !== existing.turns.to;
    return { ...existing, title, status, turns, updatedAt: changed ? now : existing.updatedAt };
  });

  // Anything the answer dropped without merging it comes back as it was,
  // after the item it used to follow.
  const kept = new Set(items.map((item) => item.id));
  current.forEach((item, index) => {
    if (kept.has(item.id) || removed.has(item.id)) return;
    const after = index === 0 ? -1 : items.findIndex((other) => other.id === current[index - 1]!.id);
    if (index === 0) items.unshift({ ...item });
    else if (after === -1) items.push({ ...item });
    else items.splice(after + 1, 0, { ...item });
    kept.add(item.id);
  });

  if (items.length > RECAP_MAX_ITEMS) return { ok: false, reason: `more than ${RECAP_MAX_ITEMS} items` };
  return { ok: true, items };
}
