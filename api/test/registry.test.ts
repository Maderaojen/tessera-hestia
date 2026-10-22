import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
}));

// Wraps (not replaces) the real writeFile: every test but the write-ordering
// one below gets normal filesystem behavior for free. vi.spyOn can't target
// a node:fs/promises export directly (its module namespace isn't
// configurable under ESM), so this is the supported way to get an
// overridable reference to it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

let stateDir: string;
let registry: typeof import('../src/registry.js');

// config.ts reads HESTIA_STATE_DIR once at module-load time, so each
// test gets true isolation only by resetting the module registry and
// re-importing with a fresh temp dir and env var already in place.
beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-registry-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('registry', () => {
  it('binds an observed ID only to the same active, unbound runtime segment', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null,
      providerLaunchedAt: '2026-01-01T00:00:00Z',
      launchProfile: {
        id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native',
        home: '/private/codex', conversationRoot: '/private/codex/sessions',
        delegate: { kind: 'native', executable: 'codex' },
      },
    });
    const conversationId = launched!.activeConversationId!;
    const id = 'a13782f4-715f-4abc-9233-2207319a1234';

    expect(await registry.bindObservedSessionId(session.id, conversationId, 'agy', id)).toBeUndefined();
    expect(await registry.bindObservedSessionId(session.id, 'stale-segment', 'codex-cli', id)).toBeUndefined();
    expect(await registry.bindObservedSessionId(session.id, conversationId, 'codex-cli', 'bad-id')).toBeUndefined();
    const bound = await registry.bindObservedSessionId(session.id, conversationId, 'codex-cli', id);
    expect(bound?.providerSessionId).toBe(id);
    expect(bound?.conversations?.[0]?.providerSessionId).toBe(id);
    expect(await registry.bindObservedSessionId(session.id, conversationId, 'codex-cli', 'b13782f4-715f-4abc-9233-2207319a1234')).toBeUndefined();
  });

  it('starts a branch line\'s forked launch as a fork conversation whose offset waits for its transcript', async () => {
    const session = await registry.createSession('/some/project-fork-ab12', 'proj-1');
    const launchProfile = {
      id: 'native:claude', provider: 'claude' as const, runtimeId: 'claude-code' as const, source: 'native' as const,
      home: '/private/claude', conversationRoot: '/private/claude/projects', delegate: { kind: 'native' as const, executable: 'claude' },
    };
    await registry.beginPendingLaunch(session.id, {
      provider: 'claude', runtimeId: 'claude-code', providerSessionId: 'b13782f4-715f-4abc-9233-2207319a1234',
      providerLaunchedAt: '2026-01-01T00:00:00Z', previousStatus: 'ready', launchProfile,
      fork: { fromSessionId: 'main', fromConversationId: 'main-c1' },
    });
    registry.releaseLaunchAttempt(session.id, '2026-01-01T00:00:00Z');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', runtimeId: 'claude-code', providerSessionId: 'b13782f4-715f-4abc-9233-2207319a1234',
      providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile,
    }, '2026-01-01T00:00:00Z');
    expect(launched?.conversations?.[0]).toMatchObject({ startReason: 'fork', transcriptTurnOffset: null });
    // An ordinary launch still starts at 0.
    const plain = await registry.createSession('/some/project', 'proj-1');
    const fresh = await registry.commitConversationLaunch(plain.id, {
      provider: 'claude', runtimeId: 'claude-code', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile,
    });
    expect(fresh?.conversations?.[0]).toMatchObject({ startReason: 'launch', transcriptTurnOffset: 0 });
  });

  it('never binds an observed ID to a runtime whose ID is pinned at launch', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', runtimeId: 'claude-code', providerSessionId: null,
      providerLaunchedAt: '2026-01-01T00:00:00Z',
      launchProfile: {
        id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native',
        home: '/private/claude', conversationRoot: '/private/claude/projects',
        delegate: { kind: 'native', executable: 'claude' },
      },
    });
    const conversationId = launched!.activeConversationId!;
    expect(await registry.bindObservedSessionId(session.id, conversationId, 'claude-code', 'a13782f4-715f-4abc-9233-2207319a1234')).toBeUndefined();
    expect((await registry.getSession(session.id))?.providerSessionId).toBeNull();
  });

  it("creates a session named with this install's tmux prefix and persists it", async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    // A temp state dir is a fresh (non-legacy) install.
    expect(session.tmuxName).toBe(`hestia-${session.id}`);
    expect(session.status).toBe('idle');
    expect(session.projectId).toBe('proj-1');

    const fetched = await registry.getSession(session.id);
    expect(fetched).toEqual(session);
  });

  it('updateSession merges a partial patch', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const updated = await registry.updateSession(session.id, { status: 'ready', provider: 'claude' });
    expect(updated?.status).toBe('ready');
    expect(updated?.provider).toBe('claude');
    expect(updated?.cwd).toBe('/some/project');
  });

  it('trashSession drops it from the list but keeps the record in the trash', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    await registry.trashSession(session.id);
    expect(await registry.getSession(session.id)).toBeUndefined();
    expect(await registry.listSessions()).toEqual([]);
    expect((await registry.listTrashedSessions()).map((s) => s.id)).toEqual([session.id]);
  });

  it('trashSession does not call notesStore.deleteSessionNotes (notes are project-scoped now)', async () => {
    const deleteSessionNotes = vi.fn(async () => {});
    vi.doMock('../src/notes-store.js', () => ({
      migrateLegacySessionNotes: vi.fn(async () => {}),
      deleteSessionNotes,
      __resetForTests: vi.fn(async () => {}),
    }));
    vi.resetModules();
    const freshRegistry = await import('../src/registry.js');
    const session = await freshRegistry.createSession('/some/project', 'proj-1');
    await freshRegistry.trashSession(session.id);
    expect(deleteSessionNotes).not.toHaveBeenCalled();
  });

  it('marks a session dead once its tmux is not among the running ones', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    await registry.markDeadUnlessRunning(new Set());
    const after = await registry.getSession(session.id);
    expect(after?.status).toBe('dead');
  });

  it('leaves a session whose tmux is still running alone', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    await registry.markDeadUnlessRunning(new Set([session.tmuxName]));
    const after = await registry.getSession(session.id);
    expect(after?.status).toBe('idle');
  });

  it('never starts a second persist() write before the first one has finished', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');

    // Racing the real filesystem to prove ordering would be flaky (whichever
    // write happens to finish last wins, regardless of which was queued
    // first) — asserting directly on when each write is *attempted* is
    // deterministic and is exactly the invariant the queue in
    // registry.ts's persist() is there to guarantee: a second write must
    // never even start until the first one currently in flight is done.
    const fs = await import('node:fs/promises');
    const writeSpy = vi.mocked(fs.writeFile);
    const actualWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    const order: string[] = [];
    let releaseFirstWrite: () => void = () => {};
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    writeSpy.mockImplementationOnce(async (...args: Parameters<typeof actualWriteFile>) => {
      order.push('first-start');
      await firstWriteGate;
      order.push('first-end');
      return actualWriteFile(...args);
    });
    writeSpy.mockImplementationOnce(async (...args: Parameters<typeof actualWriteFile>) => {
      order.push('second-start');
      return actualWriteFile(...args);
    });

    const first = registry.updateSession(session.id, { status: 'ready', turnPhase: 'idle' });
    await vi.waitFor(() => {
      if (!order.includes('first-start')) throw new Error('first write not reached yet');
    });
    const second = registry.updateSession(session.id, { status: 'ready', turnPhase: 'replying' });
    // Give second's write a real chance to jump the queue, if it were going
    // to — a short real delay, not another microtask-only wait, since this
    // needs to rule out a late macrotask-scheduled attempt too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-start']); // second must still be waiting, not already attempting its write

    releaseFirstWrite();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);

    const raw = await fs.readFile(path.join(stateDir, 'registry.json'), 'utf-8');
    const onDisk = JSON.parse(raw) as Array<{ status: string; turnPhase: string }>;
    expect(onDisk[0]).toMatchObject({ status: 'ready', turnPhase: 'replying' });
  });

  it('backfills turnsSourceFile from providerSessionFile for registry.json written before that field existed', async () => {
    const fs = await import('node:fs/promises');
    const preMigration = {
      id: 'sess-1',
      tmuxName: 'hestia-sess-1',
      cwd: '/some/project',
      alias: null,
      createdAt: '2026-01-01T00:00:00Z',
      provider: 'claude',
      providerSessionId: 'prov-1',
      providerSessionFile: '/home/dev/.claude/projects/-some/prov-1.jsonl',
      providerLaunchedAt: '2026-01-01T00:00:00Z',
      status: 'ready',
      lastUserMessageAt: null,
      lastUserMessageText: null,
      deliveryUnconfirmedText: null,
      lastError: null,
      pendingInteraction: null,
      turns: [{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'hello', at: 't2' } }],
      // turnsSourceFile deliberately absent — this is the point of the test.
    };
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([preMigration]), 'utf-8');

    const session = await registry.getSession('sess-1');
    expect(session?.turnsSourceFile).toBe('/home/dev/.claude/projects/-some/prov-1.jsonl');
  });

  it('migrates a persisted Claude clear claim to generic clearPending once and removes the old key', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = {
      attemptId: 'legacy-clear', conversationId: 'old-conversation', newProviderSessionId: 'new-id',
      launchArgv: ['claude', '--session-id', 'new-id'], startedAt: '2026-01-02T00:00:00Z',
      previousStatus: 'ready', phase: 'launching', launchStartedAt: '2026-01-02T00:00:01Z',
      delivery: 'launch_uncertain',
    };
    const legacy = { ...session, status: 'launching', claudeClearPending: attempt };
    delete (legacy as Partial<typeof legacy>).clearPending;
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([legacy]), 'utf-8');

    registry.__resetForTests();
    const migrated = await registry.getSession(session.id);
    expect(migrated?.clearPending).toMatchObject({ ...attempt, operation: 'clear', provider: 'claude', runtimeId: 'claude-code',
      newConversationId: `${session.id}:clear:legacy-clear`,
    });
    expect(migrated).not.toHaveProperty('claudeClearPending');
    const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, 'registry.json'), 'utf-8')) as Array<Record<string, unknown>>;
    expect(onDisk[0]).not.toHaveProperty('claudeClearPending');
    expect(onDisk[0]?.clearPending).toMatchObject({ attemptId: 'legacy-clear', delivery: 'launch_uncertain' });
    registry.__resetForTests();
    expect((await registry.getSession(session.id))?.clearPending).toEqual(migrated?.clearPending);
  });

  it('keeps a legacy conversation switch distinct from a clear operation', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = {
      attemptId: 'legacy-switch', conversationId: 'old-conversation', targetConversationId: 'target',
      newProviderSessionId: 'existing-id', launchArgv: ['claude', '--resume', 'existing-id'],
      startedAt: '2026-01-02T00:00:00Z', previousStatus: 'ready', phase: 'awaiting_force', launchStartedAt: null,
    };
    const legacy = { ...session, status: 'launching', claudeClearPending: attempt };
    delete (legacy as Partial<typeof legacy>).clearPending;
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([legacy]), 'utf-8');
    registry.__resetForTests();
    const migrated = await registry.getSession(session.id);
    expect(migrated?.clearPending).toMatchObject({ operation: 'conversation_switch', targetConversationId: 'target' });
    const { toPublicManagedSession } = await import('../src/session-dto.js');
    expect(toPublicManagedSession(migrated!).clearPending).toBeNull();
    expect(toPublicManagedSession(migrated!).conversationSwitch).toEqual({ targetConversationId: 'target', phase: 'awaiting_force' });
  });

  it('rejects any two active pending fields, even with the same attempt ID', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const claim = { attemptId: 'same', conversationId: 'old', newProviderSessionId: 'new',
      launchArgv: ['claude'], startedAt: '2026-01-02T00:00:00Z', previousStatus: 'ready',
      phase: 'waiting_exit', launchStartedAt: null };
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([{
      ...session, clearPending: { ...claim, operation: 'clear' },
      claudeClearPending: { ...claim, phase: 'launching', launchArgv: ['different'] },
    }]), 'utf-8');
    registry.__resetForTests();
    await expect(registry.getSession(session.id)).rejects.toThrow('Conflicting pending clear claims');
  });

  it('rejects an explicit operation that disagrees with the switch target', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const claim = { attemptId: 'claim', conversationId: 'old', newProviderSessionId: 'new',
      launchArgv: ['claude'], startedAt: '2026-01-02T00:00:00Z', previousStatus: 'ready',
      phase: 'waiting_exit', launchStartedAt: null };
    for (const conflict of [
      { operation: 'clear', targetConversationId: 'target' },
      { operation: 'conversation_switch' },
    ]) {
      await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([{
        ...session, clearPending: { ...claim, ...conflict },
      }]), 'utf-8');
      registry.__resetForTests();
      await expect(registry.getSession(session.id)).rejects.toThrow('Conflicting pending clear operation');
    }
  });

  it('preserves the provider and runtime recorded on an old pending claim', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const legacy = { ...session, claudeClearPending: {
      attemptId: 'agy-clear', conversationId: 'old', provider: 'gemini', runtimeId: 'agy',
      newProviderSessionId: null, launchArgv: ['agy'], startedAt: '2026-01-02T00:00:00Z',
      previousStatus: 'ready', phase: 'waiting_exit', launchStartedAt: null,
    } };
    delete (legacy as Partial<typeof legacy>).clearPending;
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([legacy]), 'utf-8');
    registry.__resetForTests();
    expect((await registry.getSession(session.id))?.clearPending).toMatchObject({ provider: 'gemini', runtimeId: 'agy' });
  });

  it('does not expose a migrated claim when atomic replacement fails', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const legacy = { ...session, claudeClearPending: {
      attemptId: 'old', conversationId: 'old', newProviderSessionId: 'new', launchArgv: ['claude'],
      startedAt: '2026-01-02T00:00:00Z', previousStatus: 'ready', phase: 'waiting_exit', launchStartedAt: null,
    } };
    delete (legacy as Partial<typeof legacy>).clearPending;
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([legacy]), 'utf-8');
    registry.__resetForTests();
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('missing target'), { code: 'ENOENT' }));
    await expect(registry.getSession(session.id)).rejects.toThrow('missing target');
    expect(JSON.parse(await fs.readFile(path.join(stateDir, 'registry.json'), 'utf-8'))[0]).toHaveProperty('claudeClearPending');
    expect((await registry.getSession(session.id))?.clearPending?.attemptId).toBe('old');
  });

  it('persists a native launch snapshot when migrating an already-project-scoped legacy session', async () => {
    const fs = await import('node:fs/promises');
    const oldSession = {
      id: 'sess-profile-migration', tmuxName: 'hestia-sess-profile-migration', cwd: '/some/project', projectId: 'proj-1',
      alias: null, createdAt: '2026-01-01T00:00:00Z', provider: 'codex', providerSessionId: null,
      providerSessionFile: null, providerLaunchedAt: '2026-01-01T00:00:00Z', status: 'ready', lastUserMessageAt: null,
      lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null, pendingInteraction: null, turns: [], turnsSourceFile: null,
    };
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([oldSession]), 'utf-8');

    const session = await registry.getSession(oldSession.id);
    expect(session?.launchProfile?.id).toBe('native:codex');
    const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, 'registry.json'), 'utf-8')) as Array<{ launchProfile?: { id: string } }>;
    expect(onDisk[0]?.launchProfile?.id).toBe('native:codex');
  });

  it('migrates legacy flat turns into one stable unverified conversation without losing turns', async () => {
    const fs = await import('node:fs/promises');
    const oldSession = {
      id: 'sess-conversation-migration', tmuxName: 'hestia-sess-conversation-migration', cwd: '/some/project', projectId: 'proj-1',
      alias: null, createdAt: '2026-01-01T00:00:00Z', provider: 'codex', providerSessionId: null,
      providerSessionFile: '/private/codex/transcript.jsonl', providerLaunchedAt: '2026-01-01T00:00:00Z', status: 'ready',
      lastUserMessageAt: '2026-01-01T00:01:00Z', lastUserMessageText: 'hi', deliveryUnconfirmedText: null,
      lastError: null, pendingInteraction: null,
      turns: [{ index: 4, user: { text: 'old', at: 'u' }, assistant: { text: 'history', at: 'a' } }],
      turnsSourceFile: '/private/codex/transcript.jsonl',
    };
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([oldSession]), 'utf-8');

    const first = await registry.getSession(oldSession.id);
    expect(first?.conversations).toHaveLength(1);
    expect(first?.conversations?.[0]).toMatchObject({
      id: 'sess-conversation-migration:legacy', sequence: 1,
      startReason: 'legacy_migration', provider: null, launchProfile: null, providerSessionId: null,
      transcript: { state: 'legacy_unverified', identity: null, file: null },
      turns: oldSession.turns,
    });
    expect(first?.activeConversationId).toBeNull();

    registry.__resetForTests();
    const reloaded = await registry.getSession(oldSession.id);
    expect(reloaded?.conversations).toHaveLength(1);
    expect(reloaded?.conversations?.[0]?.id).toBe('sess-conversation-migration:legacy');
    expect(reloaded?.conversations?.[0]?.turns).toEqual(oldSession.turns);
  });

  it('commits a new conversation atomically while preserving and closing the previous segment', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const first = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: 'claude-id-1', providerLaunchedAt: '2026-01-01T00:01:00Z',
      launchProfile: { id: 'native:claude', provider: 'claude', source: 'native', delegate: { kind: 'native', executable: 'claude' } },
    });
    expect(first?.conversations).toHaveLength(1);
    const firstId = first?.activeConversationId as string;
    await registry.updateConversation(session.id, firstId, { turns: [{ index: 1, user: { text: 'old', at: 'u' }, assistant: { text: 'reply', at: 'a' } }] });

    const second = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:02:00Z',
      launchProfile: { id: 'native:codex', provider: 'codex', source: 'native', delegate: { kind: 'native', executable: 'codex' } },
    });

    expect(second?.conversations).toHaveLength(2);
    expect(second?.activeConversationId).not.toBe(firstId);
    expect(second?.conversations?.[0]).toMatchObject({ endReason: 'provider_switch', turns: [{ index: 1 }] });
    expect(second?.conversations?.[1]).toMatchObject({ provider: 'codex', startReason: 'provider_switch', transcript: { state: 'pending', file: null, identity: null }, turns: [] });
    expect(second?.provider).toBe('codex');
    expect(second?.lastUserMessageAt).toBeNull();
  });

  it('ends only the active conversation on confirmed CLI exit and retains its turns', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const started = await registry.commitConversationLaunch(session.id, {
      provider: 'gemini', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:01:00Z', launchProfile: null,
    });
    const activeId = started?.activeConversationId as string;
    const turn = { index: 1, user: { text: 'hi', at: 'u' }, assistant: { text: 'hello', at: 'a' } };
    await registry.updateConversation(session.id, activeId, { turns: [turn] });

    const ended = await registry.endActiveConversation(session.id, 'cli_exit');

    expect(ended?.activeConversationId).toBeNull();
    expect(ended?.provider).toBeNull();
    expect(ended?.conversations?.[0]).toMatchObject({ endReason: 'cli_exit', turns: [turn] });
  });

  it('rolls back a dead pending launch without changing the prior provider, profile, conversation, or turns', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const active = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: 'old-id', providerLaunchedAt: '2026-01-01T00:00:00Z',
      launchProfile: { id: 'native:claude', provider: 'claude', source: 'native', home: '/old/home', delegate: { kind: 'native', executable: 'claude' } },
    });
    const oldId = active?.activeConversationId as string;
    const turn = { index: 1, user: { text: 'keep', at: 'u' }, assistant: { text: 'history', at: 'a' } };
    await registry.updateConversation(session.id, oldId, { turns: [turn] });
    await registry.updateSession(session.id, {
      status: 'launching',
      launchPending: {
        provider: 'codex', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:01:00Z',
        previousStatus: 'ready', launchProfile: { id: 'native:codex', provider: 'codex', source: 'native', home: '/new/home', delegate: { kind: 'native', executable: 'codex' } },
      },
    });

    const rolledBack = await registry.rollbackPendingLaunch(session.id, 'safe launch error');

    expect(rolledBack).toMatchObject({ status: 'ready', provider: 'claude', activeConversationId: oldId, launchPending: null, lastError: 'safe launch error', launchProfile: { id: 'native:claude' } });
    expect(rolledBack?.conversations?.find((conversation) => conversation.id === oldId)?.turns).toEqual([turn]);
  });

  it('atomically grants only one concurrent pending launch claim and persists it across reload', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = {
      provider: 'codex' as const, providerSessionId: null, providerLaunchedAt: '2026-01-01T00:00:00Z',
      previousStatus: 'idle' as const, launchProfile: { id: 'native:codex', provider: 'codex' as const, source: 'native' as const, home: '/private/codex', delegate: { kind: 'native' as const, executable: 'codex' } },
    };

    const claims = await Promise.all([
      registry.beginPendingLaunch(session.id, attempt),
      registry.beginPendingLaunch(session.id, attempt),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    registry.__resetForTests();
    const restored = await registry.getSession(session.id);
    expect(restored).toMatchObject({ status: 'launching', provider: null, activeConversationId: null, launchPending: attempt, conversations: [] });
  });

  it('commits a pending launch at most once when the route and restart poller both resolve alive', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = {
      provider: 'codex' as const, providerSessionId: null, providerLaunchedAt: '2026-01-01T00:00:00Z',
      previousStatus: 'idle' as const, launchProfile: { id: 'native:codex', provider: 'codex' as const, source: 'native' as const, delegate: { kind: 'native' as const, executable: 'codex' } },
    };
    await registry.beginPendingLaunch(session.id, attempt);
    const input = { provider: attempt.provider, providerSessionId: attempt.providerSessionId, providerLaunchedAt: attempt.providerLaunchedAt, launchProfile: attempt.launchProfile };

    const committed = await Promise.all([
      registry.commitConversationLaunch(session.id, input, attempt.providerLaunchedAt),
      registry.commitConversationLaunch(session.id, input, attempt.providerLaunchedAt),
    ]);

    expect(committed[0]?.activeConversationId).toBe(committed[1]?.activeConversationId);
    expect((await registry.getSession(session.id))?.conversations).toHaveLength(1);
  });

  it('reserves and commits Claude recovery without changing the conversation or its turns', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234', providerLaunchedAt: '2026-01-01T00:00:00Z',
      launchProfile: { id: 'native:claude', provider: 'claude', source: 'native', home: '/saved/home', conversationRoot: '/saved/home/projects', delegate: { kind: 'native', executable: 'claude' } },
    });
    const conversationId = launched?.activeConversationId as string;
    const turn = { index: 1, user: { text: 'hi', at: 'u' }, assistant: { text: 'hello', at: 'a' } };
    await registry.updateConversation(session.id, conversationId, {
      transcript: { state: 'resolved', identity: 'pinned_id', file: '/saved/home/projects/p/a13782f4-715f-4abc-9233-2207319a1234.jsonl' },
      turns: [turn],
    });
    await registry.updateSession(session.id, { status: 'dead' });

    const attempt = { attemptId: 'attempt-1', conversationId, startedAt: '2026-01-02T00:00:00Z' };
    const [reserved, duplicate] = await Promise.all([
      registry.beginPendingResume(session.id, attempt),
      registry.beginPendingResume(session.id, attempt),
    ]);
    expect(reserved).not.toBeNull();
    expect(duplicate).toBeNull();

    const committed = await registry.commitPendingResume(session.id, 'attempt-1');
    expect(committed).toMatchObject({
      status: 'ready', provider: 'claude', activeConversationId: conversationId,
      providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234', resumePending: null,
    });
    expect(committed?.conversations).toHaveLength(1);
    expect(committed?.conversations?.[0]?.turns).toEqual([turn]);
  });

  it('rolls back Claude resume to dead without changing history, and only the owner may resolve the attempt', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234', providerLaunchedAt: '2026-01-01T00:00:00Z',
      launchProfile: { id: 'native:claude', provider: 'claude', source: 'native', delegate: { kind: 'native', executable: 'claude' } },
    });
    const conversationId = launched?.activeConversationId as string;
    const turn = { index: 1, user: { text: 'hi', at: 'u' }, assistant: { text: 'hello', at: 'a' } };
    await registry.updateConversation(session.id, conversationId, {
      transcript: { state: 'resolved', identity: 'pinned_id', file: '/saved/home/projects/p/a13782f4-715f-4abc-9233-2207319a1234.jsonl' },
      turns: [turn],
    });
    await registry.updateSession(session.id, { status: 'dead' });
    await registry.beginPendingResume(session.id, { attemptId: 'attempt-2', conversationId, startedAt: '2026-01-02T00:00:00Z' });

    expect(await registry.commitPendingResume(session.id, 'not-owner')).toBeUndefined();
    const rolledBack = await registry.rollbackPendingResume(session.id, 'attempt-2', 'resume failed');
    expect(rolledBack).toMatchObject({ status: 'dead', activeConversationId: conversationId, resumePending: null, lastError: 'resume failed' });
    expect(rolledBack?.conversations?.[0]?.turns).toEqual([turn]);
  });

  it('backfills projectId for legacy sessions, pointing all of them at one new "hestia" project', async () => {
    const fs = await import('node:fs/promises');
    const legacySession = (id: string) => ({
      id,
      tmuxName: `hestia-${id}`,
      cwd: '/some/project',
      alias: null,
      createdAt: '2026-01-01T00:00:00Z',
      provider: null,
      providerSessionId: null,
      providerSessionFile: null,
      providerLaunchedAt: null,
      status: 'idle',
      lastUserMessageAt: null,
      lastUserMessageText: null,
      deliveryUnconfirmedText: null,
      lastError: null,
      pendingInteraction: null,
      turns: [],
      turnsSourceFile: null,
      // projectId deliberately absent — this is the point of the test.
    });
    await fs.writeFile(
      path.join(stateDir, 'registry.json'),
      JSON.stringify([legacySession('sess-1'), legacySession('sess-2')]),
      'utf-8',
    );

    const sessions = await registry.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.projectId).toBeTruthy();
    expect(sessions[0]?.projectId).toBe(sessions[1]?.projectId);

    const projectStore = await import('../src/project-store.js');
    const project = await projectStore.getProject(sessions[0]?.projectId as string);
    expect(project?.name).toBe('hestia');
  });

  it('migration is idempotent: reloading already-migrated data does not create a second "hestia" project', async () => {
    const fs = await import('node:fs/promises');
    const legacySession = {
      id: 'sess-1',
      tmuxName: 'hestia-sess-1',
      cwd: '/some/project',
      alias: null,
      createdAt: '2026-01-01T00:00:00Z',
      provider: null,
      providerSessionId: null,
      providerSessionFile: null,
      providerLaunchedAt: null,
      status: 'idle',
      lastUserMessageAt: null,
      lastUserMessageText: null,
      deliveryUnconfirmedText: null,
      lastError: null,
      pendingInteraction: null,
      turns: [],
      turnsSourceFile: null,
    };
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([legacySession]), 'utf-8');

    await registry.listSessions(); // triggers the first migration

    registry.__resetForTests();
    const projectStore = await import('../src/project-store.js');
    projectStore.__resetForTests();

    await registry.listSessions(); // reloads the now-migrated registry.json — should be a no-op migration-wise

    const projects = await projectStore.listProjects();
    const hestiaProjects = projects.filter((p) => p.name === 'hestia');
    expect(hestiaProjects).toHaveLength(1);
  });

  it('a legacy session\'s project learns its path from the session', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([{
      id: 'sess-1', tmuxName: 'hestia-sess-1', cwd: '/some/project', alias: null, createdAt: '2026-01-01T00:00:00Z',
      provider: null, providerSessionId: null, providerSessionFile: null, providerLaunchedAt: null, status: 'idle',
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null,
      pendingInteraction: null, turns: [], turnsSourceFile: null,
    }]), 'utf-8');

    const [session] = await registry.listSessions();
    const projectStore = await import('../src/project-store.js');
    const project = await projectStore.getProject(session?.projectId as string);
    expect(project?.paths.map(({ path: p, primary }) => [p, primary])).toEqual([['/some/project', true]]);
  });
});
