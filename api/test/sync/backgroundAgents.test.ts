import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../../src/types.js';

vi.mock('../../src/registry.js', () => ({ updateSession: vi.fn(async () => undefined) }));
vi.mock('../../src/sync/binding.js', () => ({ resolvedBinding: vi.fn() }));

const registry = await import('../../src/registry.js');
const { resolvedBinding } = await import('../../src/sync/binding.js');
const { codexAdapter, rolloutSearchRoots } = await import('../../src/providers/codex.js');
const { deriveSessionActivity } = await import('../../src/types.js');
const { toSessionDto } = await import('../../src/session-dto.js');
const {
  BACKGROUND_CONFIRM_MS, BACKGROUND_TURN_QUIET_MS, __resetBackgroundAgentChecksForTests, countBackgroundAgents, readBackgroundTurn, refreshBackgroundAgents,
} = await import('../../src/sync/backgroundAgents.js');

// Codex 0.162.1 rollouts (test/fixtures/subagents/): the parent's build_check
// child was set running again after its turn, and its rollout ends on that
// new turn's task_started.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/subagents');
const PARENT = '01a12360-1111-7111-8111-111111111111';
const CHILD = '01a12362-2222-7222-8222-222222222222';

type Row = Record<string, unknown> & { payload?: Record<string, unknown> };

let root: string;
let parentFile: string;
let childFile: string;
const stillRunning = vi.fn(codexAdapter.subagentStillRunning!);
const adapter = { ...codexAdapter, subagentStillRunning: stillRunning };

async function fixture(name: string): Promise<Row[]> {
  return (await readFile(path.join(FIXTURES, name), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line) as Row);
}

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

const childEnded = async () => {
  const child = await fixture('codex.child.0.162.1.jsonl');
  const done = { ...child.at(-1)!, ordinal: 20, timestamp: '2026-10-10T02:17:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: 'ok' } };
  await writeJsonl(childFile, [...child, done]);
};

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1', status: 'ready', turnPhase: 'idle', provider: 'codex',
    providerLaunchedAt: '2026-10-10T02:00:00.000Z', backgroundAgents: 0,
    ...overrides,
  } as ManagedSession;
}

beforeEach(async () => {
  __resetBackgroundAgentChecksForTests();
  root = await mkdtemp(path.join(os.tmpdir(), 'background-agents-test-'));
  parentFile = path.join(rolloutSearchRoots(root, PARENT)[1]!, `rollout-2026-10-10T09-28-47-${PARENT}.jsonl`);
  childFile = path.join(rolloutSearchRoots(root, CHILD)[1]!, `rollout-2026-10-10T10-15-41-${CHILD}.jsonl`);
  await writeJsonl(parentFile, await fixture('codex.parent.0.162.1.jsonl'));
  await writeJsonl(childFile, await fixture('codex.child.0.162.1.jsonl'));
  vi.mocked(resolvedBinding).mockReturnValue({ file: parentFile, adapter } as never);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('countBackgroundAgents', () => {
  it("counts a child the parent's rollout leaves out, confirmed by its own tail", async () => {
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(1);
    expect(stillRunning).toHaveBeenCalledTimes(1);
  });

  it('drops one whose own rollout says it ended, though the parent never wrote so', async () => {
    await childEnded();
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(0);
  });

  it(`re-reads a child's tail at most every ${BACKGROUND_CONFIRM_MS}ms per session`, async () => {
    const t0 = 1_000_000;
    expect(await countBackgroundAgents(session(), t0)).toBe(1);
    await childEnded();
    expect(await countBackgroundAgents(session(), t0 + 1_000)).toBe(1);
    expect(await countBackgroundAgents(session(), t0 + BACKGROUND_CONFIRM_MS - 1)).toBe(1);
    expect(stillRunning).toHaveBeenCalledTimes(1);
    expect(await countBackgroundAgents(session(), t0 + BACKGROUND_CONFIRM_MS)).toBe(0);
    expect(stillRunning).toHaveBeenCalledTimes(2);
    // Seen ended, it stays so without another read.
    expect(await countBackgroundAgents(session(), t0 + 3 * BACKGROUND_CONFIRM_MS)).toBe(0);
    expect(stillRunning).toHaveBeenCalledTimes(2);
  });

  it('counts it again once the parent sets it running again', async () => {
    await childEnded();
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(0);
    const parent = await fixture('codex.parent.0.162.1.jsonl');
    const again = structuredClone(parent.at(-1)!);
    again.timestamp = '2026-10-10T02:18:00.000Z';
    again.ordinal = 30;
    await writeJsonl(parentFile, [...parent, again]);
    // The parent's later word stands until the next confirmation.
    expect(await countBackgroundAgents(session(), 1_000_001)).toBe(1);
  });

  it("trusts the parent's rollout while its own turn is still on, reading no child", async () => {
    await childEnded();
    expect(await countBackgroundAgents(session({ turnPhase: 'replying' }), 1_000_000)).toBe(1);
    expect(stillRunning).not.toHaveBeenCalled();
  });

  it("keeps the parent's word when the child's rollout can't tell", async () => {
    await rm(childFile);
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(1);
  });

  it('reads nothing when the parent has none out', async () => {
    const parent = await fixture('codex.parent.0.162.1.jsonl');
    await writeJsonl(parentFile, parent.slice(0, 2));
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(0);
    expect(stillRunning).not.toHaveBeenCalled();
  });

  it('counts none the CLI outlived (as the subagent listing shows them stopped)', async () => {
    expect(await countBackgroundAgents(session({ status: 'dead' }), 1_000_000)).toBe(0);
    expect(await countBackgroundAgents(session({ status: 'idle' }), 1_000_000)).toBe(0);
    // Relaunched after it started: its CLI process is gone.
    expect(await countBackgroundAgents(session({ providerLaunchedAt: '2026-10-10T03:00:00.000Z' }), 1_000_000)).toBe(0);
    expect(stillRunning).not.toHaveBeenCalled();
  });

  it('counts none without a bound transcript or a CLI that can tell', async () => {
    vi.mocked(resolvedBinding).mockReturnValueOnce(null);
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(0);
    vi.mocked(resolvedBinding).mockReturnValueOnce({ file: parentFile, adapter: { name: 'gemini' } } as never);
    expect(await countBackgroundAgents(session(), 1_000_000)).toBe(0);
  });
});

describe('refreshBackgroundAgents', () => {
  it('writes the count only when it changed', async () => {
    // (The fixture also ends on an open turn: backgroundTurn.)
    await refreshBackgroundAgents(session(), 1_000_000);
    expect(registry.updateSession).toHaveBeenCalledWith('sess-1', { backgroundAgents: 1, backgroundTurn: true });
    vi.mocked(registry.updateSession).mockClear();
    await refreshBackgroundAgents(session({ backgroundAgents: 1, backgroundTurn: true }), 1_000_001);
    expect(registry.updateSession).not.toHaveBeenCalled();
    await refreshBackgroundAgents(session({ backgroundAgents: 1, backgroundTurn: true, status: 'dead' }), 1_000_002);
    expect(registry.updateSession).toHaveBeenCalledWith('sess-1', { backgroundAgents: 0, backgroundTurn: false });
  });

  it('never writes a record that never had any', async () => {
    vi.mocked(resolvedBinding).mockReturnValue(null);
    await refreshBackgroundAgents(session({ backgroundAgents: undefined }), 1_000_000);
    expect(registry.updateSession).not.toHaveBeenCalled();
  });
});

describe('readBackgroundTurn (a turn the CLI started by itself)', () => {
  // The parent fixture ends on an open turn (a task_started with no
  // task_complete or turn_aborted since). While the app's turn is over,
  // that is a turn nobody sent from the app.
  const now = async () => (await stat(parentFile)).mtimeMs + 1_000;

  it('is on while the app\'s turn is over and the transcript ends in an open turn', async () => {
    expect(await readBackgroundTurn(session(), await now())).toBe(true);
    expect(await codexAdapter.openTurnAtEnd!(parentFile)).not.toBeNull();
  });

  it('is off once that turn closes', async () => {
    const parent = await fixture('codex.parent.0.162.1.jsonl');
    const done = { ...parent.at(-1)!, ordinal: 40, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } };
    await writeJsonl(parentFile, [...parent, done]);
    expect(await readBackgroundTurn(session(), await now())).toBe(false);
  });

  it(`is off once the transcript has been quiet ${BACKGROUND_TURN_QUIET_MS}ms (a turn that never closed)`, async () => {
    expect(await readBackgroundTurn(session(), (await now()) + BACKGROUND_TURN_QUIET_MS)).toBe(false);
  });

  it('is off while the app\'s own turn is on, or the CLI is not idle, or gone', async () => {
    const at = await now();
    expect(await readBackgroundTurn(session({ turnPhase: 'replying' }), at)).toBe(false);
    expect(await readBackgroundTurn(session({ turnPhase: 'awaiting_approval' }), at)).toBe(false);
    expect(await readBackgroundTurn(session({ stuckSince: '2026-10-10T02:00:00.000Z' }), at)).toBe(false);
    expect(await readBackgroundTurn(session({ status: 'dead' }), at)).toBe(false);
  });

  it('is written with the count, only when it changed', async () => {
    const at = await now();
    await refreshBackgroundAgents(session({ backgroundAgents: 1 }), at);
    expect(registry.updateSession).toHaveBeenCalledWith('sess-1', { backgroundTurn: true });
    vi.mocked(registry.updateSession).mockClear();
    await refreshBackgroundAgents(session({ backgroundAgents: 1, backgroundTurn: true }), at + 1);
    expect(registry.updateSession).not.toHaveBeenCalled();
  });
});

describe('the session DTO', () => {
  it('carries the count apart from activity, which stays idle so sends and turn-done logic are unchanged', () => {
    const running = session({ backgroundAgents: 2, conversations: [], turns: [] } as Partial<ManagedSession>);
    expect(deriveSessionActivity(running)).toBe('idle');
    expect(toSessionDto(running)).toMatchObject({ activity: 'idle', turnPhase: 'idle', backgroundAgents: 2 });
    expect(toSessionDto({ ...running, backgroundAgents: undefined })).toMatchObject({ backgroundAgents: 0 });
    // A CLI no longer running has none, whatever was last written.
    expect(toSessionDto({ ...running, status: 'dead' })).toMatchObject({ backgroundAgents: 0 });
    expect(toSessionDto({ ...running, backgroundTurn: true })).toMatchObject({ activity: 'idle', backgroundTurn: true });
    expect(toSessionDto(running)).toMatchObject({ backgroundTurn: false });
    expect(toSessionDto({ ...running, backgroundTurn: true, status: 'dead' })).toMatchObject({ backgroundTurn: false });
  });
});
