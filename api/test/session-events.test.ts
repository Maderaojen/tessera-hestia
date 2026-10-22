import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stateDir: string;
let events: typeof import('../src/session-events.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-session-events-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  events = await import('../src/session-events.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const file = () => path.join(stateDir, 'session-events.jsonl');
const lines = async (name = file()) => (await readFile(name, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

describe('session events', () => {
  it('appends one timestamped line per event, in order', async () => {
    await events.recordSessionEvent({ sessionId: 's1', action: 'close', result: 'closed', source: 'app', actor: 'jen' });
    await events.recordSessionEvent({ sessionId: 's1', action: 'tmux_gone', result: 'dead', source: 'reconcile', detail: { serverRunning: false } });

    const written = await lines();
    expect(written).toEqual([
      { at: expect.any(String), sessionId: 's1', action: 'close', result: 'closed', source: 'app', actor: 'jen' },
      { at: expect.any(String), sessionId: 's1', action: 'tmux_gone', result: 'dead', source: 'reconcile', detail: { serverRunning: false } },
    ]);
    expect(Number.isNaN(Date.parse(written[0].at))).toBe(false);
    // Readable by the owner only, like the registry.
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it('keeps concurrent events whole', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => events.recordSessionEvent({ sessionId: `s${i}`, action: 'launch', result: 'ok', source: 'app' })));
    expect((await lines()).map((event) => event.sessionId).sort()).toEqual(Array.from({ length: 50 }, (_, i) => `s${i}`).sort());
  });

  it('moves a full file aside instead of growing without bound', async () => {
    await writeFile(file(), `${'x'.repeat(events.SESSION_EVENTS_MAX_BYTES)}\n`);
    await events.recordSessionEvent({ sessionId: 's1', action: 'delete', result: 'ok', source: 'app' });

    expect((await lines()).map((event) => event.action)).toEqual(['delete']);
    expect((await stat(`${file()}.1`)).size).toBeGreaterThan(events.SESSION_EVENTS_MAX_BYTES);
  });

  it('never fails the operation it records', async () => {
    // A state dir under a plain file: every write fails with ENOTDIR.
    await writeFile(path.join(stateDir, 'plain-file'), '');
    process.env.HESTIA_STATE_DIR = path.join(stateDir, 'plain-file', 'state');
    vi.resetModules();
    const broken = await import('../src/session-events.js');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(broken.recordSessionEvent({ sessionId: 's1', action: 'close', result: 'closed', source: 'app' })).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});
