import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let stateDir: string;
let registry: typeof import('../src/registry.js');
let sessionStream: typeof import('../src/session-stream.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-registry-store-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
  sessionStream = await import('../src/session-stream.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const readDisk = async () => {
  const fs = await import('node:fs/promises');
  return JSON.parse(await fs.readFile(path.join(stateDir, 'registry.json'), 'utf-8')) as Array<{ id: string; alias: string | null }>;
};

describe('registry store', () => {
  it('keeps memory as it was, and publishes nothing, when a write fails', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const events: unknown[] = [];
    const stop = sessionStream.observeAll((_id, event) => events.push(event));
    try {
      vi.mocked(fs.rename).mockRejectedValueOnce(new Error('disk full'));
      await expect(registry.updateSession(session.id, { alias: 'lost' })).rejects.toThrow('disk full');
      expect((await registry.getSession(session.id))?.alias).toBeNull();
      expect((await readDisk())[0]?.alias).toBeNull();
      expect(events).toEqual([]);

      // The failure doesn't wedge later changes.
      await registry.updateSession(session.id, { alias: 'kept' });
      expect((await registry.getSession(session.id))?.alias).toBe('kept');
      expect((await readDisk())[0]?.alias).toBe('kept');
      expect(events).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('gives back a claim whose write failed, so the poller is not locked out', async () => {
    const fs = await import('node:fs/promises');
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = {
      provider: 'codex' as const, runtimeId: 'codex-cli' as const, providerSessionId: null, providerLaunchedAt: '2026-01-01T00:00:00Z',
      previousStatus: 'idle' as const, previousTurnPhase: 'idle' as const,
      launchProfile: { id: 'native:codex', provider: 'codex' as const, source: 'native' as const, delegate: { kind: 'native' as const, executable: 'codex' } },
    };
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('disk full'));
    await expect(registry.beginPendingLaunch(session.id, attempt)).rejects.toThrow('disk full');
    expect(registry.ownsLaunchAttemptLocally(session.id, attempt.providerLaunchedAt)).toBe(false);
    expect((await registry.getSession(session.id))?.launchPending).toBeNull();

    expect(await registry.beginPendingLaunch(session.id, attempt)).toMatchObject({ status: 'launching' });
    expect(registry.ownsLaunchAttemptLocally(session.id, attempt.providerLaunchedAt)).toBe(true);
  });

  it('applies concurrent changes to one session one after another, losing none', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    await Promise.all([
      registry.updateSession(session.id, { alias: 'a' }),
      registry.updateSession(session.id, { lastError: 'b' }),
      registry.updateConversation(session.id, 'missing', {}),
    ]);
    expect(await registry.getSession(session.id)).toMatchObject({ alias: 'a', lastError: 'b' });
    expect((await readDisk())[0]).toMatchObject({ alias: 'a', lastError: 'b' });
  });

  it('never grants two concurrent claims on the same session', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = (at: string) => ({
      provider: 'codex' as const, runtimeId: 'codex-cli' as const, providerSessionId: null, providerLaunchedAt: at,
      previousStatus: 'idle' as const, previousTurnPhase: 'idle' as const,
      launchProfile: { id: 'native:codex', provider: 'codex' as const, source: 'native' as const, delegate: { kind: 'native' as const, executable: 'codex' } },
    });
    const results = await Promise.all([
      registry.beginPendingLaunch(session.id, attempt('2026-01-01T00:00:00Z')),
      registry.beginPendingLaunch(session.id, attempt('2026-01-01T00:00:01Z')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(registry.ownsLaunchAttemptLocally(session.id, '2026-01-01T00:00:01Z')).toBe(false);
  });
});
