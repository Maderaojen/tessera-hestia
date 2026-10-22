import type { SearchHit, SearchPart, SessionSearchPage } from '../contract/search.js';
import type { ManagedSession } from '../types.js';

const SCAN_LIMIT = 2000;
export class InvalidSearchCursorError extends Error {}
type Position = [string, string, string, number, string, number, number, number];
const partOrder: Record<SearchPart, number> = { user: 0, followUp: 1, assistant: 2 };

function comparePosition(a: Position, b: Position): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function cursorPosition(cursor: string | undefined, query: string): Position | null {
  if (!cursor || cursor.length > 1024) {
    if (cursor) throw new InvalidSearchCursorError('invalid search cursor');
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') throw new Error();
    const data = decoded as { v?: unknown; q?: unknown; p?: unknown };
    if (data.v !== 1 || data.q !== query || !Array.isArray(data.p) || data.p.length !== 8
      || data.p.slice(0, 3).some((value) => typeof value !== 'string')
      || typeof data.p[3] !== 'number' || typeof data.p[4] !== 'string'
      || data.p.slice(5).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error();
    return data.p as Position;
  } catch {
    throw new InvalidSearchCursorError('invalid search cursor');
  }
}

function snippetFor(text: string, query: string): string {
  const normalized = text.normalize('NFC');
  const chars = Array.from(normalized);
  const lower = normalized.toLocaleLowerCase();
  const index = lower.indexOf(query.toLocaleLowerCase());
  const before = Array.from(lower.slice(0, Math.max(index, 0))).length;
  const start = Math.max(0, before - 48);
  const end = Math.min(chars.length, start + 158);
  return `${start ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

export function searchPersistedSessions(sessions: ManagedSession[], query: string, limit: number, cursor?: string): SessionSearchPage {
  const normalizedQuery = query.trim().normalize('NFC');
  const after = cursorPosition(cursor, normalizedQuery);
  const results: SearchHit[] = [];
  let scanned = 0;
  let last: Position | null = null;
  const sortedSessions = [...sessions].sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));

  for (const session of sortedSessions) {
    const sessionPosition = [session.createdAt, session.id] as const;
    const sessionBeforeCursor = after && (compareText(sessionPosition[0], after[0]) || compareText(sessionPosition[1], after[1]));
    if (sessionBeforeCursor && sessionBeforeCursor < 0) continue;
    const sameSession = !!after && sessionPosition[0] === after[0] && sessionPosition[1] === after[1];
    const conversations = [...(session.conversations ?? [])].sort((a, b) =>
      compareText(a.startedAt, b.startedAt) || a.sequence - b.sequence || compareText(a.id, b.id));
    for (const conversation of conversations) {
      const conversationBeforeCursor = sameSession && after
        && (compareText(conversation.startedAt, after[2]) || conversation.sequence - after[3] || compareText(conversation.id, after[4]));
      if (conversationBeforeCursor && conversationBeforeCursor < 0) continue;
      const sameConversation = !!sameSession && !!after && conversation.startedAt === after[2]
        && conversation.sequence === after[3] && conversation.id === after[4];
      for (let turnIndex = sameConversation ? after![5] : 0; turnIndex < conversation.turns.length; turnIndex++) {
        const turn = conversation.turns[turnIndex]!;
        const resumePart = sameConversation && after && turnIndex === after[5] ? after[6] : -1;
        const resumeFollowUp = resumePart === 1 ? after![7] : -1;
        function* messages(): Generator<{ part: SearchPart; followUpIndex: number | null; text: string; at: string | null }> {
          if (resumePart < 0) yield { part: 'user', followUpIndex: null, text: turn.user.text, at: turn.user.at };
          const followUps = turn.followUps ?? [];
          for (let index = resumePart < 1 ? 0 : resumeFollowUp + 1; resumePart < 2 && index < followUps.length; index++) {
            const followUp = followUps[index]!;
            yield { part: 'followUp', followUpIndex: index, text: followUp.text, at: followUp.at };
          }
          if (resumePart < 2) yield { part: 'assistant', followUpIndex: null, text: turn.assistant.text, at: turn.assistant.at };
        }
        for (const message of messages()) {
          const position: Position = [session.createdAt, session.id, conversation.startedAt, conversation.sequence,
            conversation.id, turnIndex, partOrder[message.part], message.followUpIndex ?? 0];
          if (after && comparePosition(position, after) <= 0) continue;
          last = position;
          scanned++;
          if (message.text.normalize('NFC').toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())) {
            results.push({ sessionId: session.id, sessionNumber: session.sessionNumber ?? 1,
              conversationId: conversation.id, conversationSequence: conversation.sequence, turnIndex: turn.index,
              part: message.part, followUpIndex: message.followUpIndex, at: message.at,
              snippet: snippetFor(message.text, normalizedQuery) });
          }
          if (results.length >= limit || scanned >= SCAN_LIMIT) {
            return { results, nextCursor: Buffer.from(JSON.stringify({ v: 1, q: normalizedQuery, p: last })).toString('base64url') };
          }
        }
      }
    }
  }
  return { results, nextCursor: null };
}
