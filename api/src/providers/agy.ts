import path from 'node:path';
import os from 'node:os';
import { UUID_SHAPE } from '../ids.js';
import type { Turn } from '../types.js';
import { readAgyMessages, readAgyQuotaStop, verifyAgyDatabase } from './agy-sqlite.js';
import { assembleCompleteTurns, type Msg } from './msg.js';
import type { LocateOpts, TranscriptAdapter } from './types.js';

/** Agy stores conversations separately from the legacy Gemini CLI. */
export function agyConversationsRoot(override?: string): string {
  return path.resolve(override ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations'));
}

// Agy (Gemini product) keeps one SQLite database per conversation, named by
// its cascade ID. Its format must never reach the Gemini CLI JSON parser.
export const agyAdapter: TranscriptAdapter = {
  name: 'gemini',
  async locateSessionFile({ providerSessionId, conversationRoot }: LocateOpts) {
    // No observed ID yet is the normal pre-binding state, not a conflict.
    if (!providerSessionId) return { status: 'pending' } as const;
    if (!UUID_SHAPE.test(providerSessionId)) return { status: 'ambiguous' } as const;
    const file = path.join(agyConversationsRoot(conversationRoot), `${providerSessionId}.db`);
    const verification = verifyAgyDatabase(file, providerSessionId);
    if (verification === 'not_found') return { status: 'not_found' } as const;
    if (verification !== 'verified') return { status: 'ambiguous' } as const;
    return { status: 'resolved', file, identity: 'verified_metadata' } as const;
  },
  async parseMessages(file: string): Promise<Msg[]> { return readAgyMessages(file); },
  async parseTurns(file: string): Promise<Turn[]> { return assembleCompleteTurns(await this.parseMessages(file)); },
  // Only the quota stop is told from the database: a turn Agy ended on its
  // quota writes no reply, so nothing else would ever end it. Any other
  // turn is left to the poller's fallback, as before.
  async isTurnComplete(file: string) {
    return readAgyQuotaStop(file) ? { status: 'supported', value: true } as const : { status: 'unknown' } as const;
  },
  async readLimitHit(file: string) {
    const stop = readAgyQuotaStop(file);
    if (!stop) return null;
    return {
      at: stop.at ?? new Date().toISOString(),
      // Agy names no window; its quota resets within the day.
      scope: 'unknown', limitType: 'individual_quota', model: null,
      resetsAt: stop.resetsAt, message: stop.message, ruleId: 'agy/individual-quota',
    } as const;
  },
  async findPendingInteraction() { return { status: 'unknown' } as const; },
};
