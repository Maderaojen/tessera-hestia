import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSegment, ManagedSession, Turn } from '../src/types.js';

let dialogueRoot: string;
let dialogueStore: typeof import('../src/dialogue-store.js');

beforeEach(async () => {
  vi.resetModules();
  dialogueRoot = await mkdtemp(path.join(os.tmpdir(), 'dialogue-store-test-'));
  // dialogue-store.ts reads DIALOGUE_ROOT from config.js at import time, so
  // point it at a scratch dir for this test's fresh module import, the same
  // isolation trick registry.test.ts uses for HESTIA_STATE_DIR.
  vi.stubEnv('HESTIA_DIALOGUE_ROOT', dialogueRoot);
  dialogueStore = await import('../src/dialogue-store.js');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dialogueRoot, { recursive: true, force: true });
});

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1',
    tmuxName: 'hestia-sess-1',
    cwd: '/some/project',
    projectId: 'proj-1',
    alias: null,
    createdAt: '2026-01-01T00:00:00Z',
    provider: 'claude',
    providerSessionId: 'abc',
    providerSessionFile: null,
    providerLaunchedAt: null,
    status: 'ready',
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    lastError: null,
    pendingInteraction: null,
    turns: [],
    turnsSourceFile: null,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationSegment> = {}): ConversationSegment {
  return {
    id: 'conversation-1', sequence: 1, kind: 'cli', provider: 'claude', launchProfile: null,
    providerSessionId: 'abc', startedAt: '2026-01-01T00:00:00Z', endedAt: null,
    startReason: 'launch', endReason: null,
    transcript: { state: 'resolved', file: '/tmp/abc.jsonl', identity: 'pinned_id' },
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null,
    pendingInteraction: null, transcriptError: null, turns: [], ...overrides,
  };
}

describe('upsertTurn', () => {
  it('restricts a preexisting empty archive before appending secrets', async () => {
    const { chmod, mkdir, writeFile } = await import('node:fs/promises');
    const file = dialogueStore.dialogueFile(makeSession(), makeConversation());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '');
    await chmod(file, 0o644);
    await dialogueStore.upsertTurn(makeSession(), makeConversation(), { index: 1, user: { text: 'secret', at: null }, assistant: { text: '', at: null } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('appends a JSONL record under the owning conversation file', async () => {
    const session = makeSession();
    const turn: Turn = { index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'hello', at: 't2' } };
    await dialogueStore.upsertTurn(session, makeConversation(), turn);

    const host = os.hostname();
    const file = path.join(dialogueRoot, host, 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const raw = await readFile(file, 'utf-8');
    const record = JSON.parse(raw.trim());
    expect(record).toMatchObject({
      index: 1,
      user: { text: 'hi', at: 't1' },
      assistant: { text: 'hello', at: 't2' },
      sessionId: 'sess-1',
      conversationId: 'conversation-1',
      tmuxName: 'hestia-sess-1',
      cwd: '/some/project',
      provider: 'claude',
    });
  });

  it('appends multiple turns as separate lines, not overwriting', async () => {
    const session = makeSession();
    await dialogueStore.upsertTurn(session, makeConversation(), { index: 1, user: { text: 'a', at: null }, assistant: { text: 'b', at: null } });
    await dialogueStore.upsertTurn(session, makeConversation(), { index: 2, user: { text: 'c', at: null }, assistant: { text: 'd', at: null } });

    const host = os.hostname();
    const file = path.join(dialogueRoot, host, 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    const raw = await readFile(file, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('does not duplicate the same conversation turn when polling retries', async () => {
    const session = makeSession();
    const turn: Turn = { index: 1, user: { text: 'a', at: null }, assistant: { text: 'b', at: null } };
    await dialogueStore.upsertTurn(session, makeConversation(), turn);
    await dialogueStore.upsertTurn(session, makeConversation(), turn);

    const host = os.hostname();
    const file = path.join(dialogueRoot, host, 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    expect((await readFile(file, 'utf-8')).trim().split('\n')).toHaveLength(1);
  });

  it('replaces the record in place when the same turn comes back with a grown reply', async () => {
    const session = makeSession();
    await dialogueStore.upsertTurn(session, makeConversation(), { index: 1, user: { text: 'a', at: 't1' }, assistant: { text: 'short', at: 't2' } });
    await dialogueStore.upsertTurn(session, makeConversation(), { index: 2, user: { text: 'c', at: 't3' }, assistant: { text: 'd', at: 't4' } });
    await dialogueStore.upsertTurn(session, makeConversation(), { index: 1, user: { text: 'a', at: 't1' }, assistant: { text: 'short and then more', at: 't2' } });

    const host = os.hostname();
    const file = path.join(dialogueRoot, host, 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    const records = (await readFile(file, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line) as Turn);
    expect(records.map((record) => [record.index, record.assistant.text])).toEqual([[1, 'short and then more'], [2, 'd']]);
  });

  it('stamps each new row with the ids that identify it, and the transcript path only as a hint', async () => {
    const session = makeSession();
    const conversation = makeConversation({
      runtimeId: 'claude-code',
      launchProfile: { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', delegate: { kind: 'native', executable: 'claude' } },
    });
    await dialogueStore.upsertTurn(session, conversation, { index: 1, user: { text: 'a', at: null }, assistant: { text: 'b', at: null } });

    const file = path.join(dialogueRoot, os.hostname(), 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    expect(JSON.parse((await readFile(file, 'utf-8')).trim())).toMatchObject({
      archiveVersion: 2, host: os.hostname(), projectId: 'proj-1', providerSessionId: 'abc',
      runtimeId: 'claude-code', launchProfileId: 'native:claude', transcriptFile: '/tmp/abc.jsonl',
    });
  });

  it('writes nulls, not errors, for what an older or unbound conversation lacks', async () => {
    const conversation = makeConversation({ providerSessionId: null, launchProfile: null, transcript: { state: 'pending', file: null, identity: null } });
    await dialogueStore.upsertTurn(makeSession(), conversation, { index: 1, user: { text: 'a', at: null }, assistant: { text: 'b', at: null } });

    const file = path.join(dialogueRoot, os.hostname(), 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    expect(JSON.parse((await readFile(file, 'utf-8')).trim())).toMatchObject({
      archiveVersion: 2, providerSessionId: null, runtimeId: null, launchProfileId: null, transcriptFile: null,
    });
  });

  it('leaves older rows as they are in a file that now also holds new ones', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const file = path.join(dialogueRoot, os.hostname(), 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    const oldRow = JSON.stringify({
      index: 1, user: { text: 'a', at: 't1' }, assistant: { text: 'b', at: 't2' },
      sessionId: 'sess-1', conversationId: 'conversation-1', tmuxName: 'hestia-sess-1', cwd: '/some/project', provider: 'claude',
    });
    await writeFile(file, `${oldRow}
`);
    await dialogueStore.upsertTurn(makeSession(), makeConversation(), { index: 2, user: { text: 'c', at: 't3' }, assistant: { text: 'd', at: 't4' } });

    const lines = (await readFile(file, 'utf-8')).trim().split('\n');
    expect(lines[0]).toBe(oldRow);
    expect(JSON.parse(lines[1]!)).toMatchObject({ index: 2, archiveVersion: 2 });
  });

  it('uses immutable segment provider even if runtime provider has ended', async () => {
    const session = makeSession({ provider: null });
    await dialogueStore.upsertTurn(session, makeConversation(), { index: 1, user: { text: 'a', at: null }, assistant: { text: 'b', at: null } });

    const host = os.hostname();
    const file = path.join(dialogueRoot, host, 'claude', 'hestia-sess-1', 'conversation-1.jsonl');
    const raw = await readFile(file, 'utf-8');
    expect(JSON.parse(raw.trim()).provider).toBe('claude');
  });
});
