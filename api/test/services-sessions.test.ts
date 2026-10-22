import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  sessionPresence: vi.fn(async () => 'present'),
  serverRunning: vi.fn(async () => true),
}));

let stateDir: string;
let registry: typeof import('../src/registry.js');
let service: typeof import('../src/services/sessions.js');
let tmux: typeof import('../src/tmux.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-session-service-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
  service = await import('../src/services/sessions.js');
  tmux = await import('../src/tmux.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  // Reset, not just clear: the tmux mock outlives vi.resetModules, so a
  // one-off implementation a test queued but never used would otherwise
  // fire in whichever test runs next.
  vi.resetAllMocks();
});

// A session belongs to a live project, which numbers it
// (projectStore.reserveSessionNumber); an unknown id is refused.
const newProject = async () => (await import('../src/project-store.js')).createProject('p');

describe('session service', () => {
  it('opens the tmux, then records the session under the same name', async () => {
    const project = await newProject();
    const session = await service.createSession('/some/project', project.id);
    expect(session.tmuxName).toBe(registry.tmuxNameFor(session.id));
    expect(tmux.newSession).toHaveBeenCalledWith(session.tmuxName, '/some/project', undefined);
    expect(await registry.getSession(session.id)).toEqual(session);
  });

  it("records a new session on this install's own tmux server, and finds each one's", async () => {
    const project = await newProject();
    const session = await service.createSession('/some/project', project.id);
    expect(session.tmuxSocket).toBe('hestia');
    expect(await registry.tmuxSocketFor(session.tmuxName)).toBe('hestia');
    // Opened before the own server: the default one, until it is reopened.
    await registry.updateSession(session.id, { tmuxSocket: null });
    expect(await registry.tmuxSocketFor(session.tmuxName)).toBeNull();
    // Not recorded yet (being opened now): the own server.
    expect(await registry.tmuxSocketFor('hestia-not-yet')).toBe('hestia');
  });

  it('takes an id chosen beforehand and variables for its tmux (a delegation\'s)', async () => {
    const project = await newProject();
    const id = '0f2c63c4-5a0e-4a52-9f0c-1b6a3c2d4e5f';
    const session = await service.createSession('/some/project', project.id, { id, env: { HESTIA_DELEGATION_ID: 'ab12cd34' } });
    expect(session.id).toBe(id);
    expect(tmux.newSession).toHaveBeenCalledWith(registry.tmuxNameFor(id), '/some/project', { HESTIA_DELEGATION_ID: 'ab12cd34' });
  });

  it('records where a branch line\'s session was forked from, once', async () => {
    const project = await newProject();
    const forkOrigin = { forkId: 'f1f1f1f1', fromSessionId: 'main', fromConversationId: 'c1', sharedFolder: false };
    const session = await service.createSession('/some/project-fork', project.id, { env: { HESTIA_FORK_ID: 'f1f1f1f1' }, forkOrigin });
    expect(session.forkOrigin).toEqual(forkOrigin);
    expect((await registry.getSession(session.id))?.forkOrigin).toEqual(forkOrigin);
    expect((await service.createSession('/some/project', project.id)).forkOrigin).toBeUndefined();
  });

  it('records which delegation a delegate\'s session works on', async () => {
    const project = await newProject();
    const delegationOrigin = { delegationId: 'ab12cd34', fromSessionId: 'main', fromConversationId: 'c1' };
    const session = await service.createSession('/some/project-delegate', project.id, { env: { HESTIA_DELEGATION_ID: 'ab12cd34' }, delegationOrigin });
    expect(session.delegationOrigin).toEqual(delegationOrigin);
    expect((await registry.getSession(session.id))?.delegationOrigin).toEqual(delegationOrigin);
    expect(session.forkOrigin).toBeUndefined();
  });

  it('adds a new folder to the project\'s paths, but not a delegation\'s or branch line\'s worktree', async () => {
    const projects = await import('../src/project-store.js');
    const project = await newProject();
    await service.createSession('/some/project', project.id);
    await service.createSession('/some/project/sub', project.id);
    await service.createSession('/some/project-delegate-ab12cd34', project.id, { rememberPath: false });
    expect((await projects.getProject(project.id))?.paths.map((entry) => entry.path)).toEqual(['/some/project']);
  });

  it('records nothing when the tmux could not be opened', async () => {
    const project = await newProject();
    vi.mocked(tmux.newSession).mockRejectedValueOnce(new Error('no tmux'));
    await expect(service.createSession('/some/project', project.id)).rejects.toThrow('no tmux');
    expect(await registry.listSessions()).toEqual([]);
  });

  it('refuses an unknown project before opening any tmux', async () => {
    await expect(service.createSession('/some/project', 'no-such-project')).rejects.toThrow('project not found');
    expect(tmux.newSession).not.toHaveBeenCalled();
    expect(await registry.listSessions()).toEqual([]);
  });

  it("adds a new session's directory to the project's paths", async () => {
    const projectStore = await import('../src/project-store.js');
    const project = await projectStore.createProject('p');
    await service.createSession('/work/a', project.id);
    await service.createSession('/work/b', project.id);
    await service.createSession('/work/a', project.id);
    // A subfolder of a path it already has isn't a new place.
    await service.createSession('/work/a/src', project.id);

    const paths = (await projectStore.getProject(project.id))?.paths ?? [];
    expect(paths.map(({ path: p, primary }) => [p, primary])).toEqual([['/work/a', true], ['/work/b', false]]);
  });

  it('kills the tmux, ends its turn like a tmux that died, and moves the record to the trash', async () => {
    const project = await newProject();
    const session = await service.createSession('/some/project', project.id);
    await registry.updateSession(session.id, { status: 'ready', turnPhase: 'replying', paneActivity: 'busy' });
    await service.removeSession(session.id);
    expect(tmux.killSession).toHaveBeenCalledWith(session.tmuxName);
    expect(await registry.getSession(session.id)).toBeUndefined();
    expect(await registry.getSessionRecord(session.id)).toMatchObject({ status: 'dead', paneActivity: 'unknown', deletedAt: expect.any(String) });
    // Unknown, or already in the trash: nothing to do.
    await service.removeSession('unknown');
    await service.removeSession(session.id);
    expect(tmux.killSession).toHaveBeenCalledTimes(1);
  });

  it('still counts a session recorded under the legacy fabrica- prefix as running', async () => {
    const project = await newProject();
    const session = await service.createSession('/a', project.id);
    const legacyName = `fabrica-${session.id}`;
    await registry.updateSession(session.id, { tmuxName: legacyName });
    vi.mocked(tmux.listManagedSessionNames).mockImplementationOnce(async (alsoOwned) => (alsoOwned?.has(legacyName) ? [legacyName] : []));

    expect(await service.reconcileWithTmux()).toEqual([]);
    expect((await registry.getSession(session.id))?.status).toBe('idle');
  });

  it('marks sessions whose tmux is gone dead and ends their turn', async () => {
    const project = await newProject();
    const gone = await service.createSession('/a', project.id);
    const alive = await service.createSession('/b', project.id);
    await registry.updateSession(gone.id, { status: 'ready', turnPhase: 'replying', paneActivity: 'busy' });
    vi.mocked(tmux.listManagedSessionNames).mockResolvedValueOnce([alive.tmuxName]);

    const died = await service.reconcileWithTmux();

    // Whatever the registry records counts as ours, whichever prefix it has.
    expect(tmux.listManagedSessionNames).toHaveBeenLastCalledWith(new Set([gone.tmuxName, alive.tmuxName]));
    expect(died.map((session) => session.id)).toEqual([gone.id]);
    expect(await registry.getSession(gone.id)).toMatchObject({ status: 'dead', paneActivity: 'unknown' });
    expect((await registry.getSession(alive.id))?.status).toBe('idle');
  });

  it('logs a tmux found gone, but not one the app just ended itself', async () => {
    const project = await newProject();
    const external = await service.createSession('/a', project.id);
    const ours = await service.createSession('/b', project.id);
    vi.mocked(tmux.listManagedSessionNames).mockResolvedValueOnce([]);
    vi.mocked(tmux.serverRunning).mockResolvedValueOnce(false);

    await service.reconcileWithTmux({ endedByApp: ours.id });

    const { readFile } = await import('node:fs/promises');
    const logged = (await readFile(path.join(stateDir, 'session-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(logged).toEqual([
      expect.objectContaining({ sessionId: external.id, action: 'tmux_gone', source: 'reconcile', detail: { tmuxName: external.tmuxName, serverRunning: false } }),
    ]);
  });

  it('ends nothing when tmux cannot list its sessions', async () => {
    const project = await newProject();
    const session = await service.createSession('/a', project.id);
    vi.mocked(tmux.listManagedSessionNames).mockRejectedValueOnce(new Error('lost server'));
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});

    expect(await service.reconcileWithTmux()).toEqual([]);
    expect((await registry.getSession(session.id))?.status).toBe('idle');
  });

  it('reconciles a session before anything is sent once tmux confirms it is gone', async () => {
    const project = await newProject();
    const session = await service.createSession('/a', project.id);
    vi.mocked(tmux.sessionPresence).mockResolvedValueOnce('present');
    expect(await service.endIfTmuxGone(session)).toBe(false);
    vi.mocked(tmux.sessionPresence).mockResolvedValueOnce('unknown');
    expect(await service.endIfTmuxGone(session)).toBe(false);
    expect((await registry.getSession(session.id))?.status).toBe('idle');

    vi.mocked(tmux.sessionPresence).mockResolvedValueOnce('gone');
    vi.mocked(tmux.listManagedSessionNames).mockResolvedValueOnce([]);
    expect(await service.endIfTmuxGone(session)).toBe(true);
    expect((await registry.getSession(session.id))?.status).toBe('dead');
  });
});
