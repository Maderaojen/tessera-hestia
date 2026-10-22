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

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-registry-migrations-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// What a record written by this build is stamped with. Kept a literal on
// purpose (not REGISTRY_SCHEMA_VERSION), so a bump has to be acknowledged here.
// v4 added the project-local session number.
const CURRENT = 4;

const registryFile = () => path.join(stateDir, 'registry.json');
const readDisk = async () => {
  const fs = await import('node:fs/promises');
  return JSON.parse(await fs.readFile(registryFile(), 'utf-8')) as Array<Record<string, unknown>>;
};
const writeDisk = async (records: unknown[]) => {
  const fs = await import('node:fs/promises');
  await fs.writeFile(registryFile(), JSON.stringify(records), 'utf-8');
};
const writesSoFar = async () => {
  const fs = await import('node:fs/promises');
  return vi.mocked(fs.rename).mock.calls.length;
};

// A record from before projects (and every later field) existed.
const preProjectSession = (id: string) => ({
  id, tmuxName: `hestia-${id}`, cwd: '/some/project', alias: null, createdAt: '2026-01-01T00:00:00Z',
  provider: null, providerSessionId: null, providerSessionFile: null, providerLaunchedAt: null, status: 'idle',
  lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null,
  pendingInteraction: null, turns: [], turnsSourceFile: null,
});

describe('registry schema version', () => {
  it('stamps records on disk only: memory and the API never see it', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    expect((await readDisk())[0]).toMatchObject({ schemaVersion: CURRENT, id: session.id });
    expect(session).not.toHaveProperty('schemaVersion');
    registry.__resetForTests();
    const reloaded = await registry.getSession(session.id);
    expect(reloaded).toEqual(session);
    const { toPublicManagedSession } = await import('../src/session-dto.js');
    expect(toPublicManagedSession(reloaded!)).not.toHaveProperty('schemaVersion');
  });

  it('upgrades an unversioned file once, then loads it without migrating or writing', async () => {
    await writeDisk([preProjectSession('sess-1')]);
    const [migrated] = await registry.listSessions();
    expect(migrated).toMatchObject({ projectId: expect.any(String), conversations: [], clearPending: null, turnPhase: 'idle' });
    expect((await readDisk())[0]?.schemaVersion).toBe(CURRENT);

    registry.__resetForTests();
    const before = await writesSoFar();
    expect(await registry.listSessions()).toEqual([migrated]);
    expect(await writesSoFar()).toBe(before);
  });

  it('does not re-run old-shape upgrades on a current record', async () => {
    // Stamped as current, so it is taken as written — even though an
    // unversioned record of this shape would be upgraded.
    const stamped: Record<string, unknown> & { id: string } = { ...(await registry.createSession('/p', 'proj-1')), schemaVersion: CURRENT };
    delete stamped.turnPhase;
    await writeDisk([stamped]);
    registry.__resetForTests();
    const before = await writesSoFar();
    expect(await registry.getSession(stamped.id)).not.toHaveProperty('turnPhase');
    expect(await writesSoFar()).toBe(before);
  });

  it('upgrades only the unversioned records of a mixed file, keeping their order', async () => {
    const current = await registry.createSession('/some/project', 'proj-1');
    await writeDisk([{ ...current, schemaVersion: CURRENT }, preProjectSession('old')]);
    registry.__resetForTests();
    const sessions = await registry.listSessions();
    expect(sessions.map((session) => session.id)).toEqual([current.id, 'old']);
    expect(sessions[0]).toEqual(current);
    expect(sessions[1]?.projectId).not.toBe('proj-1');
    expect((await readDisk()).map((record) => record.schemaVersion)).toEqual([CURRENT, CURRENT]);
  });

  it("takes a newer build's record as it is", async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    await writeDisk([{ ...session, schemaVersion: 7, futureField: 'x' }]);
    registry.__resetForTests();
    const before = await writesSoFar();
    expect(await registry.getSession(session.id)).toMatchObject({ id: session.id, futureField: 'x' });
    expect(await writesSoFar()).toBe(before);
  });

  it('v1 → v2: the stuck hint moves out of lastError into stuckSince, and nothing else of v1 is re-run', async () => {
    const { STUCK_HINT_TEXT } = await import('../src/types.js');
    const stuck = await registry.createSession('/p', 'proj-1');
    const failed = await registry.createSession('/q', 'proj-1');
    const v1: Record<string, unknown> & { id: string } = { ...stuck, lastError: STUCK_HINT_TEXT, schemaVersion: 1 };
    delete v1.turnPhase; // a v1-only upgrade would have put this back
    await writeDisk([v1, { ...failed, lastError: 'launch failed', schemaVersion: 1 }]);
    registry.__resetForTests();
    const [upgraded, other] = await registry.listSessions();
    expect(upgraded).toMatchObject({ lastError: null, stuckSince: expect.any(String) });
    expect(upgraded).not.toHaveProperty('turnPhase');
    expect(other).toMatchObject({ lastError: 'launch failed' });
    expect(other?.stuckSince ?? null).toBeNull();
    expect((await readDisk()).map((record) => record.schemaVersion)).toEqual([CURRENT, CURRENT]);
  });

  it("v3 → v4: sessions are numbered per project by creation time, and each project's counter continues after them", async () => {
    const fs = await import('node:fs/promises');
    const { PROJECTS_PATH } = await import('../src/config.js');
    const project = (id: string) => ({ id, name: id, createdAt: '2026-01-01T00:00:00Z', deletedAt: null, paths: [] });
    await fs.writeFile(PROJECTS_PATH, JSON.stringify([project('a'), project('b')]));
    const v3 = (id: string, projectId: string, createdAt: string) => ({ ...preProjectSession(id), projectId, createdAt, turnPhase: 'idle', schemaVersion: 3 });
    await writeDisk([v3('a-late', 'a', '2026-03-01T00:00:00Z'), v3('b-only', 'b', '2026-02-01T00:00:00Z'), v3('a-early', 'a', '2026-01-01T00:00:00Z')]);
    registry.__resetForTests();

    const numbers = Object.fromEntries((await registry.listSessions()).map((session) => [session.id, session.sessionNumber]));
    expect(numbers).toEqual({ 'a-late': 2, 'b-only': 1, 'a-early': 1 });
    expect((await readDisk()).map((record) => record.schemaVersion)).toEqual([CURRENT, CURRENT, CURRENT]);
    const projectStore = await import('../src/project-store.js');
    expect(await projectStore.reserveSessionNumber('a')).toBe(3);
    expect(await projectStore.reserveSessionNumber('b')).toBe(2);
  });

  it('v2 → v3: an interrupted reply loses the zh-TW marker from its text and is flagged instead, in every stored copy', async () => {
    const session = await registry.createSession('/p', 'proj-1');
    const turn = (text: string) => ({ index: 1, user: { text: 'q', at: 'T1' }, assistant: { text, at: 'T2' } });
    const conversation = {
      id: 'c1', sequence: 1, kind: 'cli', provider: 'claude', launchProfile: null, providerSessionId: null, startedAt: 'T0', endedAt: null,
      startReason: 'launch', endReason: null, transcript: { state: 'pending', file: null, identity: null },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null,
      turns: [turn('partial\n\n（已中斷）'), { ...turn('（已中斷）'), index: 2 }, { ...turn('fine'), index: 3 }],
    };
    await writeDisk([{ ...session, turns: [turn('partial\n\n（已中斷）')], conversations: [conversation], activeConversationId: 'c1', schemaVersion: 2 }]);
    registry.__resetForTests();
    const loaded = await registry.getSession(session.id);
    expect(loaded?.conversations?.[0]?.turns.map((t) => t.assistant)).toEqual([
      { text: 'partial', at: 'T2', interrupted: true },
      { text: '', at: 'T2', interrupted: true },
      { text: 'fine', at: 'T2' },
    ]);
    expect(loaded?.turns[0]?.assistant).toEqual({ text: 'partial', at: 'T2', interrupted: true });
    // Sent the old way still, for PWAs cached before the flag.
    const { toPublicConversation } = await import('../src/session-dto.js');
    expect(toPublicConversation(loaded!.conversations![0]!).turns.map((t) => t.assistant.text)).toEqual(['partial\n\n（已中斷）', '（已中斷）', 'fine']);
  });
});
