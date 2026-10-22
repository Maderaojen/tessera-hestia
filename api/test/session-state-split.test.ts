import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE_TRANSITIONS } from '../src/registry/lifecycle.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSessionActivity, STUCK_HINT_TEXT, type LegacySessionStatus, type ManagedSession, type PaneActivity, type SessionActivity, type SessionStatus, type TurnPhase } from '../src/types.js';
import { toPublicManagedSession } from '../src/session-dto.js';

// Phase 2 of docs/decisions/0007-session-state-machine.md: `status` holds only the CLI
// lifecycle, the turn phase lives in `turnPhase`.

vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
}));

let stateDir: string;
let registry: typeof import('../src/registry.js');
let turnEffects: typeof import('../src/sync/turnEffects.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-state-split-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
  turnEffects = await import('../src/sync/turnEffects.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const CLAUDE_PROFILE = {
  id: 'native:claude', provider: 'claude' as const, source: 'native' as const,
  home: '/h/.claude', conversationRoot: '/h/.claude/projects', delegate: { kind: 'native' as const, executable: 'claude' },
};

// A record in the current shape except for the turn-phase split: every
// other migration is already done, so only this one can act on it.
function storedRecord(id: string, status: LegacySessionStatus, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, tmuxName: `hestia-${id}`, cwd: '/p', projectId: 'proj-1', alias: null, createdAt: '2026-01-01T00:00:00Z',
    provider: 'claude', providerSessionId: 'sid', providerSessionFile: null, providerLaunchedAt: '2026-01-01T00:00:00Z',
    status, lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null,
    pendingInteraction: null, turns: [], turnsSourceFile: null, launchProfile: null, activeConversationId: null,
    conversations: [], launchPending: null, resumePending: null, claudeClearPending: null,
    ...extra,
  };
}

describe('registry load migrates the pre-split status', () => {
  const launchAttempt = {
    provider: 'codex', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:01:00Z', previousStatus: 'waiting',
    launchProfile: { id: 'native:codex', provider: 'codex', source: 'native', delegate: { kind: 'native', executable: 'codex' } },
  };
  const clearAttempt = {
    attemptId: 'a1', conversationId: null, newProviderSessionId: 'n', launchArgv: [], startedAt: 't',
    previousStatus: 'needs_interaction', phase: 'waiting_exit', launchStartedAt: null,
  };
  const legacyFile = () => JSON.stringify([
    storedRecord('waiting', 'waiting'),
    storedRecord('prompt', 'needs_interaction'),
    storedRecord('ready', 'ready'),
    storedRecord('idle', 'idle'),
    storedRecord('launching', 'launching'),
    storedRecord('dead', 'dead'),
    storedRecord('launch-pending', 'launching', { provider: null, launchPending: launchAttempt }),
    storedRecord('clear-pending', 'launching', { claudeClearPending: clearAttempt }),
  ]);

  async function loadAll(): Promise<Record<string, ManagedSession>> {
    return Object.fromEntries((await registry.listSessions()).map((session) => [session.id, session]));
  }

  it('maps each old status onto status + turnPhase, and a missing turnPhase to idle', async () => {
    await writeFile(path.join(stateDir, 'registry.json'), legacyFile(), 'utf-8');
    const loaded = await loadAll();

    expect(loaded.waiting).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(loaded.prompt).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
    for (const id of ['ready', 'idle', 'launching', 'dead'] as const) {
      expect(loaded[id]).toMatchObject({ status: id, turnPhase: 'idle' });
    }
    // A pending attempt's previous status is what its rollback restores.
    expect(loaded['launch-pending']?.launchPending).toMatchObject({ previousStatus: 'ready', previousTurnPhase: 'replying' });
    expect(loaded['clear-pending']?.clearPending).toMatchObject({ previousStatus: 'ready', previousTurnPhase: 'awaiting_approval' });

    // Written back, so the file itself is migrated.
    const onDisk = JSON.parse(await readFile(path.join(stateDir, 'registry.json'), 'utf-8')) as ManagedSession[];
    expect(onDisk.find((session) => session.id === 'waiting')).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(onDisk.every((session) => session.turnPhase !== undefined)).toBe(true);
  });

  it('is idempotent: a second load of the migrated file changes nothing', async () => {
    await writeFile(path.join(stateDir, 'registry.json'), legacyFile(), 'utf-8');
    const first = await loadAll();
    const migratedRaw = await readFile(path.join(stateDir, 'registry.json'), 'utf-8');

    vi.resetModules();
    registry = await import('../src/registry.js');
    const second = await loadAll();

    expect(second).toEqual(first);
    expect(await readFile(path.join(stateDir, 'registry.json'), 'utf-8')).toBe(migratedRaw);
  });

  it('leaves an already-split record untouched', async () => {
    const current = storedRecord('s', 'ready', { turnPhase: 'replying', runtimeId: 'claude-code', clearPending: null });
    delete current.claudeClearPending;
    await writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([current]), 'utf-8');
    // Unstamped, so the later upgrades still run: v4 only numbers it (the
    // first session of its project); its split state is left as written.
    expect(await registry.getSession('s')).toEqual({ ...current, sessionNumber: 1 });
  });
});

describe('lifecycle transitions', () => {
  // Every lifecycle write in registry.ts, driven through its real path.
  // Records each move so the test can also show which table rows it used.
  async function drive(warn: ReturnType<typeof vi.spyOn>) {
    const seen: [SessionStatus, SessionStatus][] = [];
    const step = async (run: () => Promise<ManagedSession | null | undefined>) => {
      const before = (await registry.listSessions())[0]!.status;
      const after = await run();
      if (!after) throw new Error('lifecycle step was refused');
      seen.push([before, after.status]);
      return after;
    };
    const stale = (id: string) => registry.updateSession(id, { turnPhase: 'replying' });
    const t = '2026-01-01T00:00:00Z';
    const { id } = await registry.createSession('/p', 'proj-1');

    // idle → launching → idle (rolled-back launch) → launching → ready (launch commit)
    const attempt = { provider: 'claude' as const, providerSessionId: 'sid-1', providerLaunchedAt: t, previousStatus: 'idle' as const, launchProfile: CLAUDE_PROFILE };
    await step(() => registry.beginPendingLaunch(id, attempt));
    await step(() => registry.rollbackPendingLaunch(id, 'failed'));
    await step(() => registry.beginPendingLaunch(id, attempt));
    await stale(id);
    const launched = await step(() => registry.commitConversationLaunch(id, { provider: 'claude', providerSessionId: 'sid-1', providerLaunchedAt: t, launchProfile: CLAUDE_PROFILE }, t));
    expect(launched.turnPhase).toBe('idle');
    const first = launched.activeConversationId!;
    await registry.updateConversation(id, first, { transcript: { state: 'resolved', file: '/t/sid-1.jsonl', identity: 'pinned_id' } });

    // ready → launching → ready: a /clear rolled back returns to the same CLI
    // and its turn; one that commits starts a fresh, idle turn.
    const clear = (attemptId: string, conversationId: string) => ({
      attemptId, conversationId, newProviderSessionId: `new-${attemptId}`, launchArgv: [], startedAt: t,
      previousStatus: 'ready' as const, previousTurnPhase: 'replying' as const, phase: 'waiting_exit' as const, launchStartedAt: null,
    });
    await stale(id);
    await step(() => registry.beginPendingClear(id, clear('c1', first)));
    const restored = await step(() => registry.failPendingClear(id, 'c1', null, { exited: false }));
    expect(restored).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    await step(() => registry.beginPendingClear(id, clear('c2', first)));
    await registry.beginPendingClearLaunch(id, 'c2');
    const cleared = await step(() => registry.commitPendingClear(id, 'c2'));
    expect(cleared.turnPhase).toBe('idle');
    const second = cleared.activeConversationId!;
    await registry.updateConversation(id, second, { transcript: { state: 'resolved', file: '/t/new-c2.jsonl', identity: 'pinned_id' } });

    // ready → launching → ready: a switch back to the first conversation.
    await stale(id);
    await step(() => registry.beginConversationSwitch(id, { ...clear('s1', second), targetConversationId: first }));
    await registry.beginPendingClearLaunch(id, 's1');
    const switched = await step(() => registry.commitPendingClear(id, 's1'));
    expect(switched).toMatchObject({ status: 'ready', activeConversationId: first, turnPhase: 'idle' });

    // ready → dead (reconcile) → launching → dead (resume rolled back) →
    // launching → ready (resume commit)
    const reconcileDead = async () => (await registry.markDeadUnlessRunning(new Set()))[0];
    await stale(id);
    await step(reconcileDead);
    await step(() => registry.beginPendingResume(id, { attemptId: 'r1', conversationId: first, startedAt: t }));
    await step(() => registry.rollbackPendingResume(id, 'r1', 'failed'));
    await step(() => registry.beginPendingResume(id, { attemptId: 'r2', conversationId: first, startedAt: t }));
    const resumed = await step(() => registry.commitPendingResume(id, 'r2'));
    expect(resumed.turnPhase).toBe('idle');

    // ready → launching → dead (tmux gone mid-clear); dead → launching → idle
    // (a switch whose new CLI never came up).
    await step(() => registry.beginPendingClear(id, clear('c3', first)));
    await step(() => registry.failPendingClear(id, 'c3', 'gone', { exited: false, tmuxMissing: true }));
    await step(() => registry.beginConversationSwitch(id, { ...clear('s2', first), previousStatus: 'dead', targetConversationId: second }));
    await step(() => registry.failPendingClear(id, 's2', 'failed', { exited: true }));

    // idle → dead (reconcile)
    await step(reconcileDead);

    expect(warn).not.toHaveBeenCalled();
    return { id, seen };
  }

  it('uses only allowed transitions on every lifecycle path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { seen } = await drive(warn);
    for (const [from, to] of seen) {
      if (from !== to) expect(LIFECYCLE_TRANSITIONS[from]).toContain(to);
    }
  });

  it('covers the remaining paths: CLI exit, a legacy runtime recovered from launching', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = '2026-01-01T00:00:00Z';
    const { id } = await registry.createSession('/p', 'proj-1');
    await registry.beginPendingLaunch(id, { provider: 'codex', providerSessionId: null, providerLaunchedAt: t, previousStatus: 'idle', launchProfile: { ...CLAUDE_PROFILE, id: 'native:codex', provider: 'codex' } });
    await registry.commitConversationLaunch(id, { provider: 'codex', providerSessionId: null, providerLaunchedAt: t, launchProfile: null }, t);
    expect(await registry.endActiveConversation(id, 'cli_exit')).toMatchObject({ status: 'idle' });

    // A pre-conversation-model record still 'launching' with a live CLI.
    await registry.updateSession(id, { status: 'launching', provider: 'codex', activeConversationId: null, turnPhase: 'replying' });
    expect(await registry.attachRuntimeRecoveryConversation(id)).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an unexpected transition and still applies it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { id } = await registry.createSession('/p', 'proj-1');
    // idle → ready with no launch claim: no real path does this.
    const updated = await registry.commitConversationLaunch(id, { provider: 'codex', providerSessionId: null, providerLaunchedAt: 't', launchProfile: null });
    expect(updated).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('idle → ready'));
  });

  it('restores the previous turn phase when a launch over a running CLI rolls back', async () => {
    const { id } = await registry.createSession('/p', 'proj-1');
    await registry.updateSession(id, { status: 'ready', turnPhase: 'awaiting_approval' });
    await registry.beginPendingLaunch(id, {
      provider: 'codex', providerSessionId: null, providerLaunchedAt: 't', previousStatus: 'ready', previousTurnPhase: 'awaiting_approval',
      launchProfile: { ...CLAUDE_PROFILE, id: 'native:codex', provider: 'codex' },
    });
    expect(await registry.rollbackPendingLaunch(id, 'failed')).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
  });
});

describe('runtime_left_ready', () => {
  it('clears what the ended turn left behind once reconcile finds the tmux gone, keeping a lifecycle error', async () => {
    const { id } = await registry.createSession('/p', 'proj-1');
    const prompt = { kind: 'tool_permission' as const, toolUseId: 't1', toolName: 'Bash', input: {}, detectedAt: 'x' };
    await registry.updateSession(id, { status: 'ready', turnPhase: 'awaiting_approval', pendingInteraction: prompt, stuckSince: 'T', paneActivity: 'busy' });
    const [died] = await registry.markDeadUnlessRunning(new Set());
    const cleared = await turnEffects.applyRuntimeLeftReady(died!);
    expect(cleared).toMatchObject({ status: 'dead', pendingInteraction: null, stuckSince: null, lastError: null, paneActivity: 'unknown' });

    await registry.updateSession(id, { lastError: 'tmux 已結束' });
    const again = await registry.getSession(id);
    expect(await turnEffects.applyRuntimeLeftReady(again!)).toBe(again); // nothing left: no write
    expect((await registry.getSession(id))?.lastError).toBe('tmux 已結束');
  });
});

// The derivation as it was before the split, from the six-value status —
// copied verbatim so the new one is checked against it, not against itself.
function preSplitActivity(session: { status: LegacySessionStatus; claudeClearPending: unknown; lastError: string | null; paneActivity?: PaneActivity }): SessionActivity {
  if (session.status === 'dead') return 'ended';
  if (session.claudeClearPending || session.status === 'launching') return 'starting';
  if (session.status === 'idle') return 'not_started';
  if (session.status === 'needs_interaction') return 'awaiting_approval';
  if (session.lastError === STUCK_HINT_TEXT) return 'stalled';
  if (session.status === 'waiting' && session.paneActivity !== 'idle') return 'busy';
  return 'idle';
}

describe('public compatibility', () => {
  const statuses: SessionStatus[] = ['idle', 'launching', 'ready', 'dead'];
  const phases: (TurnPhase | undefined)[] = ['idle', 'replying', 'awaiting_approval', undefined];
  const clearPending = {
    attemptId: 'a', conversationId: 'c1', newProviderSessionId: 'u', launchArgv: [], startedAt: 't',
    previousStatus: 'ready' as const, phase: 'waiting_exit' as const, launchStartedAt: null,
  };
  const base: ManagedSession = storedRecord('s', 'idle') as unknown as ManagedSession;

  const cases = statuses.flatMap((status) => phases.map((turnPhase) => [status, turnPhase] as const));

  it.each(cases)('status %s × turnPhase %s: legacy status and activity match the pre-split derivation', (status, turnPhase) => {
    const legacy: LegacySessionStatus = status !== 'ready' ? status
      : turnPhase === 'replying' ? 'waiting' : turnPhase === 'awaiting_approval' ? 'needs_interaction' : 'ready';
    for (const claudeClearPending of [null, clearPending]) {
      // The stuck hint was lastError's text before it became stuckSince.
      for (const [lastError, stuckSince] of [[null, null], [null, 'T'], ['another error', null]] as const) {
        for (const paneActivity of [undefined, 'unknown', 'busy', 'idle'] as const) {
          const session: ManagedSession = { ...base, status, turnPhase, clearPending: claudeClearPending, lastError, stuckSince, paneActivity };
          const dto = toPublicManagedSession(session);
          const legacyLastError = stuckSince ? STUCK_HINT_TEXT : lastError;
          expect(dto.status).toBe(legacy);
          expect(dto.lastError).toBe(legacyLastError);
          expect(dto.turnPhase).toBe(status === 'ready' ? (turnPhase ?? 'idle') : null);
          expect(dto.activity).toBe(preSplitActivity({ status: legacy, claudeClearPending, lastError: legacyLastError, paneActivity }));
          expect(deriveSessionActivity(session)).toBe(dto.activity);
        }
      }
    }
  });
});

// Structural rather than behavioural: "nothing else writes turnPhase" is a
// property of the source — no behaviour test can show a stray write doesn't
// exist somewhere it didn't exercise. So every `turnPhase:` / `turnPhase =`
// in src is located and checked against the few places allowed to write it.
describe('turnPhase write sites', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  // Enclosing top-level declaration (function or type) of each site.
  const ALLOWED: Record<string, string[]> = {
    // enter_phase: the only change of phase.
    'sync/turnEffects.ts': ['applyTurnEffects'],
    // The reset/restore on a lifecycle move, the load migration, a new session.
    'registry.ts': ['createSession'],
    'registry/lifecycle.ts': ['lifecycleTransition'],
    'registry/migrations.ts': ['splitLegacyStatus', 'migrateTurnPhase'],
    // The field itself, and the public projection (a read).
    'types.ts': ['SessionCore'],
    'session-dto.ts': ['toSessionDto'],
    // The DTO's declaration in the shared contract.
    'contract/sessions.ts': ['SessionDto'],
  };

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
      ? sourceFiles(path.join(dir, entry.name))
      : Promise.resolve(entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [])));
    return nested.flat();
  }

  it('only enter_phase, the lifecycle helper, the migration and createSession write it', async () => {
    const found: Record<string, string[]> = {};
    for (const file of await sourceFiles(srcDir)) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      let owner = '(module)';
      for (const line of (await readFile(file, 'utf-8')).split('\n')) {
        const declaration = /^(?:export )?(?:async )?(?:function|type|const) (\w+)/.exec(line);
        if (declaration) owner = declaration[1]!;
        if (/\bturnPhase\??\s*(?::|=(?!=))/.test(line)) (found[rel] ??= []).push(owner);
      }
    }
    for (const [file, owners] of Object.entries(found)) {
      expect(ALLOWED[file], `turnPhase written in ${file}`).toBeDefined();
      for (const owner of owners) expect(ALLOWED[file], `turnPhase written in ${file} ${owner}`).toContain(owner);
    }
    // And enter_phase really is where applyTurnEffects writes it.
    const effects = await readFile(path.join(srcDir, 'sync/turnEffects.ts'), 'utf-8');
    expect(effects.match(/turnPhase\s*=(?!=)/g)).toEqual(['turnPhase =']);
    expect(effects).toMatch(/case 'enter_phase':\s*\n\s*sessionPatch\.turnPhase = effect\.phase;/);
  });
});
