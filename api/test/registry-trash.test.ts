import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
}));

let stateDir: string;
let registry: typeof import('../src/registry.js');
let sessionStream: typeof import('../src/session-stream.js');
let types: typeof import('../src/types.js');
let dto: typeof import('../src/session-dto.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-registry-trash-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
  sessionStream = await import('../src/session-stream.js');
  types = await import('../src/types.js');
  dto = await import('../src/session-dto.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const writeDisk = async (records: unknown[]) => {
  const fs = await import('node:fs/promises');
  await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify(records), 'utf-8');
};

const claudeProfile = {
  id: 'native:claude', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'native' as const,
  home: '/private/claude', conversationRoot: '/private/claude/projects',
  delegate: { kind: 'native' as const, executable: 'claude' },
};

describe('isTrashed', () => {
  it('counts only a non-empty string', () => {
    expect(types.isTrashed({})).toBe(false);
    expect(types.isTrashed({ deletedAt: null })).toBe(false);
    expect(types.isTrashed({ deletedAt: '' })).toBe(false);
    expect(types.isTrashed({ deletedAt: 42 as unknown as string })).toBe(false);
    expect(types.isTrashed({ deletedAt: { at: 'x' } as unknown as string })).toBe(false);
    expect(types.isTrashed({ deletedAt: '2026-10-05T00:00:00Z' })).toBe(true);
  });
});

describe('the trash', () => {
  it('trashes a session as dead, with no pending claim, and hides it from every live reader', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    await registry.updateSession(session.id, {
      status: 'launching',
      startupPrompt: { kind: 'workspace_trust', detectedAt: '2026-01-01T00:00:00Z' },
      launchPending: { provider: 'claude', providerSessionId: null, providerLaunchedAt: 'x', previousStatus: 'idle', launchProfile: claudeProfile },
    });
    const trashed = await registry.trashSession(session.id, '2026-10-05T01:00:00Z');
    expect(trashed).toMatchObject({
      deletedAt: '2026-10-05T01:00:00Z', status: 'dead', launchPending: null, resumePending: null, clearPending: null, startupPrompt: null,
    });
    expect(await registry.getSession(session.id)).toBeUndefined();
    expect(await registry.getConversation(session.id, 'any')).toBeUndefined();
    expect(await registry.listSessions()).toEqual([]);
    expect((await registry.getSessionRecord(session.id))?.deletedAt).toBe('2026-10-05T01:00:00Z');
    expect((await registry.listAllSessions()).map((s) => s.id)).toEqual([session.id]);
  });

  it('is idempotent: trashing again keeps the first deletion time', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    await registry.trashSession(session.id, '2026-10-05T01:00:00Z');
    const again = await registry.trashSession(session.id, '2026-10-06T01:00:00Z');
    expect(again?.deletedAt).toBe('2026-10-05T01:00:00Z');
    expect(await registry.trashSession('missing')).toBeUndefined();
  });

  it('survives a reload', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    await registry.trashSession(session.id, '2026-10-05T01:00:00Z');
    registry.__resetForTests();
    expect(await registry.listSessions()).toEqual([]);
    expect((await registry.listTrashedSessions())[0]?.deletedAt).toBe('2026-10-05T01:00:00Z');
  });

  it('restores a trashed session as dead; refuses one not in the trash', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    expect(await registry.restoreSession(session.id)).toBeNull();
    expect(await registry.restoreSession('missing')).toBeUndefined();
    await registry.trashSession(session.id);
    const restored = await registry.restoreSession(session.id);
    expect(restored).toMatchObject({ deletedAt: null, status: 'dead', launchPending: null, resumePending: null, clearPending: null });
    expect((await registry.getSession(session.id))?.id).toBe(session.id);
    expect(await registry.listTrashedSessions()).toEqual([]);
  });

  it('purges only a trashed record', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    expect(await registry.purgeSession(session.id)).toBeNull();
    expect(await registry.purgeSession('missing')).toBeUndefined();
    await registry.trashSession(session.id);
    expect((await registry.purgeSession(session.id))?.id).toBe(session.id);
    expect(await registry.getSessionRecord(session.id)).toBeUndefined();
  });

  it('publishes a trashed write, even a late one, as deleted; the restore as restored, then updates again', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    const events: Array<{ id: string; type: string }> = [];
    const stop = sessionStream.observeAll((id, event) => events.push({ id, type: event.type }));
    await registry.trashSession(session.id);
    // A transition that was in flight when the session was deleted.
    await registry.updateSession(session.id, { lastError: 'late' });
    await registry.restoreSession(session.id);
    await registry.updateSession(session.id, { alias: 'back' });
    stop();
    expect(events).toEqual([
      { id: session.id, type: 'deleted' },
      { id: session.id, type: 'deleted' },
      { id: session.id, type: 'restored' },
      { id: session.id, type: 'update' },
    ]);
  });

  it('is skipped by the dead-tmux reconcile', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    await registry.trashSession(session.id);
    expect(await registry.markDeadUnlessRunning(new Set())).toEqual([]);
  });

  it('refuses every transition claim on a trashed record', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    await registry.updateSession(session.id, { status: 'idle' });
    await registry.trashSession(session.id);
    // Force a shape each claim would otherwise accept, still trashed.
    await registry.updateSession(session.id, { status: 'idle' });
    expect(await registry.beginPendingLaunch(session.id, {
      provider: 'claude', providerSessionId: null, providerLaunchedAt: 't', previousStatus: 'idle', launchProfile: claudeProfile,
    })).toBeUndefined();
    expect(await registry.beginPendingResume(session.id, { attemptId: 'a', conversationId: 'c', startedAt: 't' })).toBeUndefined();
    const attempt = {
      attemptId: 'a', conversationId: null, newProviderSessionId: null, launchArgv: [], startedAt: 't',
      previousStatus: 'idle' as const, phase: 'waiting_exit' as const, launchStartedAt: null,
    };
    expect(await registry.beginPendingClear(session.id, attempt)).toBeUndefined();
    expect(await registry.beginConversationSwitch(session.id, { ...attempt, targetConversationId: 'c' })).toBeUndefined();
    expect(registry.ownsLaunchAttemptLocally(session.id, 't')).toBe(false);
  });
});

describe('old and odd records', () => {
  const base = (id: string, extra: Record<string, unknown>) => ({
    schemaVersion: 4, id, tmuxName: `hestia-${id}`, cwd: '/some/project', projectId: 'proj-1', alias: null,
    createdAt: '2026-01-01T00:00:00Z', provider: null, providerSessionId: null, providerSessionFile: null,
    providerLaunchedAt: null, status: 'dead', turnPhase: 'idle', lastUserMessageAt: null, lastUserMessageText: null,
    deliveryUnconfirmedText: null, lastError: null, pendingInteraction: null, turns: [], turnsSourceFile: null,
    ...extra,
  });

  it('loads, lists, trashes, restores and describes records of any age without throwing', async () => {
    const legacySegment = {
      id: 'legacy-seg', sequence: 1, kind: 'cli', provider: null, runtimeId: null, launchProfile: null, providerSessionId: null,
      startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'legacy_migration', endReason: null,
      transcript: { state: 'legacy_unverified', identity: null, file: null }, lastUserMessageAt: null, lastUserMessageText: null,
      deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null,
      turns: [{ index: 0, user: { text: 'hi', at: '2026-01-01T00:00:00Z' }, assistant: { text: '', at: null } }],
    };
    await writeDisk([
      base('no-deleted-at', {}),
      base('garbage-deleted-at', { deletedAt: 17 }),
      base('empty-deleted-at', { deletedAt: '' }),
      base('no-conversations-no-number', { sessionNumber: undefined }),
      base('legacy-segment', { conversations: [legacySegment], activeConversationId: null }),
      base('trashed-legacy', { conversations: [legacySegment], deletedAt: '2026-10-01T00:00:00Z' }),
    ]);
    const live = await registry.listSessions();
    expect(live.map((s) => s.id).sort()).toEqual(['empty-deleted-at', 'garbage-deleted-at', 'legacy-segment', 'no-conversations-no-number', 'no-deleted-at']);
    for (const session of live) {
      expect(() => dto.toPublicManagedSession(session)).not.toThrow();
      expect(() => dto.toTrashedSessionDto(session)).not.toThrow();
    }
    // A garbage value is not "in the trash": it can't be restored, but can be deleted.
    expect(await registry.restoreSession('garbage-deleted-at')).toBeNull();
    for (const session of live) await registry.trashSession(session.id);
    const trashed = await registry.listTrashedSessions();
    expect(trashed).toHaveLength(6);
    const dtos = trashed.map(dto.toTrashedSessionDto);
    expect(dtos.find((dto) => dto.id === 'legacy-segment')?.lastMessage).toEqual({ role: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' });
    expect(dtos.find((dto) => dto.id === 'no-conversations-no-number')).toMatchObject({ lastMessage: null, sessionNumber: 1, conversations: [] });
    for (const session of trashed) expect((await registry.restoreSession(session.id))?.deletedAt).toBeNull();
    expect(await registry.listSessions()).toHaveLength(6);
  });
});

describe('toTrashedSessionDto', () => {
  const turn = (user: string, assistant: string, at = '2026-01-01T00:00:00Z') => ({ index: 0, user: { text: user, at }, assistant: { text: assistant, at } });
  const segment = (id: string, sequence: number, turns: unknown[]) => ({
    id, sequence, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: claudeProfile, providerSessionId: 'p',
    startedAt: 't', endedAt: null, startReason: 'launch', endReason: null,
    transcript: { state: 'resolved', identity: 'pinned_id', file: '/private/claude/projects/x/p.jsonl' },
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns,
  });

  it('takes the active conversation\'s last reply, falls back to the latest one with turns, and cuts it to 200 characters', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    const long = '字'.repeat(250);
    const record = {
      ...session, deletedAt: '2026-10-05T00:00:00Z', activeConversationId: 'b',
      conversations: [segment('a', 1, [turn('q', long)]), segment('b', 2, [])],
    } as unknown as import('../src/types.js').ManagedSession;
    const trashedDto = dto.toTrashedSessionDto(record);
    expect(trashedDto.lastMessage).toEqual({ role: 'assistant', text: '字'.repeat(200), at: '2026-01-01T00:00:00Z' });
    expect(trashedDto.deletedAt).toBe('2026-10-05T00:00:00Z');
    expect(JSON.stringify(trashedDto)).not.toContain('/private/claude');
    expect(trashedDto).not.toHaveProperty('turns');

    const active = dto.toTrashedSessionDto({ ...record, conversations: [segment('a', 1, [turn('q', 'old')]), segment('b', 2, [turn('q2', 'new')])] } as never);
    expect(active.lastMessage?.text).toBe('new');
    expect(dto.toTrashedSessionDto({ ...record, conversations: undefined } as never).lastMessage).toBeNull();
    expect(dto.toTrashedSessionDto({ ...record, conversations: [segment('b', 2, [turn('', '  ')])] } as never).lastMessage).toBeNull();
  });
});
