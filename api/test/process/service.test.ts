import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { clearProcessCache } from '../../src/process/cache.js';
import { BRIEF_TURNS, withTurnProcess } from '../../src/process/service.js';
import { type ConversationSegment, type ManagedSession, type Turn } from '../../src/types.js';
import { toPublicConversation } from '../../src/session-dto.js';

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 12, 3, 0, n++)).toISOString();
const user = (text: string) => ({ type: 'user', uuid: `u${n}`, timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const text = (value: string) => ({ type: 'assistant', uuid: `a${n}`, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: value }] } });
const tool = (id: string) => ({ type: 'assistant', uuid: `t${n}`, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
const result = (id: string) => ({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const end = () => ({ type: 'system', subtype: 'turn_duration', timestamp: at() });

function exchange(i: number): unknown[] {
  return [user(`問題 ${i}`), text(`查一下 ${i}。`), tool(`toolu_${i}`), result(`toolu_${i}`), text(`答案 ${i}。`), end()];
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-process-service-'));
  file = path.join(dir, 'conversation.jsonl');
  clearProcessCache();
  n = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(records: unknown[]): Promise<Turn[]> {
  await writeFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  return claudeAdapter.parseTurns(file);
}

function fixture(turns: Turn[], overrides: Partial<ConversationSegment> = {}, sessionOverrides: Partial<ManagedSession> = {}) {
  const conversation = {
    id: 'conv-1', provider: 'claude', providerSessionId: null, startedAt: '2026-10-12T00:00:00.000Z',
    transcript: { state: 'resolved', file, identity: 'pinned_id' }, turns, launchProfile: null,
    ...overrides,
  } as unknown as ConversationSegment;
  const session = {
    id: 'session-1', cwd: dir, status: 'ready', turnPhase: 'idle', activeConversationId: 'conv-1', provider: 'claude',
    conversations: [conversation], ...sessionOverrides,
  } as unknown as ManagedSession;
  return { session, conversation };
}

async function detailOf(session: ManagedSession, conversation: ConversationSegment) {
  // The real serializer, so the detail is exactly what the route sends.
  return withTurnProcess(session, conversation, toPublicConversation({ ...conversation, sequence: 1, kind: 'cli', endedAt: null, startReason: 'launch', endReason: null, lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null } as ConversationSegment));
}

describe('withTurnProcess', () => {
  it('adds parts that join to each stored text', async () => {
    const turns = await write([...exchange(1), ...exchange(2)]);
    const { session, conversation } = fixture(turns);
    const detail = await detailOf(session, conversation);
    expect(detail.turns.map((turn) => turn.process)).toEqual([1, 2].map((i) => ({
      status: 'available', open: false,
      parts: [{ kind: 'progress', text: `查一下 ${i}。`, at: expect.any(String) }, { kind: 'reply', text: `答案 ${i}。`, at: expect.any(String) }],
      counts: expect.objectContaining({ run: 1 }),
    })));
  });

  it('checks every turn on its own: a stored turn that reads differently gets none', async () => {
    const turns = await write([...exchange(1), ...exchange(2), ...exchange(3)]);
    // As an older parser might have stored them: one reply text differs,
    // one user message has no time.
    const stored = [
      turns[0]!,
      { ...turns[1]!, assistant: { ...turns[1]!.assistant, text: '答案 2。' } },
      { ...turns[2]!, user: { ...turns[2]!.user, at: null } },
    ];
    const { session, conversation } = fixture(stored);
    const detail = await detailOf(session, conversation);
    expect(detail.turns.map((turn) => turn.process?.status)).toEqual(['available', 'unavailable', 'unmatched']);
    // The stored text itself is what is sent, untouched.
    expect(detail.turns[1]!.assistant.text).toBe('答案 2。');
  });

  it('cuts the parts of a turn still being written to what is stored so far', async () => {
    const records = [...exchange(1), user('問題 2'), text('先看。'), tool('toolu_x'), result('toolu_x'), text('還在寫的回覆')];
    const turns = await write(records);
    const stored = [turns[0]!, { ...turns[1]!, assistant: { ...turns[1]!.assistant, text: '先看。' } }];
    const { session, conversation } = fixture(stored, {}, { turnPhase: 'replying' });
    const detail = await detailOf(session, conversation);
    expect(detail.turns[1]!.process).toEqual({ status: 'available', open: true, parts: [{ kind: 'progress', text: '先看。', at: expect.any(String) }], counts: expect.any(Object) });
    // Not open (idle): the same mismatch is just unavailable.
    const idle = fixture(stored);
    expect((await detailOf(idle.session, idle.conversation)).turns[1]!.process).toEqual({ status: 'unavailable' });
  });

  it('says the transcript is gone, and leaves the turns as they are', async () => {
    const turns = await write(exchange(1));
    await rm(file);
    const { session, conversation } = fixture(turns);
    const detail = await detailOf(session, conversation);
    expect(detail.turns[0]!.process).toEqual({ status: 'transcript_missing' });
    expect(detail.turns[0]!.assistant.text).toBe(turns[0]!.assistant.text);
  });

  it('has none for a CLI it does not read, or a conversation with no bound transcript', async () => {
    const turns = await write(exchange(1));
    const agy = fixture(turns, { provider: 'gemini' } as Partial<ConversationSegment>);
    expect((await detailOf(agy.session, agy.conversation)).turns[0]!.process).toEqual({ status: 'unsupported' });
    const legacy = fixture(turns, { transcript: { state: 'legacy_unverified', file: null, identity: null } } as Partial<ConversationSegment>);
    expect((await detailOf(legacy.session, legacy.conversation)).turns[0]!.process).toEqual({ status: 'unavailable' });
  });

  it('only gives the latest turns a brief', async () => {
    const turns = await write(Array.from({ length: BRIEF_TURNS + 2 }, (_, i) => exchange(i)).flat());
    const { session, conversation } = fixture(turns);
    const detail = await detailOf(session, conversation);
    expect(detail.turns.filter((turn) => turn.process).length).toBe(BRIEF_TURNS);
    expect(detail.turns[0]!.process).toBeUndefined();
    expect(detail.turns.at(-1)!.process?.status).toBe('available');
  });
});
