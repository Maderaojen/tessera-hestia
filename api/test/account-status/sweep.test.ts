import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountStatusForTests, getAccountStatus, msUntilNextQuarter, requestRefresh, startAccountStatusSchedule, sweep,
  type SweepDeps,
} from '../../src/account-status/index.js';
import { mergeAccount, readSnapshot, writeSnapshot, type Snapshot } from '../../src/account-status/snapshot.js';
import { baseStatus, usageWindow, type AccountRef, type AccountStatus } from '../../src/account-status/types.js';

const ref = (name: string): AccountRef => ({
  id: `janus:claude:${name}`, provider: 'claude', name, source: 'janus', home: `/h/${name}`, launch: ['janus', 'run', name], env: {}, unsetEnv: [],
});
const ok = (name: string, used: number, at: string): AccountStatus => ({
  ...baseStatus(ref(name), new Date(at)), state: 'ok', windows: [usageWindow('five_hour', '5 小時', used, 300, null)],
});
const failed = (name: string, at: string): AccountStatus => ({ ...baseStatus(ref(name), new Date(at)), state: 'error', error: 'timed out' });

// In-memory snapshot "file" plus a scripted prober.
function fakeDeps(start: string, probeResult: (a: AccountRef) => AccountStatus, initial: Snapshot | null = null) {
  let stored = initial;
  let clock = new Date(start);
  const probe = vi.fn(async (a: AccountRef) => probeResult(a));
  const deps: SweepDeps = {
    list: async () => ({ accounts: [ref('claude-home'), ref('claude-work')], janusAvailable: true }),
    probe,
    read: async () => stored,
    write: async (s) => { stored = s; },
    now: () => clock,
  };
  return { deps, probe, stored: () => stored, setNow: (iso: string) => { clock = new Date(iso); } };
}

afterEach(() => { __resetAccountStatusForTests(); vi.useRealTimers(); });

describe('mergeAccount', () => {
  it('records the success time of a good reading', () => {
    expect(mergeAccount(ok('a', 10, '2026-09-24T07:00:00Z'), undefined)).toMatchObject({ lastSuccessAt: '2026-09-24T07:00:00.000Z', stale: false });
  });

  it('keeps the last good numbers, flagged stale, when a probe fails transiently', () => {
    const previous = mergeAccount(ok('a', 42, '2026-09-24T07:00:00Z'), undefined);
    const merged = mergeAccount(failed('a', '2026-09-24T07:15:00Z'), previous);
    expect(merged).toMatchObject({ state: 'ok', stale: true, error: 'timed out', lastSuccessAt: '2026-09-24T07:00:00.000Z' });
    expect(merged.windows[0].usedPercent).toBe(42);
  });

  it('lets a definitive answer (logged out) replace old numbers', () => {
    const previous = mergeAccount(ok('a', 42, '2026-09-24T07:00:00Z'), undefined);
    const merged = mergeAccount({ ...failed('a', '2026-09-24T07:15:00Z'), state: 'unauthenticated' }, previous);
    expect(merged).toMatchObject({ state: 'unauthenticated', stale: false, windows: [], lastSuccessAt: '2026-09-24T07:00:00.000Z' });
  });
});

describe('snapshot file', () => {
  it('round-trips atomically and rejects foreign content', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-'));
    const file = path.join(dir, 'account-status.json');
    expect(await readSnapshot(file)).toBeNull();
    const snapshot: Snapshot = { version: 1, sweptAt: '2026-09-24T07:00:00.000Z', trigger: 'schedule', janusAvailable: true, accounts: [] };
    await writeSnapshot(snapshot, file);
    expect(await readSnapshot(file)).toEqual(snapshot);
    expect(await readdir(dir)).toEqual(['account-status.json']); // no tmp left behind
    expect(JSON.parse(await readFile(file, 'utf8')).trigger).toBe('schedule');
  });
});

describe('sweep', () => {
  it('probes every account sequentially and writes one snapshot', async () => {
    let inFlight = 0;
    const f = fakeDeps('2026-09-24T07:15:00Z', (a) => ok(a.name, 5, '2026-09-24T07:15:00Z'));
    f.probe.mockImplementation(async (a) => {
      inFlight++;
      expect(inFlight).toBe(1);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return ok(a.name, 5, '2026-09-24T07:15:00Z');
    });
    const snapshot = await sweep('schedule', f.deps);
    expect(snapshot).toMatchObject({ trigger: 'schedule', sweptAt: '2026-09-24T07:15:00.000Z', janusAvailable: true });
    expect(f.stored()?.accounts.map((a) => a.name)).toEqual(['claude-home', 'claude-work']);
  });

  it('shares one in-flight sweep between concurrent callers', async () => {
    const f = fakeDeps('2026-09-24T07:15:00Z', (a) => ok(a.name, 5, '2026-09-24T07:15:00Z'));
    const [a, b] = await Promise.all([sweep('schedule', f.deps), sweep('manual', f.deps)]);
    expect(a).toBe(b);
    expect(f.probe).toHaveBeenCalledTimes(2); // two accounts, one sweep
  });
});

describe('reading and refreshing', () => {
  const fresh: Snapshot = {
    version: 1, sweptAt: '2026-09-24T07:15:00.000Z', trigger: 'schedule', janusAvailable: true,
    accounts: [mergeAccount(ok('claude-home', 5, '2026-09-24T07:15:00Z'), undefined)],
  };

  it('GET only reads the file', async () => {
    const f = fakeDeps('2026-09-24T07:16:00Z', () => { throw new Error('must not probe'); }, fresh);
    expect(await getAccountStatus(f.deps)).toMatchObject({ fetchedAt: fresh.sweptAt, trigger: 'schedule', sweeping: false });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it('a sidebar view re-probes only data older than 5 minutes', async () => {
    const f = fakeDeps('2026-09-24T07:19:59Z', (a) => ok(a.name, 9, '2026-09-24T07:20:00Z'), fresh);
    expect((await requestRefresh(false, f.deps)).sweeping).toBe(false);
    f.setNow('2026-09-24T07:20:01Z');
    const report = await requestRefresh(false, f.deps);
    expect(report).toMatchObject({ sweeping: true, fetchedAt: fresh.sweptAt }); // answers with the old file right away
    await vi.waitFor(() => expect(f.stored()?.trigger).toBe('view'));
  });

  it('a manual refresh always re-probes', async () => {
    const f = fakeDeps('2026-09-24T07:15:30Z', (a) => ok(a.name, 9, '2026-09-24T07:15:30Z'), fresh);
    expect((await requestRefresh(true, f.deps)).sweeping).toBe(true);
    await vi.waitFor(() => expect(f.stored()?.trigger).toBe('manual'));
  });
});

describe('schedule', () => {
  it('fires on the next :00 / :15 / :30 / :45', () => {
    expect(msUntilNextQuarter(new Date('2026-09-24T07:14:59.000Z'))).toBe(1_000);
    expect(msUntilNextQuarter(new Date('2026-09-24T07:15:00.000Z'))).toBe(15 * 60_000);
    expect(msUntilNextQuarter(new Date('2026-09-24T07:52:30.000Z'))).toBe(7.5 * 60_000);
  });

  it('sweeps at startup only when the file is older than 15 minutes, then on every quarter hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T07:10:00Z'));
    const f = fakeDeps('2026-09-24T07:10:00Z', (a) => ok(a.name, 1, new Date().toISOString()), {
      version: 1, sweptAt: '2026-09-24T07:00:00.000Z', trigger: 'schedule', janusAvailable: true, accounts: [],
    });
    f.deps.now = () => new Date();
    await startAccountStatusSchedule(f.deps);
    expect(f.probe).not.toHaveBeenCalled(); // 10 min old: fresh enough
    await vi.advanceTimersByTimeAsync(5 * 60_000); // → 07:15
    expect(f.stored()?.trigger).toBe('schedule');
    expect(f.stored()?.sweptAt).toBe('2026-09-24T07:15:00.000Z');
    await vi.advanceTimersByTimeAsync(15 * 60_000); // → 07:30
    expect(f.stored()?.sweptAt).toBe('2026-09-24T07:30:00.000Z');
  });

  it('sweeps immediately at startup when there is no file yet', async () => {
    vi.useFakeTimers();
    const f = fakeDeps('2026-09-24T07:10:00Z', (a) => ok(a.name, 1, '2026-09-24T07:10:00Z'));
    await startAccountStatusSchedule(f.deps);
    await vi.waitFor(() => expect(f.stored()?.trigger).toBe('startup'));
  });
});
