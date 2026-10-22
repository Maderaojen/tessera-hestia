import { mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../src/types.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock('../src/tmux.js', () => ({
  sessionPresence: vi.fn(async () => 'present'),
  sendCommandLine: vi.fn(async () => {}),
  respawnPane: vi.fn(async () => {}),
  getPaneLiveness: vi.fn(async () => 'alive'),
}));
vi.mock('../src/runtimes/command-check.js', () => ({ checkCommandAvailable: async () => 'found' }));
vi.mock('../src/launch-profiles.js', () => ({
  getLaunchProfileCatalog: async () => ({ profiles: [
    { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', label: 'Claude', executable: 'claude', args: [] },
  ] }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let stateDir: string;
let registry: typeof import('../src/registry.js');
let transitions: typeof import('../src/services/transitions.js');
let reconciler: typeof import('../src/sync/transitionReconciler.js');
let tmux: typeof import('../src/tmux.js');
let pane: 'alive' | 'dead';
async function loadModules() {
  registry = await import('../src/registry.js');
  transitions = await import('../src/services/transitions.js');
  reconciler = await import('../src/sync/transitionReconciler.js');
  tmux = await import('../src/tmux.js');
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-cancel-launch-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  await loadModules();
  pane = 'alive';
  vi.mocked(tmux.getPaneLiveness).mockImplementation(async () => pane);
  vi.mocked(tmux.respawnPane).mockImplementation(async () => { pane = 'dead'; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});
async function pendingLaunch(): Promise<ManagedSession> {
  const session = await registry.createSession('/work/cancel-launch', 'proj-1');
  expect((await transitions.launch(session.id, { profileId: 'native:claude' })).ok).toBe(true);
  return (await registry.getSession(session.id))!;
}
async function nextLaunch(id: string) {
  pane = 'alive';
  expect((await transitions.launch(id, { profileId: 'native:claude' })).ok).toBe(true);
  await reconciler.reconcileLaunch((await registry.getSession(id))!);
  expect(await registry.getSession(id)).toMatchObject({ status: 'ready', provider: 'claude', launchPending: null });
}

describe('launch cancellation owns the pane until its attempt is resolved', () => {
  it('does not cancel or confirm while the launch command is still being dispatched', async () => {
    const session = await registry.createSession('/work/cancel-launch', 'proj-1');
    const entered = deferred<void>();
    const dispatch = deferred<void>();
    vi.mocked(tmux.sendCommandLine).mockImplementationOnce(async () => {
      entered.resolve();
      await dispatch.promise;
    });
    const launching = transitions.launch(session.id, { profileId: 'native:claude' });
    await entered.promise;
    const pending = (await registry.getSession(session.id))!;
    const result = await transitions.cancelLaunch(session.id);
    await reconciler.reconcileLaunch(pending);
    dispatch.resolve();
    await launching;
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(tmux.respawnPane).not.toHaveBeenCalled();
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'launching', provider: null });
    await reconciler.reconcileLaunch((await registry.getSession(session.id))!);
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'ready', provider: 'claude' });
  });
  it('cannot confirm a launch while its cancellation is resetting the pane', async () => {
    const session = await pendingLaunch();
    const entered = deferred<void>();
    const reset = deferred<void>();
    vi.mocked(tmux.respawnPane).mockImplementationOnce(async () => {
      entered.resolve();
      await reset.promise;
      pane = 'dead';
    });
    const cancellation = transitions.cancelLaunch(session.id);
    await entered.promise;
    await reconciler.reconcileLaunch(session);
    reset.resolve();
    expect(await cancellation).toMatchObject({ ok: true, status: 200 });
    expect(pane).toBe('dead');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'idle', provider: null, launchPending: null, conversations: [] });
    await nextLaunch(session.id);
  });
  it('refuses cancellation when an in-flight poll already owns confirmation', async () => {
    const session = await pendingLaunch();
    const entered = deferred<void>();
    const observed = deferred<'alive'>();
    vi.mocked(tmux.getPaneLiveness).mockImplementationOnce(async () => {
      entered.resolve();
      return observed.promise;
    });
    const polling = reconciler.reconcileLaunch(session);
    await entered.promise;
    const result = await transitions.cancelLaunch(session.id);
    observed.resolve('alive');
    await polling;
    expect(result).toMatchObject({ ok: false, status: 409, code: 'no_launch_to_cancel' });
    expect(pane).toBe('alive');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'ready', provider: 'claude', launchPending: null });
  });
  it('refuses duplicate cancellation and prevents another launch until reset finishes', async () => {
    const session = await pendingLaunch();
    const entered = deferred<void>();
    const reset = deferred<void>();
    vi.mocked(tmux.respawnPane).mockImplementationOnce(async () => {
      entered.resolve();
      await reset.promise;
      pane = 'dead';
    });
    const cancellation = transitions.cancelLaunch(session.id);
    await entered.promise;
    const duplicate = await transitions.cancelLaunch(session.id);
    const launch = await transitions.launch(session.id, { profileId: 'native:claude' });
    reset.resolve();
    await cancellation;
    expect(duplicate).toMatchObject({ ok: false, status: 409 });
    expect(launch).toMatchObject({ ok: false, status: 409 });
    expect(tmux.respawnPane).toHaveBeenCalledTimes(1);
    await nextLaunch(session.id);
  });
  it('does not act on an old poll snapshot after cancellation and a subsequent launch', async () => {
    const old = await pendingLaunch();
    expect((await transitions.cancelLaunch(old.id)).ok).toBe(true);
    pane = 'alive';
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2030-01-01T00:00:00.000Z');
    expect((await transitions.launch(old.id, { profileId: 'native:claude' })).ok).toBe(true);
    const current = (await registry.getSession(old.id))!;
    await reconciler.reconcileLaunch(old);
    expect(await registry.getSession(old.id)).toEqual(current);
    await reconciler.reconcileLaunch(current);
    expect(await registry.getSession(old.id)).toMatchObject({ status: 'ready', provider: 'claude', providerLaunchedAt: '2030-01-01T00:00:00.000Z' });
  });
  it('releases cancellation ownership after reset failure so the live CLI can be confirmed', async () => {
    const session = await pendingLaunch();
    vi.mocked(tmux.respawnPane).mockRejectedValueOnce(new Error('tmux failed'));
    expect(await transitions.cancelLaunch(session.id)).toMatchObject({ ok: false, status: 503, code: 'pane_reset_failed' });
    await reconciler.reconcileLaunch((await registry.getSession(session.id))!);
    expect(pane).toBe('alive');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'ready', provider: 'claude', launchPending: null });
  });
  it('does not reset a CLI after its launch was committed', async () => {
    const session = await pendingLaunch();
    await reconciler.reconcileLaunch(session);
    const ready = await registry.getSession(session.id);
    expect(await transitions.cancelLaunch(session.id)).toMatchObject({ ok: false, status: 409 });
    expect(pane).toBe('alive');
    expect(await registry.getSession(session.id)).toEqual(ready);
    expect(tmux.respawnPane).not.toHaveBeenCalled();
  });
  it('releases polling ownership when observation fails, allowing cancellation', async () => {
    const session = await pendingLaunch();
    vi.mocked(tmux.getPaneLiveness).mockRejectedValueOnce(new Error('observation failed'));
    await expect(reconciler.reconcileLaunch(session)).rejects.toThrow('observation failed');
    expect((await transitions.cancelLaunch(session.id)).ok).toBe(true);
    expect(pane).toBe('dead');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'idle', provider: null, launchPending: null });
  });
  it('releases polling ownership after confirmation persistence fails, allowing cancellation', async () => {
    const session = await pendingLaunch();
    vi.mocked(rename).mockRejectedValueOnce(new Error('confirmation write failed'));
    await expect(reconciler.reconcileLaunch(session)).rejects.toThrow('confirmation write failed');
    expect((await transitions.cancelLaunch(session.id)).ok).toBe(true);
    expect(pane).toBe('dead');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'idle', provider: null, launchPending: null, conversations: [] });
  });
  it('recovers a reset pane after a rollback write failure and API restart', async () => {
    const session = await pendingLaunch();
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk write failed'));
    await expect(transitions.cancelLaunch(session.id)).rejects.toThrow('disk write failed');
    expect(pane).toBe('dead');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'launching', provider: null, launchPending: expect.any(Object) });
    vi.resetModules();
    await loadModules();
    const recovered = (await registry.getSession(session.id))!;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(recovered.launchPending!.providerLaunchedAt) + 60_000);
    await reconciler.reconcileLaunch(recovered);
    now.mockReturnValue(Date.parse(recovered.launchPending!.providerLaunchedAt) + 120_000);
    await reconciler.reconcileLaunch(recovered);
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'idle', provider: null, launchPending: null, conversations: [] });
    await nextLaunch(session.id);
  });
  it('releases cancellation ownership after rollback persistence fails, allowing a retry', async () => {
    const session = await pendingLaunch();
    vi.mocked(rename).mockRejectedValueOnce(new Error('rollback write failed'));
    await expect(transitions.cancelLaunch(session.id)).rejects.toThrow('rollback write failed');
    expect((await transitions.cancelLaunch(session.id)).ok).toBe(true);
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'idle', provider: null, launchPending: null });
    await nextLaunch(session.id);
  });
  it('loses process-local cancellation ownership on restart and confirms the surviving CLI', async () => {
    const session = await pendingLaunch();
    expect(await registry.claimPendingLaunch(session.id, session.launchPending!.providerLaunchedAt)).toBeDefined();
    vi.resetModules();
    await loadModules();
    const recovered = (await registry.getSession(session.id))!;
    await reconciler.reconcileLaunch(recovered);
    expect(pane).toBe('alive');
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'ready', provider: 'claude', launchPending: null });
  });
});
