import path from 'node:path';
import { PROVIDER_ROOTS } from '../config.js';
import type { Turn } from '../types.js';
import { newestFileSince, walkFiles } from './locate.js';
import { readJsonlLines } from './jsonl.js';
import { assembleCompleteTurns, dedupe, isWrapper, textFromContent, type Msg } from './msg.js';
import type { LocateOpts, TranscriptAdapter } from './types.js';

// UNVERIFIED against a live launch — same caveat as codex.ts. Gemini has no
// documented way to pin a session id at launch either, so this also falls
// back to "newest chat file under */chats/ created after we launched".
export const geminiAdapter: TranscriptAdapter = {
  name: 'gemini',

  async locateSessionFile({ launchedAfter, conversationRoot }: LocateOpts) {
    const root = conversationRoot ?? PROVIDER_ROOTS.gemini;
    const files = await walkFiles(root, (name) => name.endsWith('.json') || name.endsWith('.jsonl'));
    // Narrow to the documented `*/chats/*` shape when possible; fall back
    // to every candidate if that narrowing finds nothing (layout may vary).
    const chatFiles = files.filter((f) => path.basename(path.dirname(f)) === 'chats');
    const candidate = await newestFileSince(chatFiles.length > 0 ? chatFiles : files, Date.parse(launchedAfter));
    return candidate ? { status: 'ambiguous' } as const : { status: 'not_found' } as const;
  },

  async parseMessages(sessionFilePath: string): Promise<Msg[]> {
    // Gemini writes a mutation log: an initial {"$set":{"messages":[...]}}
    // batch, then bare per-message records, sometimes re-emitted as they
    // stream — so later records with more content replace earlier ones
    // with the same id before we assemble turns.
    const records = await readJsonlLines(sessionFilePath);
    const collected: Record<string, unknown>[] = [];
    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue;
      const rec = record as Record<string, unknown>;
      const setBlock = rec.$set;
      if (setBlock && typeof setBlock === 'object' && Array.isArray((setBlock as Record<string, unknown>).messages)) {
        for (const m of (setBlock as Record<string, unknown>).messages as unknown[]) {
          if (m && typeof m === 'object') collected.push(m as Record<string, unknown>);
        }
      } else if (rec.type === 'user' || rec.type === 'gemini') {
        collected.push(rec);
      }
    }

    const best = new Map<string, Record<string, unknown>>();
    const order: string[] = [];
    collected.forEach((rec, i) => {
      const rid = typeof rec.id === 'string' ? rec.id : `_${i}`;
      const existing = best.get(rid);
      if (!existing) {
        order.push(rid);
        best.set(rid, rec);
      } else if (textFromContent(rec.content).length > textFromContent(existing.content).length) {
        best.set(rid, rec);
      }
    });

    const messages: Msg[] = [];
    for (const rid of order) {
      const rec = best.get(rid);
      if (!rec) continue;
      const role: Msg['role'] = rec.type === 'gemini' ? 'assistant' : 'user';
      const text = textFromContent(rec.content);
      if (!text || isWrapper(text)) continue;
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
      messages.push({ role, text, ts });
    }
    messages.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    return dedupe(messages);
  },

  async parseTurns(sessionFilePath: string): Promise<Turn[]> {
    return assembleCompleteTurns(await this.parseMessages(sessionFilePath));
  },

  // UNVERIFIED — no transcript-level pending-interaction semantics have
  // been confirmed for Gemini, so retain an explicit unknown result.
  async findPendingInteraction() {
    return { status: 'unknown' } as const;
  },

  // UNVERIFIED — completion semantics have not been confirmed for Gemini.
  async isTurnComplete() {
    return { status: 'unknown' } as const;
  },
};
