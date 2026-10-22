import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PendingInteraction, type Turn } from '../src/types.js';
import { toPublicManagedSession } from '../src/session-dto.js';
import type { CapabilityResult, TranscriptLookupResult } from '../src/providers/types.js';
import { readClaudeInteraction } from '../src/providers/claude-interaction.js';
import { POLL_INTERVAL_MS, RUNTIME_DEAD_STABILITY_MS, RUNTIME_STARTUP_GRACE_MS, RUNTIME_IDENTITY_WARN_AFTER_MS, TRANSCRIPT_NOT_FOUND_GRACE_MS } from '../src/config.js';
import { recordSend } from '../src/sync/delivery.js';
import { diffTurns, keepsEveryPart, revisedTurns, selectNewTurns } from '../src/sync/turns.js';

const getPaneLiveness = vi.fn<() => Promise<'alive' | 'dead' | 'unknown'>>();
const sessionExists = vi.fn<() => Promise<boolean>>();
const capturePane = vi.fn<() => Promise<string>>();
const getPaneRuntimePid = vi.fn<() => Promise<number | null>>();
// Which tmux sessions exist; by default every one the registry records.
const listManagedSessionNames = vi.fn<(alsoOwned?: ReadonlySet<string>) => Promise<string[]>>();
vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: (...args: unknown[]) => listManagedSessionNames(...(args as [ReadonlySet<string>?])),
  getPaneLiveness: (...args: unknown[]) => getPaneLiveness(...(args as [])),
  getPaneRuntimePid: (...args: unknown[]) => getPaneRuntimePid(...(args as [])),
  sessionExists: (...args: unknown[]) => sessionExists(...(args as [])),
  capturePane: (...args: unknown[]) => capturePane(...(args as [])),
}));

const findPendingInteraction = vi.fn<() => Promise<CapabilityResult<PendingInteraction | null>>>();
const parseTurns = vi.fn<(file: string) => Promise<Turn[]>>();
const parseMessages = vi.fn<() => Promise<{ role: 'user' | 'assistant'; text: string; ts: string | null }[]>>();
const locateSessionFile = vi.fn<() => Promise<TranscriptLookupResult>>();
const isTurnComplete = vi.fn<() => Promise<CapabilityResult<boolean>>>();
const parseCompactionSummaryTimes = vi.fn<() => Promise<string[]>>();
const openTurnAtEnd = vi.fn<() => Promise<import('../src/providers/types.js').OpenTurn | null>>();
// Pane reading is opt-in per test: most tests exercise the transcript-only
// behavior, which is also what an adapter without pane reading gets.
let paneReading = false;
let continuationSupported = true;
// Within pane reading, whether the adapter can also recognize an idle pane
// (Claude can; this lets a test model one that can't).
let paneIdleReading = true;
const paneShowsPermissionPrompt = vi.fn<(pane: string) => boolean>();
const paneShowsBusy = vi.fn<(pane: string) => boolean>();
const followContinuation = vi.fn<(file: string) => Promise<{ file: string; providerSessionId: string } | null>>();
const paneShowsIdle = vi.fn<(pane: string) => boolean>();
// One fake transcript adapter stands in for every runtime; each test drives
// it through the mocks above.
function fakeTranscript() {
  return {
    name: 'claude' as const,
    locateSessionFile: (...args: unknown[]) => locateSessionFile(...(args as [])),
    parseTurns: (...args: unknown[]) => parseTurns(...(args as [string])),
    parseMessages: (...args: unknown[]) => parseMessages(...(args as [])),
    findPendingInteraction: (...args: unknown[]) => findPendingInteraction(...(args as [])),
    isTurnComplete: (...args: unknown[]) => isTurnComplete(...(args as [])),
    parseCompactionSummaryTimes: () => parseCompactionSummaryTimes(),
    openTurnAtEnd: () => openTurnAtEnd(),
    ...(continuationSupported ? { followContinuation: (file: string) => followContinuation(file) } : {}),
    ...(paneReading ? {
      paneShowsPermissionPrompt: (pane: string) => paneShowsPermissionPrompt(pane),
      paneShowsBusy: (pane: string) => paneShowsBusy(pane),
      ...(paneIdleReading ? { paneShowsIdle: (pane: string) => paneShowsIdle(pane) } : {}),
      readPaneInteraction: readClaudeInteraction,
    } : {}),
  };
}

type IdentityObservation = import('../src/runtimes/types.js').IdentityObservation;
const observeIdentity = vi.fn<(input: { pid: number; profile: { home?: string } }) => Promise<IdentityObservation>>();
vi.mock('../src/runtimes/index.js', async () => {
  const { readAgyStartupPrompt } = await vi.importActual<typeof import('../src/runtimes/agy.js')>('../src/runtimes/agy.js');
  const { readCodexStartupPrompt, readCodexResumeConflict } = await vi.importActual<typeof import('../src/runtimes/codex-cli.js')>('../src/runtimes/codex-cli.js');
  const providerForRuntime = (runtimeId: string) => runtimeId === 'claude-code' ? 'claude' : runtimeId === 'codex-cli' ? 'codex' : 'gemini';
  // The real catalog helpers (e.g. which provider has a usage source, read by
  // the session DTO); only the drivers polling calls are faked.
  const actual = await vi.importActual<typeof import('../src/runtimes/index.js')>('../src/runtimes/index.js');
  return {
    ...actual,
    runtimeForProvider: (provider: string) => provider === 'claude' ? 'claude-code' : provider === 'codex' ? 'codex-cli' : 'gemini-cli',
    getRuntimeDriver: (runtimeId: string) => ({
      ...fakeTranscript(),
      provider: providerForRuntime(runtimeId),
      runtimeId,
      processIdentity: { commands: [runtimeId === 'codex-cli' ? 'codex' : 'claude'], wrappers: [] },
      identity: runtimeId === 'codex-cli'
        ? { kind: 'observed_after_start', observe: (input: { pid: number; profile: { home?: string } }) => observeIdentity(input) }
        : { kind: 'pinned_at_launch' },
      ...(runtimeId === 'agy' ? { readStartupPrompt: readAgyStartupPrompt } : {}),
      ...(runtimeId === 'codex-cli' ? { readStartupPrompt: readCodexStartupPrompt } : {}),
      // As the real drivers: Claude Code and Codex reopen a conversation in place.
      resume: runtimeId === 'claude-code' || runtimeId === 'codex-cli' ? { kind: 'in_place' } : { kind: 'unsupported', reason: 'not validated' },
      ...(runtimeId === 'codex-cli' ? { resumeConflict: { detect: readCodexResumeConflict, dismissKey: 'Escape' } } : {}),
      buildResume: (providerSessionId: string) => ({ argv: [runtimeId, '--resume', providerSessionId], providerSessionId }),
    }),
  };
});

const pendingResult = (value: PendingInteraction | null = null) => ({ status: 'supported' as const, value });
const completionResult = (value = true) => ({ status: 'supported' as const, value });

vi.mock('../src/dialogue-store.js', () => ({
  upsertTurn: vi.fn(async () => {}),
}));

let statMtime = 1;
let statFails = false;
// Files that are gone while the rest stay readable (a transcript the CLI moved).
const missingFiles = new Set<string>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (file: string) => {
      if (statFails || missingFiles.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: statMtime, size: statMtime };
    }),
  };
});

let stateDir: string;
let registry: typeof import('../src/registry.js');
let polling: typeof import('../src/polling.js');

beforeEach(async () => {
  vi.resetModules();
  findPendingInteraction.mockReset();
  parseTurns.mockReset();
  parseMessages.mockReset();
  parseMessages.mockResolvedValue([]);
  parseCompactionSummaryTimes.mockReset();
  parseCompactionSummaryTimes.mockResolvedValue([]);
  openTurnAtEnd.mockReset();
  openTurnAtEnd.mockResolvedValue(null);
  getPaneLiveness.mockReset();
  sessionExists.mockReset();
  sessionExists.mockResolvedValue(true);
  isTurnComplete.mockReset();
  isTurnComplete.mockResolvedValue(completionResult()); // most tests aren't exercising the mid-turn gate itself
  // Safe default for every test that does not exercise liveness.
  getPaneLiveness.mockResolvedValue('unknown');
  getPaneRuntimePid.mockReset();
  getPaneRuntimePid.mockResolvedValue(null);
  listManagedSessionNames.mockReset();
  listManagedSessionNames.mockImplementation(async (alsoOwned) => [...(alsoOwned ?? [])]);
  observeIdentity.mockReset();
  locateSessionFile.mockReset();
  paneReading = false;
  continuationSupported = true;
  capturePane.mockReset();
  followContinuation.mockReset();
  followContinuation.mockResolvedValue(null);
  capturePane.mockResolvedValue('');
  paneShowsPermissionPrompt.mockReset();
  paneShowsBusy.mockReset();
  paneIdleReading = true;
  paneShowsIdle.mockReset();
  statMtime = 1;
  statFails = false;
  missingFiles.clear();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-polling-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  registry = await import('../src/registry.js');
  polling = await import('../src/polling.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function makeWaitingSession(provider: 'claude' | 'codex' | 'gemini' = 'claude'): Promise<string> {
  const session = await registry.createSession('/some/project', 'proj-1');
  const launchedAt = new Date().toISOString();
  await registry.commitConversationLaunch(session.id, {
    provider, providerSessionId: provider === 'claude' ? 'pinned-session' : null, providerLaunchedAt: launchedAt, launchProfile: null,
  });
  locateSessionFile.mockResolvedValue({ status: 'resolved', file: '/fake/session.jsonl', identity: provider === 'claude' ? 'pinned_id' : 'verified_metadata' });
  await registry.updateSession(session.id, {
    status: 'ready',
    turnPhase: 'replying',
    lastUserMessageAt: new Date().toISOString(),
  });
  return session.id;
}

async function setTranscript(sessionId: string, file: string, turns: Turn[] = []): Promise<void> {
  const session = await registry.getSession(sessionId);
  const conversation = session?.conversations?.find((candidate) => candidate.id === session.activeConversationId);
  if (!conversation) throw new Error('missing active conversation fixture');
  await registry.updateConversation(sessionId, conversation.id, {
    transcript: { state: 'resolved', file, identity: 'pinned_id' }, turns,
  });
}

describe('polling.tick — explicit Claude resume recovery', () => {
  async function makePendingResume(simulateRestart = true, startedAt = '2026-01-02T00:00:00Z') {
    const session = await registry.createSession('/some/project', 'proj-1');
    const sessionId = 'a13782f4-715f-4abc-9233-2207319a1234';
    const launch = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: sessionId, providerLaunchedAt: '2026-01-01T00:00:00Z',
      launchProfile: { id: 'native:claude', provider: 'claude', source: 'native', home: '/private/claude', conversationRoot: '/private/claude/projects', delegate: { kind: 'native', executable: 'claude' } },
    });
    const conversationId = launch?.activeConversationId as string;
    const existingTurn = { index: 1, user: { text: 'old', at: 'u' }, assistant: { text: 'kept', at: 'a' } };
    await registry.updateConversation(session.id, conversationId, {
      transcript: { state: 'resolved', file: `/private/claude/projects/proj/${sessionId}.jsonl`, identity: 'pinned_id' },
      turns: [existingTurn],
    });
    await registry.updateSession(session.id, { status: 'dead' });
    await registry.beginPendingResume(session.id, { attemptId: 'resume-attempt', conversationId, startedAt });
    if (simulateRestart) registry.__resetForTests(); // API process restart; only durable state remains
    return { id: session.id, conversationId, existingTurn };
  }

  it('does not roll back a resume reservation while its HTTP request owns pre-dispatch', async () => {
    const { id, conversationId } = await makePendingResume(false);
    const current = await registry.getSession(id);
    expect(current?.resumePending?.attemptId).toBe('resume-attempt');

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({
      status: 'launching', activeConversationId: conversationId,
      resumePending: { attemptId: 'resume-attempt' },
    });
    expect(sessionExists).not.toHaveBeenCalled();
    expect(getPaneLiveness).not.toHaveBeenCalled();
  });

  it('commits an already-running resumed Claude without creating a segment or re-sending a command', async () => {
    const { id, conversationId, existingTurn } = await makePendingResume();
    sessionExists.mockResolvedValueOnce(true);
    getPaneLiveness.mockResolvedValueOnce('alive');

    await polling.tick();

    const recovered = await registry.getSession(id);
    expect(recovered).toMatchObject({ status: 'ready', activeConversationId: conversationId, resumePending: null });
    expect(recovered?.conversations).toHaveLength(1);
    expect(recovered?.conversations?.[0]?.turns).toEqual([existingTurn]);
  });

  it('rolls back when tmux disappeared and leaves the original conversation readable', async () => {
    const { id, conversationId, existingTurn } = await makePendingResume();
    sessionExists.mockResolvedValueOnce(false);

    await polling.tick();

    const recovered = await registry.getSession(id);
    expect(recovered).toMatchObject({ status: 'dead', activeConversationId: conversationId, resumePending: null });
    expect(recovered?.conversations?.[0]?.turns).toEqual([existingTurn]);
    expect(getPaneLiveness).not.toHaveBeenCalled();
  });

  it('survives an API restart before Claude execs, then rolls back only after grace and stable dead liveness', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date().toISOString();
      const startMs = Date.parse(startedAt);
      const { id, conversationId, existingTurn } = await makePendingResume(true, startedAt);
      sessionExists.mockResolvedValue(true);
      getPaneLiveness.mockResolvedValue('dead'); // The pane is still at its shell after Enter.

      await polling.tick();
      expect(await registry.getSession(id)).toMatchObject({
        status: 'launching', activeConversationId: conversationId,
        resumePending: { attemptId: 'resume-attempt', startedAt },
      });

      vi.setSystemTime(startMs + RUNTIME_STARTUP_GRACE_MS + 1);
      await polling.tick();
      expect(await registry.getSession(id)).toMatchObject({
        status: 'launching', resumePending: { attemptId: 'resume-attempt' },
      });

      vi.setSystemTime(startMs + RUNTIME_STARTUP_GRACE_MS + RUNTIME_DEAD_STABILITY_MS + 1);
      await polling.tick();
      expect(await registry.getSession(id)).toMatchObject({
        status: 'dead', activeConversationId: conversationId, resumePending: null,
      });
      expect((await registry.getSession(id))?.conversations?.[0]?.turns).toEqual([existingTurn]);
      const tmuxCli = await import('../src/tmux.js');
      expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an unknown pending resume claimed and never tries to send the resume command again', async () => {
    const { id, conversationId } = await makePendingResume();
    sessionExists.mockResolvedValueOnce(true);
    getPaneLiveness.mockResolvedValueOnce('unknown');

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'launching', activeConversationId: conversationId, resumePending: { attemptId: 'resume-attempt' } });
  });

  it('continues importing appended turns into the same resumed conversation without duplicating its history', async () => {
    const id = await makeWaitingSession();
    const oldTurn = { index: 1, user: { text: 'before reboot', at: 'u1' }, assistant: { text: 'old answer', at: 'a1' } };
    const newTurn = { index: 2, user: { text: 'after resume', at: 'u2' }, assistant: { text: 'new answer', at: 'a2' } };
    await setTranscript(id, '/fake/session.jsonl', [oldTurn]);
    parseTurns.mockResolvedValue([oldTurn, newTurn]);
    findPendingInteraction.mockResolvedValue(pendingResult());

    await polling.tick();
    await polling.tick();

    const recovered = await registry.getSession(id);
    expect(recovered?.conversations).toHaveLength(1);
    expect(recovered?.conversations?.[0]?.turns).toEqual([oldTurn, newTurn]);
    const dialogueStore = await import('../src/dialogue-store.js');
    expect(dialogueStore.upsertTurn).toHaveBeenCalledTimes(1);
    expect(dialogueStore.upsertTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: recovered?.activeConversationId }), newTurn);
  });
});

describe('polling.tick — after a moved transcript was followed by its session id', () => {
  it('reads the new path on the next tick and imports none of the turns it already has', async () => {
    const id = await makeWaitingSession();
    const turns = [
      { index: 1, user: { text: 'one', at: '2026-01-01T00:00:00Z' }, assistant: { text: 'a', at: '2026-01-01T00:00:01Z' } },
      { index: 2, user: { text: 'two', at: '2026-01-01T00:01:00Z' }, assistant: { text: 'b', at: '2026-01-01T00:01:01Z' } },
    ];
    await setTranscript(id, '/old/project/pinned-session.jsonl', turns);
    const before = (await registry.getSession(id))!;
    const conversation = before.conversations!.find((candidate) => candidate.id === before.activeConversationId)!;
    const { recordMovedTranscript } = await import('../src/services/transitions.js');

    // What recovering / switching records once verifyResumable found the
    // same session id at another path: one write.
    await recordMovedTranscript(before, conversation, '/worktree/project/pinned-session.jsonl');
    const moved = (await registry.getSession(id))!;
    expect(moved).toMatchObject({
      providerSessionFile: '/worktree/project/pinned-session.jsonl',
      turnsSourceFile: '/worktree/project/pinned-session.jsonl',
    });
    expect(moved.conversations![0]!.transcript).toEqual({ state: 'resolved', identity: 'pinned_id', file: '/worktree/project/pinned-session.jsonl' });

    parseTurns.mockResolvedValue(turns);
    findPendingInteraction.mockResolvedValue(pendingResult());
    await polling.tick();
    await polling.tick();

    expect(parseTurns).toHaveBeenCalledWith('/worktree/project/pinned-session.jsonl');
    expect((await registry.getSession(id))?.conversations?.[0]?.turns).toHaveLength(2);
    const dialogueStore = await import('../src/dialogue-store.js');
    expect(dialogueStore.upsertTurn).not.toHaveBeenCalled();
  });
});

describe('polling.tick — switching to an earlier conversation in the same tmux', () => {
  const OLD_ID = 'c13782f4-715f-4abc-9233-2207319a1234';
  const NEW_ID = 'd23782f4-715f-4abc-9233-2207319a1234';
  const profile = {
    id: 'native:claude', provider: 'claude' as const, source: 'native' as const,
    home: '/private/claude', conversationRoot: '/private/claude/projects',
    delegate: { kind: 'native' as const, executable: 'claude' },
  };

  // #1 (ended, resumable) and #2 (running) in one tmux; switch back to #1.
  async function beginSwitch(phase: 'waiting_exit' | 'awaiting_force' = 'waiting_exit', exitRequestedAt = new Date().toISOString()) {
    const session = await registry.createSession('/some/project', 'proj-1');
    const first = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: OLD_ID, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: profile,
    });
    const targetId = first?.activeConversationId as string;
    const oldTurn = { index: 1, user: { text: 'first question', at: '2026-01-01T00:01:00Z' }, assistant: { text: 'first answer', at: '2026-01-01T00:02:00Z' } };
    await registry.updateConversation(session.id, targetId, {
      turns: [oldTurn], transcript: { state: 'resolved', file: '/private/claude/projects/p/' + OLD_ID + '.jsonl', identity: 'pinned_id' },
    });
    const second = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: NEW_ID, providerLaunchedAt: '2026-01-02T00:00:00Z', launchProfile: profile,
    });
    const leavingId = second?.activeConversationId as string;
    const claimed = await registry.beginConversationSwitch(session.id, {
      attemptId: 'switch-attempt', conversationId: leavingId, targetConversationId: targetId,
      newProviderSessionId: OLD_ID, launchArgv: ['claude', '--resume', OLD_ID],
      startedAt: exitRequestedAt, previousStatus: 'ready', phase, launchStartedAt: null,
      exitProvider: 'claude', exitRequestedAt,
    });
    expect(claimed).toBeTruthy();
    registry.releaseClearAttempt(session.id, 'switch-attempt');
    return { id: session.id, targetId, leavingId, oldTurn };
  }

  it('resumes the target once the running CLI has exited, reopening it in place instead of adding a segment', async () => {
    const { id, targetId, leavingId, oldTurn } = await beginSwitch();
    const tmux = await import('../src/tmux.js');
    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick();
    expect(tmux.sendCommandLine).toHaveBeenCalledTimes(1);
    expect(tmux.sendCommandLine).toHaveBeenCalledWith(registry.tmuxNameFor(id), ['claude', '--resume', OLD_ID]);

    getPaneLiveness.mockResolvedValueOnce('alive');
    await polling.tick();

    const result = await registry.getSession(id);
    expect(result).toMatchObject({ status: 'ready', provider: 'claude', providerSessionId: OLD_ID, activeConversationId: targetId, clearPending: null });
    expect(result?.conversations).toHaveLength(2);
    const target = result?.conversations?.find((c) => c.id === targetId);
    const leaving = result?.conversations?.find((c) => c.id === leavingId);
    expect(target).toMatchObject({ endedAt: null, endReason: null, turns: [oldTurn] });
    expect(leaving).toMatchObject({ endedAt: expect.any(String), endReason: 'relaunch' });
    expect(tmux.sendCommandLine).toHaveBeenCalledTimes(1);
  });

  it('rebinds the session runtime to Claude after switching away from a running Codex, so liveness keeps being checked', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const first = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: OLD_ID, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: profile,
    });
    const targetId = first?.activeConversationId as string;
    await registry.updateConversation(session.id, targetId, {
      transcript: { state: 'resolved', file: '/private/claude/projects/p/' + OLD_ID + '.jsonl', identity: 'pinned_id' },
    });
    const codex = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: '2026-01-02T00:00:00Z',
      launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/private/codex', conversationRoot: '/private/codex/sessions', delegate: { kind: 'native', executable: 'codex' } },
    });
    expect(codex?.runtimeId).toBe('codex-cli');
    await registry.beginConversationSwitch(session.id, {
      attemptId: 'switch-from-codex', conversationId: codex?.activeConversationId as string, targetConversationId: targetId,
      newProviderSessionId: OLD_ID, launchArgv: ['claude', '--resume', OLD_ID],
      startedAt: new Date().toISOString(), previousStatus: 'ready', phase: 'waiting_exit', launchStartedAt: null,
      exitProvider: 'codex', exitRequestedAt: new Date().toISOString(),
    });
    registry.releaseClearAttempt(session.id, 'switch-from-codex');

    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick();
    getPaneLiveness.mockResolvedValueOnce('alive');
    await polling.tick();
    expect(await registry.getSession(session.id)).toMatchObject({ provider: 'claude', runtimeId: 'claude-code', activeConversationId: targetId });

    // The resumed Claude exiting is noticed again (it was silently skipped
    // while the session still said codex-cli).
    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick();
    const ended = await registry.getSession(session.id);
    expect(ended).toMatchObject({ provider: null, activeConversationId: null });
    expect(ended?.conversations?.find((c) => c.id === targetId)?.endReason).toBe('cli_exit');
  });

  it('confirms the resumed Claude by its own process, not the Codex it replaced', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const first = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: OLD_ID, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: profile,
    });
    const targetId = first?.activeConversationId as string;
    await registry.updateConversation(session.id, targetId, {
      transcript: { state: 'resolved', file: '/private/claude/projects/p/' + OLD_ID + '.jsonl', identity: 'pinned_id' },
    });
    const codex = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: '2026-01-02T00:00:00Z',
      launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/private/codex', conversationRoot: '/private/codex/sessions', delegate: { kind: 'native', executable: 'codex' } },
    });
    await registry.beginConversationSwitch(session.id, {
      attemptId: 'switch-from-codex', conversationId: codex?.activeConversationId as string, targetConversationId: targetId,
      newProviderSessionId: OLD_ID, launchArgv: ['claude', '--resume', OLD_ID],
      startedAt: new Date().toISOString(), previousStatus: 'ready', phase: 'waiting_exit', launchStartedAt: null,
      exitProvider: 'codex', exitRequestedAt: new Date().toISOString(),
    });
    registry.releaseClearAttempt(session.id, 'switch-from-codex');
    // Like tmux: a pane running claude is only 'alive' to someone looking
    // for claude; looking for codex it is an unknown process.
    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick();
    expect((await registry.getSession(session.id))?.clearPending?.phase).toBe('launching');
    getPaneLiveness.mockImplementation(async (...args: unknown[]) => {
      const expected = args[1] as { commands: string[] };
      return expected.commands.includes('claude') ? 'alive' : 'unknown';
    });

    await polling.tick();

    expect(await registry.getSession(session.id)).toMatchObject({ provider: 'claude', activeConversationId: targetId, clearPending: null });
  });

  it('asks the user (awaiting_force) instead of waiting forever when the old CLI does not exit in time', async () => {
    const { id } = await beginSwitch('waiting_exit', new Date(Date.now() - 60_000).toISOString());
    const tmux = await import('../src/tmux.js');
    getPaneLiveness.mockResolvedValue('alive');
    await polling.tick();
    expect((await registry.getSession(id))?.clearPending?.phase).toBe('awaiting_force');
    await polling.tick();
    expect(tmux.sendCommandLine).not.toHaveBeenCalled();
  });

  it('keeps waiting (no prompt yet) while the exit is still within its timeout', async () => {
    const { id } = await beginSwitch();
    getPaneLiveness.mockResolvedValue('alive');
    await polling.tick();
    expect((await registry.getSession(id))?.clearPending?.phase).toBe('waiting_exit');
  });

  it('launches after the user allowed the forced reset and the pane is back at a shell', async () => {
    const { id } = await beginSwitch('awaiting_force');
    const tmux = await import('../src/tmux.js');
    await registry.setPendingExitPhase(id, 'switch-attempt', 'awaiting_force', 'waiting_exit');
    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick();
    expect(tmux.sendCommandLine).toHaveBeenCalledWith(registry.tmuxNameFor(id), ['claude', '--resume', OLD_ID]);
  });

  it('leaves the target ended and the tmux idle when the resumed Claude never comes up', async () => {
    const { id, targetId, leavingId } = await beginSwitch();
    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick();
    const launching = await registry.getSession(id);
    await registry.updateSession(id, {
      clearPending: { ...launching!.clearPending!, launchStartedAt: new Date(Date.now() - RUNTIME_STARTUP_GRACE_MS - 1000).toISOString() },
    });
    getPaneLiveness.mockResolvedValue('dead');
    await polling.tick();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RUNTIME_DEAD_STABILITY_MS + 1000);
    await polling.tick();
    vi.restoreAllMocks();

    const result = await registry.getSession(id);
    expect(result).toMatchObject({ status: 'idle', provider: null, activeConversationId: null, clearPending: null });
    expect(result?.conversations?.find((c) => c.id === targetId)?.endedAt).not.toBeNull();
    expect(result?.conversations?.find((c) => c.id === leavingId)).toMatchObject({ endReason: 'relaunch' });
  });

  it('refuses to claim a switch to the conversation that is already running', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: OLD_ID, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: profile,
    });
    const activeId = launched?.activeConversationId as string;
    await registry.updateConversation(session.id, activeId, { transcript: { state: 'resolved', file: '/x.jsonl', identity: 'pinned_id' } });
    await registry.updateSession(session.id, { status: 'ready', turnPhase: 'idle' });
    const claimed = await registry.beginConversationSwitch(session.id, {
      attemptId: 'x', conversationId: activeId, targetConversationId: activeId, newProviderSessionId: OLD_ID,
      launchArgv: ['claude', '--resume', OLD_ID], startedAt: 'now', previousStatus: 'ready', phase: 'waiting_exit', launchStartedAt: null,
    });
    expect(claimed).toBeNull();
  });
});

describe('polling.tick — reopening a Codex conversation (identity observed after start)', () => {
  const THREAD = '01a10a0a-577d-78f0-b390-d594bfdf9eac';
  const OTHER = '01a10a04-6d0c-7e82-8678-5bd980cdb65b';
  const codexProfile = {
    id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, source: 'native' as const,
    home: '/private/codex', conversationRoot: '/private/codex/sessions', delegate: { kind: 'native' as const, executable: 'codex' },
  };
  const claudeProfile = {
    id: 'native:claude', provider: 'claude' as const, source: 'native' as const,
    home: '/private/claude', conversationRoot: '/private/claude/projects', delegate: { kind: 'native' as const, executable: 'claude' },
  };
  const CONFLICT = '  🔒  This conversation is open in another app        r to retry\n      Close it there and press R to continue here.\n   r retry   f fork   esc/ctrl+c/q exit   ctrl+t transcript\n';
  const oldTurn = { index: 1, user: { text: 'q', at: '2026-01-01T00:01:00Z' }, assistant: { text: 'a', at: '2026-01-01T00:02:00Z' } };

  // A Codex conversation (#1) left for a Claude one (#2); switch back to #1.
  async function switchBackToCodex() {
    const session = await registry.createSession('/some/project', 'proj-1');
    const first = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: codexProfile,
    });
    const targetId = first?.activeConversationId as string;
    await registry.updateConversation(session.id, targetId, {
      providerSessionId: THREAD, turns: [oldTurn],
      transcript: { state: 'resolved', file: `/private/codex/sessions/2026/01/01/rollout-x-${THREAD}.jsonl`, identity: 'verified_metadata' },
    }, { providerSessionId: THREAD });
    const second = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: 'c13782f4-715f-4abc-9233-2207319a1234', providerLaunchedAt: '2026-01-02T00:00:00Z', launchProfile: claudeProfile,
    });
    const argv = ['codex', 'resume', '--no-daemon', '-C', '/some/project', THREAD];
    await registry.beginConversationSwitch(session.id, {
      attemptId: 'switch-to-codex', conversationId: second?.activeConversationId as string, targetConversationId: targetId,
      newProviderSessionId: THREAD, launchArgv: argv, startedAt: new Date().toISOString(), previousStatus: 'ready',
      phase: 'waiting_exit', launchStartedAt: null, exitProvider: 'claude', exitRequestedAt: new Date().toISOString(),
    });
    registry.releaseClearAttempt(session.id, 'switch-to-codex');
    getPaneLiveness.mockResolvedValueOnce('dead');
    await polling.tick(); // the Claude has exited: the resume command goes out
    const tmux = await import('../src/tmux.js');
    expect(tmux.sendCommandLine).toHaveBeenCalledWith(registry.tmuxNameFor(session.id), argv);
    getPaneLiveness.mockResolvedValue('alive');
    getPaneRuntimePid.mockResolvedValue(4242);
    return { id: session.id, targetId };
  }

  it('commits the switch only once the pane holds that very thread', async () => {
    const { id, targetId } = await switchBackToCodex();
    observeIdentity.mockResolvedValue({ status: 'pending', reason: 'codex_home_unavailable' });
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ clearPending: { phase: 'launching' } });

    observeIdentity.mockResolvedValue({ status: 'resolved', providerSessionId: THREAD, evidence: 'process_thread_lock' });
    await polling.tick();
    const result = await registry.getSession(id);
    expect(result).toMatchObject({ status: 'ready', provider: 'codex', providerSessionId: THREAD, activeConversationId: targetId, clearPending: null });
    expect(result?.conversations?.find((c) => c.id === targetId)).toMatchObject({ endedAt: null, turns: [oldTurn] });
  });

  it('leaves the "open in another app" screen with Escape and fails the switch, typing nothing', async () => {
    const { id, targetId } = await switchBackToCodex();
    observeIdentity.mockResolvedValue({ status: 'unobservable', reason: 'holds 0 thread locks (need exactly 1)' });
    capturePane.mockResolvedValue(CONFLICT);
    await polling.tick();
    const tmux = await import('../src/tmux.js');
    expect(tmux.sendKey).toHaveBeenCalledWith(registry.tmuxNameFor(id), 'Escape');
    expect(tmux.sendText).not.toHaveBeenCalled();
    const result = await registry.getSession(id);
    expect(result).toMatchObject({ status: 'idle', provider: null, clearPending: null, lastError: expect.stringContaining('其他地方開啟') });
    expect(result?.conversations?.find((c) => c.id === targetId)?.turns).toEqual([oldTurn]);
  });

  it('fails a switch whose CLI came up on another thread', async () => {
    const { id } = await switchBackToCodex();
    observeIdentity.mockResolvedValue({ status: 'resolved', providerSessionId: OTHER, evidence: 'process_thread_lock' });
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ provider: null, clearPending: null, lastError: expect.stringContaining('不是這段對話') });
  });

  it('recovers a dead tmux\'s Codex conversation only once the pane holds its thread', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launch = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: codexProfile,
    });
    const conversationId = launch?.activeConversationId as string;
    await registry.updateConversation(session.id, conversationId, {
      providerSessionId: THREAD, turns: [oldTurn],
      transcript: { state: 'resolved', file: `/private/codex/sessions/2026/01/01/rollout-x-${THREAD}.jsonl`, identity: 'verified_metadata' },
    }, { providerSessionId: THREAD });
    await registry.updateSession(session.id, { status: 'dead' });
    await registry.beginPendingResume(session.id, { attemptId: 'resume-codex', conversationId, startedAt: new Date().toISOString() });
    registry.__resetForTests();
    getPaneLiveness.mockResolvedValue('alive');
    getPaneRuntimePid.mockResolvedValue(4242);

    observeIdentity.mockResolvedValue({ status: 'pending', reason: 'x' });
    await polling.tick();
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'launching', resumePending: { attemptId: 'resume-codex' } });

    observeIdentity.mockResolvedValue({ status: 'resolved', providerSessionId: THREAD, evidence: 'process_thread_lock' });
    await polling.tick();
    const recovered = await registry.getSession(session.id);
    expect(recovered).toMatchObject({ status: 'ready', provider: 'codex', providerSessionId: THREAD, activeConversationId: conversationId, resumePending: null });
    expect(recovered?.conversations).toHaveLength(1);
  });
});

describe('polling.tick — controlled Claude clear restart', () => {
  async function beginClear(phase: 'waiting_exit' | 'launching' = 'waiting_exit', launchStartedAt: string | null = null) {
    const session = await registry.createSession('/some/project', 'proj-1');
    const oldId = 'a13782f4-715f-4abc-9233-2207319a1234';
    const profile = {
      id: 'native:claude', provider: 'claude' as const, source: 'native' as const,
      home: '/private/claude', conversationRoot: '/private/claude/projects',
      delegate: { kind: 'native' as const, executable: 'claude' },
    };
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'claude', providerSessionId: oldId, providerLaunchedAt: '2026-01-01T00:00:00Z', launchProfile: profile,
    });
    const oldConversationId = launched?.activeConversationId as string;
    const oldTurn = { index: 1, user: { text: 'before clear', at: 'u' }, assistant: { text: 'old answer', at: 'a' } };
    await registry.updateConversation(session.id, oldConversationId, { turns: [oldTurn] });
    await registry.beginPendingClear(session.id, {
      attemptId: 'clear-attempt', conversationId: oldConversationId,
      newProviderSessionId: 'b23782f4-715f-4abc-9233-2207319a1234',
      launchArgv: ['claude', '--session-id', 'b23782f4-715f-4abc-9233-2207319a1234'],
      startedAt: '2026-01-02T00:00:00Z', previousStatus: 'ready', phase, launchStartedAt,
    });
    registry.releaseClearAttempt(session.id, 'clear-attempt');
    return { id: session.id, oldConversationId, oldTurn };
  }

  it('hands the decision to the user, without re-sending anything, when the old CLI has not exited in time', async () => {
    const { id } = await beginClear(); // startedAt is long past the exit timeout
    const tmux = await import('../src/tmux.js');
    getPaneLiveness.mockResolvedValue('alive');

    await polling.tick();
    await polling.tick();

    // e.g. Codex 0.157.1 only interrupts on C-c while it works.
    const waiting = await registry.getSession(id);
    expect(waiting).toMatchObject({ status: 'launching', clearPending: { phase: 'awaiting_force' } });
    expect(tmux.sendCommandLine).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it('carries on once the old CLI is gone while awaiting the decision (exited by hand, or the pane was force-reset)', async () => {
    const { id } = await beginClear();
    const tmux = await import('../src/tmux.js');
    getPaneLiveness.mockResolvedValue('alive');
    await polling.tick();
    expect((await registry.getSession(id))?.clearPending?.phase).toBe('awaiting_force');

    getPaneLiveness.mockResolvedValue('dead');
    await polling.tick();
    await polling.tick();
    expect(tmux.sendCommandLine).toHaveBeenCalledTimes(1);
  });

  it('waits for the old Claude to exit before launching, then starts a separate segment with the pinned new ID', async () => {
    const { id, oldConversationId, oldTurn } = await beginClear();
    const tmux = await import('../src/tmux.js');
    getPaneLiveness.mockResolvedValueOnce('dead');

    await polling.tick();

    expect(tmux.sendCommandLine).toHaveBeenCalledTimes(1);
    expect(tmux.sendCommandLine).toHaveBeenCalledWith(registry.tmuxNameFor(id), ['claude', '--session-id', 'b23782f4-715f-4abc-9233-2207319a1234']);
    expect(await registry.getSession(id)).toMatchObject({
      status: 'launching', provider: 'claude', activeConversationId: oldConversationId,
      clearPending: { phase: 'launching' },
    });

    getPaneLiveness.mockResolvedValueOnce('alive');
    await polling.tick();

    const result = await registry.getSession(id);
    const old = result?.conversations?.find((conversation) => conversation.id === oldConversationId);
    const active = result?.conversations?.find((conversation) => conversation.id === result.activeConversationId);
    expect(result).toMatchObject({ status: 'ready', provider: 'claude', providerSessionId: 'b23782f4-715f-4abc-9233-2207319a1234', clearPending: null });
    expect(result?.conversations).toHaveLength(2);
    expect(old).toMatchObject({ endedAt: expect.any(String), endReason: 'clear', turns: [oldTurn] });
    expect(active).toMatchObject({ provider: 'claude', startReason: 'clear', providerSessionId: 'b23782f4-715f-4abc-9233-2207319a1234', turns: [] });
    expect(active?.id).not.toBe(oldConversationId);
    expect(tmux.sendCommandLine).toHaveBeenCalledTimes(1);
  });

  it('never sends the new Claude command while old-pane liveness is unknown or alive', async () => {
    const { id } = await beginClear();
    const tmux = await import('../src/tmux.js');
    getPaneLiveness.mockResolvedValueOnce('unknown');
    await polling.tick();
    expect(tmux.sendCommandLine).not.toHaveBeenCalled();
    expect((await registry.getSession(id))?.clearPending?.phase).not.toBe('launching');

    getPaneLiveness.mockResolvedValueOnce('alive');
    await polling.tick();
    expect(tmux.sendCommandLine).not.toHaveBeenCalled();
  });

  it('stops cleanly if the tmux disappears and preserves the original conversation for recovery', async () => {
    const { id, oldConversationId, oldTurn } = await beginClear();
    const tmux = await import('../src/tmux.js');
    sessionExists.mockResolvedValue(false);

    await polling.tick();

    const result = await registry.getSession(id);
    expect(result).toMatchObject({ status: 'dead', provider: 'claude', activeConversationId: oldConversationId, clearPending: null });
    expect(result?.conversations?.find((conversation) => conversation.id === oldConversationId)?.turns).toEqual([oldTurn]);
    expect(tmux.sendCommandLine).not.toHaveBeenCalled();
  });

  it('reconciles an already-running clear restart after API restart without replaying its launch', async () => {
    const { id, oldConversationId } = await beginClear('launching', '2026-01-02T00:00:00Z');
    const tmux = await import('../src/tmux.js');
    registry.__resetForTests();
    sessionExists.mockResolvedValue(true);
    getPaneLiveness.mockResolvedValue('alive');

    await polling.tick();

    const result = await registry.getSession(id);
    expect(result).toMatchObject({ status: 'ready', activeConversationId: expect.any(String), clearPending: null });
    expect(result?.activeConversationId).not.toBe(oldConversationId);
    expect(tmux.sendCommandLine).not.toHaveBeenCalled();
  });

  it('does not replay an uncertain launch after API restart and eventually leaves old history intact on confirmed failure', async () => {
    vi.useFakeTimers();
    try {
      const start = new Date().toISOString();
      const startMs = Date.parse(start);
      const { id, oldConversationId, oldTurn } = await beginClear('launching', start);
      const tmux = await import('../src/tmux.js');
      sessionExists.mockResolvedValue(true);
      getPaneLiveness.mockResolvedValue('dead');
      registry.__resetForTests();

      await polling.tick();
      expect(tmux.sendCommandLine).not.toHaveBeenCalled();
      vi.setSystemTime(startMs + RUNTIME_STARTUP_GRACE_MS + 1);
      await polling.tick();
      vi.setSystemTime(startMs + RUNTIME_STARTUP_GRACE_MS + RUNTIME_DEAD_STABILITY_MS + 1);
      await polling.tick();

      const result = await registry.getSession(id);
      expect(result).toMatchObject({ provider: null, status: 'idle', activeConversationId: null, clearPending: null });
      expect(result?.conversations?.find((conversation) => conversation.id === oldConversationId)?.turns).toEqual([oldTurn]);
      expect(tmux.sendCommandLine).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('polling.tick — observed Codex identity', () => {
  const CODEX_ID = '019a0000-0000-7000-8000-000000000001';
  async function makeUnboundCodex() {
    const session = await registry.createSession('/some/project', 'proj-1');
    const launched = await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: new Date().toISOString(),
      launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/private/codex', conversationRoot: '/private/codex/sessions', delegate: { kind: 'native', executable: 'codex' } },
    });
    await registry.updateSession(session.id, { status: 'ready', turnPhase: 'idle' });
    locateSessionFile.mockResolvedValue({ status: 'pending' });
    getPaneRuntimePid.mockResolvedValue(4242);
    return { id: session.id, conversationId: launched?.activeConversationId as string };
  }

  it('binds the id observed from the pane codex process to the active conversation', async () => {
    const { id, conversationId } = await makeUnboundCodex();
    observeIdentity.mockResolvedValue({ status: 'resolved', providerSessionId: CODEX_ID, evidence: 'process_thread_lock' });

    await polling.tick();

    expect(observeIdentity).toHaveBeenCalledWith({ pid: 4242, profile: expect.objectContaining({ home: '/private/codex' }), startedAt: expect.any(String) });
    const bound = await registry.getSession(id);
    expect(bound).toMatchObject({ providerSessionId: CODEX_ID, runtimeId: 'codex-cli' });
    expect(bound?.conversations?.find((conversation) => conversation.id === conversationId)?.providerSessionId).toBe(CODEX_ID);
  });

  it('binds nothing while a start-up prompt is on screen, whatever the process has open', async () => {
    // Agy 1.2.12 opens an old, unrelated conversation behind its trust prompt.
    const { id } = await makeUnboundCodex();
    observeIdentity.mockResolvedValue({ status: 'resolved', providerSessionId: CODEX_ID, evidence: 'process_thread_lock' });
    capturePane.mockResolvedValue('  Trust this folder? Codex can read, edit, and run files here.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue · esc quit\n');

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.providerSessionId).toBeNull();
    expect(session?.startupPrompt).toMatchObject({ kind: 'workspace_trust' });
  });

  it('stays unbound and warns once only after the codex process keeps holding no thread lock', async () => {
    const { id } = await makeUnboundCodex();
    observeIdentity.mockResolvedValue({ status: 'unobservable', reason: 'holds 0 thread locks (need exactly 1)' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    const pollingWarnings = () => warn.mock.calls.filter(([line]) => String(line).startsWith('[polling]'));
    try {
      const startMs = Date.now();
      await polling.tick();
      vi.setSystemTime(startMs + RUNTIME_IDENTITY_WARN_AFTER_MS - 1);
      await polling.tick();
      expect(pollingWarnings()).toHaveLength(0);

      vi.setSystemTime(startMs + RUNTIME_IDENTITY_WARN_AFTER_MS);
      await polling.tick();
      vi.setSystemTime(startMs + RUNTIME_IDENTITY_WARN_AFTER_MS * 2);
      await polling.tick();

      expect(observeIdentity).toHaveBeenCalledTimes(4);
      expect((await registry.getSession(id))?.providerSessionId).toBeNull();
      const lines = pollingWarnings();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toContain(id);
      expect(lines[0]?.[0]).toContain('pid 4242');
      expect(lines[0]?.[0]).toContain('holds 0 thread locks');
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('does not warn when the lock appears shortly after launch', async () => {
    const { id } = await makeUnboundCodex();
    observeIdentity
      .mockResolvedValueOnce({ status: 'unobservable', reason: 'holds 0 thread locks (need exactly 1)' })
      .mockResolvedValue({ status: 'resolved', providerSessionId: CODEX_ID, evidence: 'process_thread_lock' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const startMs = Date.now();
      await polling.tick();
      vi.setSystemTime(startMs + 1_000);
      await polling.tick();

      expect((await registry.getSession(id))?.providerSessionId).toBe(CODEX_ID);
      expect(warn.mock.calls.filter(([line]) => String(line).startsWith('[polling]'))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe('polling.tick — persisted pending launch recovery', () => {
  async function makePendingLaunch() {
    const session = await registry.createSession('/some/project', 'proj-1');
    const attempt = {
      provider: 'codex' as const, providerSessionId: null, providerLaunchedAt: '2026-01-01T00:01:00Z',
      previousStatus: 'ready' as const, previousTurnPhase: 'replying' as const,
      launchProfile: { id: 'native:codex', provider: 'codex' as const, source: 'native' as const, home: '/private/codex', delegate: { kind: 'native' as const, executable: 'codex' } },
    };
    await registry.updateSession(session.id, { status: 'launching', launchPending: attempt });
    // Simulate service restart: the polling module observes only registry.json.
    registry.__resetForTests();
    return { id: session.id, attempt };
  }

  it('commits the pending provider only after restart recovery confirms it alive', async () => {
    const { id } = await makePendingLaunch();
    getPaneLiveness.mockResolvedValueOnce('alive');

    await polling.tick();

    const recovered = await registry.getSession(id);
    expect(recovered).toMatchObject({ status: 'ready', provider: 'codex', activeConversationId: expect.any(String), launchPending: null });
    expect(recovered?.conversations).toHaveLength(1);
    expect(recovered?.conversations?.[0]).toMatchObject({ provider: 'codex', transcript: { state: 'pending' }, turns: [] });
  });

  it('restores prior status and leaves provider/history untouched once restart recovery finds it stably dead', async () => {
    const { id } = await makePendingLaunch();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      getPaneLiveness.mockResolvedValue('dead');
      await polling.tick();
      // One dead sample is not enough, even long past the startup grace.
      expect(await registry.getSession(id)).toMatchObject({ status: 'launching', launchPending: expect.any(Object) });

      vi.setSystemTime(Date.now() + RUNTIME_DEAD_STABILITY_MS);
      await polling.tick();
      expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying', provider: null, activeConversationId: null, launchPending: null, conversations: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never rolls back a launch dispatched moments ago whose pane still shows the shell (launch race)', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const dispatchedAt = new Date().toISOString();
    await registry.beginPendingLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: dispatchedAt,
      previousStatus: 'idle', previousTurnPhase: 'idle',
      launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/private/codex', delegate: { kind: 'native', executable: 'codex' } },
    });
    registry.releaseLaunchAttempt(session.id, dispatchedAt); // the request finished sending
    getPaneLiveness.mockResolvedValue('dead');

    await polling.tick();
    await polling.tick();

    expect(await registry.getSession(session.id)).toMatchObject({ status: 'launching', launchPending: expect.any(Object), lastError: null });

    getPaneLiveness.mockResolvedValue('alive');
    await polling.tick();
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'ready', provider: 'codex', launchPending: null });
  });

  it('does not judge a launch while the request that claimed it is still dispatching', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const dispatchedAt = new Date().toISOString();
    await registry.beginPendingLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, providerLaunchedAt: dispatchedAt,
      previousStatus: 'idle', previousTurnPhase: 'idle',
      launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/private/codex', delegate: { kind: 'native', executable: 'codex' } },
    });
    getPaneLiveness.mockResolvedValue('alive');

    await polling.tick();
    expect(getPaneLiveness).not.toHaveBeenCalled();
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'launching' });

    registry.releaseLaunchAttempt(session.id, dispatchedAt);
    await polling.tick();
    expect(await registry.getSession(session.id)).toMatchObject({ status: 'ready', provider: 'codex' });
  });

  it('keeps an unknown pending launch persisted without creating a conversation', async () => {
    const { id } = await makePendingLaunch();
    getPaneLiveness.mockResolvedValueOnce('unknown');

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'launching', provider: null, activeConversationId: null, launchPending: { provider: 'codex' }, conversations: [] });
  });
});

describe('polling.tick — legacy runtime recovery', () => {
  async function makeLegacyRunningSession(provider: 'claude' | 'codex' | 'gemini', status: 'ready' | 'launching' = 'ready') {
    const created = await registry.createSession('/some/project', 'proj-1');
    const launchedAt = '2026-01-01T00:01:00Z';
    const oldTurn: Turn = { index: 1, user: { text: 'legacy question', at: 'u' }, assistant: { text: 'legacy answer', at: 'a' } };
    const legacy: Record<string, unknown> = {
      ...created,
      provider,
      providerSessionId: provider === 'claude' ? 'pinned-legacy-id' : null,
      providerSessionFile: '/private/legacy-transcript.jsonl',
      providerLaunchedAt: launchedAt,
      status,
      turns: [oldTurn],
      turnsSourceFile: '/private/legacy-transcript.jsonl',
    };
    delete legacy.conversations;
    delete legacy.activeConversationId;
    delete legacy.launchPending;
    await writeFile(path.join(stateDir, 'registry.json'), JSON.stringify([legacy]), 'utf-8');
    registry.__resetForTests();
    const migrated = await registry.getSession(created.id);
    if (!migrated) throw new Error('legacy session failed to migrate');
    return { id: created.id, launchedAt, oldTurn };
  }

  it('attaches an empty runtime_recovery segment only after liveness is alive, keeps legacy turns, then resolves Claude by its pinned ID', async () => {
    const { id, launchedAt, oldTurn } = await makeLegacyRunningSession('claude');
    getPaneLiveness.mockResolvedValueOnce('unknown').mockResolvedValueOnce('alive');

    await polling.tick();
    expect((await registry.getSession(id))?.activeConversationId).toBeNull();

    locateSessionFile.mockResolvedValue({ status: 'not_found' });
    await polling.tick();
    let recovered = await registry.getSession(id);
    const activeId = recovered?.activeConversationId;
    expect(recovered?.conversations).toHaveLength(2);
    expect(recovered?.conversations?.[0]).toMatchObject({ startReason: 'legacy_migration', provider: null, launchProfile: null, providerSessionId: null, turns: [oldTurn] });
    expect(recovered?.conversations?.[1]).toMatchObject({
      id: activeId, provider: 'claude', providerSessionId: 'pinned-legacy-id', startReason: 'runtime_recovery',
      // Nothing sent yet, so a missing transcript is expected, not "not found".
      transcript: { state: 'pending', file: null, identity: null }, turns: [],
    });
    expect(recovered?.turns).toEqual([]);

    locateSessionFile.mockResolvedValue({ status: 'resolved', file: '/private/pinned-legacy-id.jsonl', identity: 'pinned_id' });
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseMessages.mockResolvedValue([]);
    const newTurn: Turn = { index: 2, user: { text: 'after upgrade', at: 'u2' }, assistant: { text: 'new answer', at: 'a2' } };
    parseTurns.mockResolvedValueOnce([oldTurn]).mockResolvedValueOnce([oldTurn, newTurn]);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'replying' });
    getPaneLiveness.mockResolvedValue('alive');
    await polling.tick();
    await polling.tick();
    await polling.tick();

    recovered = await registry.getSession(id);
    expect(locateSessionFile).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'pinned-legacy-id', launchedAfter: launchedAt }));
    expect(recovered?.conversations?.[1]?.transcript).toEqual({ state: 'resolved', file: '/private/pinned-legacy-id.jsonl', identity: 'pinned_id' });
    expect(recovered?.conversations?.[1]).toMatchObject({ transcriptTurnOffset: 1, turns: [newTurn] });
    expect(recovered?.conversations?.[0]).toMatchObject({ provider: null, launchProfile: null, turns: [oldTurn] });
  });

  it('recovers a pre-feature launching session with no pending snapshot after positive liveness', async () => {
    const { id } = await makeLegacyRunningSession('claude', 'launching');
    getPaneLiveness.mockResolvedValueOnce('alive');

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', provider: 'claude', activeConversationId: expect.any(String) });
    const recovered = await registry.getSession(id);
    expect(recovered?.conversations?.find((conversation) => conversation.id === recovered.activeConversationId)?.startReason).toBe('runtime_recovery');
  });

  it('clears a pre-feature launching runtime with no pending snapshot when liveness confirms it dead', async () => {
    const { id, oldTurn } = await makeLegacyRunningSession('codex', 'launching');
    getPaneLiveness.mockResolvedValueOnce('dead');

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'idle', provider: null, activeConversationId: null });
    expect((await registry.getSession(id))?.conversations?.[0]).toMatchObject({ provider: null, turns: [oldTurn] });
  });

  it.each(['codex', 'gemini'] as const)('keeps recovered %s transcript ambiguous instead of importing unrelated history', async (provider) => {
    const { id, oldTurn } = await makeLegacyRunningSession(provider);
    getPaneLiveness.mockResolvedValue('alive');
    await polling.tick();
    await registry.updateSession(id, { status: 'ready', turnPhase: 'replying' });
    locateSessionFile.mockResolvedValue({ status: 'ambiguous' });
    await polling.tick();

    const recovered = await registry.getSession(id);
    expect(recovered?.conversations).toHaveLength(2);
    expect(recovered?.conversations?.[0]).toMatchObject({ provider: null, launchProfile: null, turns: [oldTurn] });
    expect(recovered?.conversations?.[1]).toMatchObject({ startReason: 'runtime_recovery', transcript: { state: 'ambiguous', file: null, identity: null }, turns: [] });
    expect(parseTurns).not.toHaveBeenCalled();
    expect(parseMessages).not.toHaveBeenCalled();
  });
});

describe('polling.tick — locating the transcript', () => {
  // The transcript belongs to the active segment, so it is looked for under
  // that segment's launch profile — in every phase — even where the
  // session-level copy of the binding says something else.
  it.each(['replying', 'idle'] as const)('searches the active segment\'s conversation root while %s', async (turnPhase) => {
    const session = await registry.createSession('/some/project', 'proj-1');
    const profile = {
      id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, source: 'native' as const,
      home: '/segment/codex', conversationRoot: '/segment/codex/sessions', delegate: { kind: 'native' as const, executable: 'codex' },
    };
    await registry.commitConversationLaunch(session.id, {
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234',
      providerLaunchedAt: new Date().toISOString(), launchProfile: profile,
    });
    await registry.updateSession(session.id, {
      turnPhase, lastUserMessageAt: new Date().toISOString(),
      launchProfile: { ...profile, home: '/elsewhere', conversationRoot: '/elsewhere/sessions' },
    });
    locateSessionFile.mockResolvedValue({ status: 'pending' });

    await polling.tick();

    expect(locateSessionFile).toHaveBeenCalledWith(expect.objectContaining({ conversationRoot: '/segment/codex/sessions' }));
    expect(locateSessionFile).not.toHaveBeenCalledWith(expect.objectContaining({ conversationRoot: '/elsewhere/sessions' }));
  });
});

describe('polling.tick — pending interaction', () => {
  it('sets needs_interaction the first time a pending tool_use is found', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue(pendingResult({
      kind: 'tool_permission',
      toolUseId: 'toolu_1',
      toolName: 'Write',
      input: {},
      detectedAt: 't1',
    }));

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
    expect(session?.pendingInteraction?.toolUseId).toBe('toolu_1');
  });

  it('does not re-publish an update when the same pending interaction is still there', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    // Resolve the transcript before subscribing so event count isolates the
    // same-pending-interaction dedup behavior.
    await registry.updateSession(id, {
      status: 'ready',
      turnPhase: 'replying',
      lastUserMessageAt: new Date().toISOString(),
    });
    findPendingInteraction.mockResolvedValue(pendingResult({
      kind: 'tool_permission',
      toolUseId: 'toolu_1',
      toolName: 'Write',
      input: {},
      detectedAt: 't1',
    }));

    const sessionStream = await import('../src/session-stream.js');
    let updateCount = 0;
    sessionStream.subscribe(id, (event) => {
      if (event.type === 'update') updateCount++;
    });

    await polling.tick(); // first sighting: publishes
    await polling.tick(); // arrow-key navigation, same tool_use still pending: should NOT re-publish
    await polling.tick();

    expect(updateCount).toBe(1);
    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
  });

  it('keeps polling a needs_interaction session (not just waiting)', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue(pendingResult({
      kind: 'tool_permission',
      toolUseId: 'toolu_1',
      toolName: 'Write',
      input: {},
      detectedAt: 't1',
    }));
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });

    // Resolved: a tool_result finally showed up (findPendingInteraction now
    // reports nothing pending). If polling only watched 'waiting' sessions,
    // this tick would never even look at it.
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([]);
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(session?.pendingInteraction).toBeNull();
  });

  it('falls through to normal turn-completion tracking once resolved', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue(pendingResult({
      kind: 'tool_permission',
      toolUseId: 'toolu_1',
      toolName: 'Write',
      input: {},
      detectedAt: 't1',
    }));
    await polling.tick();

    findPendingInteraction.mockResolvedValue(pendingResult());
    const finalTurns: Turn[] = [
      { index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'done', at: 't2' } },
    ];
    parseTurns.mockResolvedValue(finalTurns);

    // stat() reports the same mtime/size across these ticks (statMtime
    // unchanged) — needs STABLE_POLLS_BEFORE_FINAL (2) consecutive
    // unchanged reads before finalizing, matching normal 'waiting' behavior.
    await polling.tick(); // resolves needs_interaction -> waiting, stability count 1
    await polling.tick(); // stability count 2 -> finalizes

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns).toEqual(finalTurns);
  });
});

describe('polling.tick — turn-completion gate', () => {
  it('keeps unknown capabilities explicit and uses transcript quiescence as a separate fallback', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue({ status: 'unknown' });
    isTurnComplete.mockResolvedValue({ status: 'unknown' });
    const turns: Turn[] = [{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'reply', at: 't2' } }];
    parseTurns.mockResolvedValue(turns);

    await polling.tick();
    await polling.tick();

    expect((await registry.getSession(id))?.turns).toEqual(turns);
    expect(isTurnComplete).toHaveBeenCalled();
  });

  it('shows the reply so far but keeps replying while the file is quiet and isTurnComplete says the turn is still going', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(false));
    const turns: Turn[] = [{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'partial', at: 't2' } }];
    parseTurns.mockResolvedValue(turns);

    await polling.tick(); // stability count 1
    await polling.tick(); // stability count 2: imported, but isTurnComplete keeps the turn open

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(session?.turns).toEqual(turns);
  });

  it('finalizes once isTurnComplete flips to true on a later, still-quiet poll', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(false));
    const turns: Turn[] = [{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'full reply', at: 't2' } }];
    parseTurns.mockResolvedValue(turns);

    await polling.tick();
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });

    isTurnComplete.mockResolvedValue(completionResult(true));
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns).toEqual(turns);
  });
});

// Claude Code 2.1.296 compacts an idle conversation by itself, writing its
// summary as a user-role record with no reply after it. A Hestia that read
// that as a message typed in the terminal left the turn open, and later
// stuck, for good (test/providers/claude.test.ts has the parsing side).
describe('polling.tick — a turn opened on the CLI\'s own compaction summary', () => {
  const summaryAt = '2026-10-11T02:27:31.195Z';
  const stored: Turn = { index: 1, user: { text: 'q', at: '2026-10-11T01:28:02.337Z' }, assistant: { text: 'a', at: '2026-10-11T01:30:00.000Z' } };

  async function makeStuckSession(): Promise<string> {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', [stored]);
    const conversationId = (await registry.getSession(id))!.activeConversationId!;
    await registry.updateConversation(id, conversationId, {
      lastUserMessageAt: summaryAt, lastUserMessageText: 'This session is being continued from a previous conversation that ran out of context.',
    }, { stuckSince: '2026-10-12T00:52:40.826Z' });
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(true));
    parseTurns.mockResolvedValue([stored]);
    return id;
  }

  it('ends by itself once the transcript settles, clearing the stuck hint and adding no turn', async () => {
    const id = await makeStuckSession();
    parseCompactionSummaryTimes.mockResolvedValue([summaryAt]);

    for (let i = 0; i < 3; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle', stuckSince: null });
    expect(session?.turns).toEqual([stored]);
  });

  it('still waits when the awaited message is not a compaction summary', async () => {
    const id = await makeStuckSession();
    parseCompactionSummaryTimes.mockResolvedValue(['2026-10-10T00:00:00.000Z']);

    for (let i = 0; i < 3; i++) await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });
  });
});

describe('polling.tick — turn merge across a transcript-file swap', () => {
  it('keeps turns and local indexes in separate segments after a same-tmux relaunch', async () => {
    const id = await makeWaitingSession();
    const first = await registry.getSession(id);
    const oldConversation = first?.conversations?.find((candidate) => candidate.id === first.activeConversationId);
    if (!oldConversation) throw new Error('missing first conversation fixture');
    const oldTurn = { index: 1, user: { text: 'Hi', at: 't0' }, assistant: { text: 'stale', at: 't0' } };
    await setTranscript(id, '/fake/old-session.jsonl', [oldTurn]);
    const second = await registry.commitConversationLaunch(id, {
      provider: 'claude', providerSessionId: 'second-session', providerLaunchedAt: new Date().toISOString(), launchProfile: null,
    });
    await registry.updateSession(id, { status: 'ready', turnPhase: 'replying', lastUserMessageAt: new Date().toISOString() });
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(true));
    locateSessionFile.mockResolvedValue({ status: 'resolved', file: '/fake/new-session.jsonl', identity: 'pinned_id' });

    const newFileTurns: Turn[] = [
      { index: 1, user: { text: '現在呢', at: 't1' }, assistant: { text: 'first reply', at: 't2' } },
    ];
    parseTurns.mockResolvedValue(newFileTurns);

    await polling.tick(); // stability count 1
    await polling.tick(); // stability count 2 -> finalizes against the new file

    const session = await registry.getSession(id);
    expect(session?.conversations).toHaveLength(2);
    expect(session?.conversations?.[0].turns).toEqual([oldTurn]);
    expect(session?.conversations?.[1].turns).toEqual(newFileTurns);
    expect(session?.conversations?.[1].turns[0].index).toBe(1);
    expect(session?.activeConversationId).toBe(second?.activeConversationId);
  });
});

describe('polling.tick — stuck hint', () => {
  async function makeQuietSession(): Promise<string> {
    const id = await makeWaitingSession();
    await registry.updateSession(id, {
      lastUserMessageAt: new Date(Date.now() - 60_000).toISOString(), // 60s ago
    });
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(false));
    parseTurns.mockResolvedValue([]);
    return id;
  }

  it('sets the stuck hint (stuckSince) once the transcript has been quiet for STUCK_HINT_MS, without changing status', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const id = await makeQuietSession();
      await polling.tick(); // first sighting of the file: quiet time starts now
      expect((await registry.getSession(id))?.stuckSince ?? null).toBeNull();

      vi.setSystemTime(Date.now() + 31_000);
      await polling.tick();

      const session = await registry.getSession(id);
      expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
      expect(session?.stuckSince).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows the hint while the transcript keeps changing, however long ago the send was', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const id = await makeQuietSession();
      for (let i = 0; i < 4; i++) {
        statMtime += 1;
        vi.setSystemTime(Date.now() + 20_000);
        await polling.tick();
      }
      expect((await registry.getSession(id))?.stuckSince ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the hint as soon as the transcript changes again', async () => {
    const id = await makeQuietSession();
    await registry.updateSession(id, { stuckSince: new Date().toISOString() });
    await polling.tick();
    expect((await registry.getSession(id))?.stuckSince ?? null).toBeNull();
  });

  it('holds the hint back while the pane says the CLI is busy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      paneReading = true;
      paneShowsBusy.mockReturnValue(true);
      const id = await makeQuietSession();
      await polling.tick();
      vi.setSystemTime(Date.now() + 31_000);
      await polling.tick();
      expect((await registry.getSession(id))?.stuckSince ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not guess a replacement Claude session from a newer transcript file', async () => {
    const id = await makeWaitingSession();
    const original = { index: 1, user: { text: 'before clear', at: 't1' }, assistant: { text: 'old reply', at: 't2' } };
    await setTranscript(id, '/fake/old-id.jsonl', [original]);
    const priorId = (await registry.getSession(id))?.activeConversationId as string;
    await registry.updateConversation(id, priorId, {
      lastUserMessageAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await registry.updateSession(id, { lastUserMessageAt: new Date(Date.now() - 60_000).toISOString() });
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([]);

    await polling.tick();
    await polling.tick();

    const session = await registry.getSession(id);
    const active = session?.conversations?.find((conversation) => conversation.id === priorId);
    expect(session?.conversations).toHaveLength(1);
    expect(session?.activeConversationId).toBe(priorId);
    expect(active).toMatchObject({ endReason: null, turns: [original], transcript: { file: '/fake/old-id.jsonl' } });
    expect(session?.providerSessionId).toBe('pinned-session');
    expect(session?.providerSessionFile).toBe('/fake/old-id.jsonl');
    expect(parseTurns).toHaveBeenCalledWith('/fake/old-id.jsonl');
    expect(parseTurns).not.toHaveBeenCalledWith('/fake/new-id.jsonl');
  });

  it('does not scan for a replacement file when the current file has new turns', async () => {
    const id = await makeWaitingSession();
    await registry.updateSession(id, {
      lastUserMessageAt: new Date(Date.now() - 60_000).toISOString(),
    });
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'done', at: 't2' } }]);

    await polling.tick();
    await polling.tick();

  });

  it('keeps Codex ambiguous and never parses a candidate without a verified identity', async () => {
    const id = await makeWaitingSession('codex');
    findPendingInteraction.mockResolvedValue(pendingResult());
    locateSessionFile.mockResolvedValue({ status: 'ambiguous' });

    await polling.tick();
    await polling.tick();

    const session = await registry.getSession(id);
    const active = session?.conversations?.find((conversation) => conversation.id === session.activeConversationId);
    expect(active?.transcript.state).toBe('ambiguous');
    expect(active?.transcript.file).toBeNull();
    expect(active?.turns).toEqual([]);
    expect(parseTurns).not.toHaveBeenCalled();
    expect(parseMessages).not.toHaveBeenCalled();
  });
});

describe('polling.tick — delivery-echo check', () => {
  async function makeSentSession(text: string, sentSecondsAgo: number): Promise<string> {
    const id = await makeWaitingSession();
    const session = await registry.getSession(id);
    const conversation = session?.conversations?.find((candidate) => candidate.id === session.activeConversationId);
    if (!session || !conversation) throw new Error('missing active conversation fixture');
    const sentAt = new Date(Date.now() - sentSecondsAgo * 1000).toISOString();
    await registry.updateSession(id, {
      status: 'ready',
      turnPhase: 'replying',
      lastUserMessageAt: sentAt,
      lastUserMessageText: text,
    });
    // As the send route records it: tracked until the transcript shows it.
    await registry.updateConversation(id, conversation.id, {
      lastUserMessageAt: sentAt, lastUserMessageText: text, unconfirmedSends: recordSend([], text, sentAt),
    });
    return id;
  }

  it('flags deliveryUnconfirmedText once DELIVERY_ECHO_TIMEOUT_MS passes with no echo', async () => {
    const id = await makeSentSession('hello there', 26); // > 25s timeout
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseMessages.mockResolvedValue([]); // nothing in the transcript at all
    parseTurns.mockResolvedValue([]);

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBe('hello there');
  });

  it('does not flag before the timeout window has elapsed', async () => {
    const id = await makeSentSession('hello there', 5); // well under 25s
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseMessages.mockResolvedValue([]);
    parseTurns.mockResolvedValue([]);

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBeNull();
  });

  it('never flags a slash command — those never produce a real transcript entry by design', async () => {
    const id = await makeSentSession('/rc', 999);
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseMessages.mockResolvedValue([]);
    parseTurns.mockResolvedValue([]);

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBeNull();
    expect(parseMessages).not.toHaveBeenCalled();
  });

  it('clears an existing flag once a real user-role echo shows up', async () => {
    const id = await makeSentSession('hello there', 999);
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([]);

    parseMessages.mockResolvedValue([]);
    await polling.tick(); // flags it
    expect((await registry.getSession(id))?.deliveryUnconfirmedText).toBe('hello there');

    parseMessages.mockResolvedValue([{ role: 'user', text: 'hello there', ts: new Date().toISOString() }]);
    await polling.tick(); // echo finally shows up

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBeNull();
  });
});

describe('polling.tick — start-up prompt', () => {
  const TRUST = 'Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n  ↑/↓ Navigate · enter Confirm';

  it('surfaces Agy\'s trust prompt before anything is sent, and clears it once answered', async () => {
    const session = await registry.createSession('/some/project', 'proj-1');
    await registry.commitConversationLaunch(session.id, {
      provider: 'gemini', runtimeId: 'agy', providerSessionId: null, providerLaunchedAt: new Date().toISOString(),
      launchProfile: { id: 'native:agy', provider: 'gemini', runtimeId: 'agy', source: 'native', home: '/private/gemini', conversationRoot: '/private/gemini/c', delegate: { kind: 'native', executable: 'agy' } },
    });
    locateSessionFile.mockResolvedValue({ status: 'pending' });

    capturePane.mockResolvedValue(TRUST);
    await polling.tick();
    const prompted = await registry.getSession(session.id);
    expect(prompted?.startupPrompt).toEqual({ kind: 'workspace_trust', detectedAt: expect.any(String) });
    expect(toPublicManagedSession(prompted!).activity).toBe('awaiting_approval');

    capturePane.mockResolvedValue('> \n? for shortcuts');
    await polling.tick();
    expect((await registry.getSession(session.id))?.startupPrompt).toBeNull();
  });

  it('never reads the pane of a runtime without a known start-up prompt', async () => {
    await makeWaitingSession('claude');
    capturePane.mockClear();
    locateSessionFile.mockResolvedValue({ status: 'pending' });
    await polling.tick();
    expect(capturePane).not.toHaveBeenCalled();
  });
});

describe('polling.tick — sends that never reached the CLI', () => {
  async function sessionWithSends(sends: { text: string; secondsAgo: number }[], transcript: 'pending' | 'resolved') {
    const id = await makeWaitingSession('gemini');
    const session = await registry.getSession(id);
    const conversation = session!.conversations!.find((candidate) => candidate.id === session!.activeConversationId)!;
    let tracked = conversation.unconfirmedSends ?? [];
    for (const send of sends) tracked = recordSend(tracked, send.text, new Date(Date.now() - send.secondsAgo * 1000).toISOString());
    const latest = sends.at(-1)!;
    await registry.updateConversation(id, conversation.id, {
      unconfirmedSends: tracked,
      lastUserMessageText: latest.text,
      lastUserMessageAt: tracked.at(-1)!.at,
      ...(transcript === 'resolved' ? { transcript: { state: 'resolved', file: '/fake/session.db', identity: 'verified_metadata' } } : {}),
    });
    if (transcript === 'pending') locateSessionFile.mockResolvedValue({ status: 'pending' });
    return { id, conversationId: conversation.id };
  }

  it('flags a send once the timeout passes with no transcript at all (a start-up dialog ate the first prompt)', async () => {
    const { id } = await sessionWithSends([{ text: '幫我看一下這個專案的架構', secondsAgo: 30 }], 'pending');

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBe('幫我看一下這個專案的架構');
    expect(toPublicManagedSession(session!).undeliveredMessages).toEqual([
      { text: '幫我看一下這個專案的架構', sentAt: expect.any(String) },
    ]);
    expect(parseMessages).not.toHaveBeenCalled(); // nothing bound, nothing read
  });

  it('never claims a send was lost when a transcript exists but cannot be attributed', async () => {
    const { id, conversationId } = await sessionWithSends([{ text: 'probably arrived', secondsAgo: 60 }], 'pending');
    locateSessionFile.mockResolvedValue({ status: 'ambiguous' });
    await registry.updateConversation(id, conversationId, { transcript: { state: 'ambiguous', file: null, identity: null } });

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBeNull();
    expect(toPublicManagedSession(session!).undeliveredMessages).toEqual([]);
  });

  it('keeps an earlier lost send after a later one is delivered, instead of letting it vanish', async () => {
    const { id } = await sessionWithSends([
      { text: '第一個問題，被對話框吃掉了', secondsAgo: 40 },
      { text: 'Hi', secondsAgo: 10 },
    ], 'resolved');
    parseMessages.mockResolvedValue([{ role: 'user', text: 'Hi', ts: new Date(Date.now() - 9_000).toISOString() }]);
    parseTurns.mockResolvedValue([]);

    await polling.tick();

    const session = await registry.getSession(id);
    const conversation = session?.conversations?.find((candidate) => candidate.id === session.activeConversationId);
    // "Hi" was echoed and is no longer tracked; the first one is flagged and kept.
    expect(conversation?.unconfirmedSends).toEqual([{ text: '第一個問題，被對話框吃掉了', at: expect.any(String), flagged: true }]);
    expect(session?.deliveryUnconfirmedText).toBeNull(); // the latest send (the pending bubble) did arrive
    expect(toPublicManagedSession(session!).undeliveredMessages?.map((message) => message.text)).toEqual(['第一個問題，被對話框吃掉了']);
  });

  it('confirms by matching text, so a later echo never confirms an earlier lost send', async () => {
    const { id } = await sessionWithSends([
      { text: 'first', secondsAgo: 40 },
      { text: 'second', secondsAgo: 35 },
    ], 'resolved');
    parseMessages.mockResolvedValue([{ role: 'user', text: 'second', ts: new Date(Date.now() - 34_000).toISOString() }]);
    parseTurns.mockResolvedValue([]);

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.conversations?.find((c) => c.id === session.activeConversationId)?.unconfirmedSends?.map((send) => send.text)).toEqual(['first']);
  });

  it('can still confirm a flagged send if its echo arrives late', async () => {
    const { id } = await sessionWithSends([{ text: 'slow but delivered', secondsAgo: 60 }], 'resolved');
    parseMessages.mockResolvedValue([]);
    parseTurns.mockResolvedValue([]);
    await polling.tick();
    expect((await registry.getSession(id))?.deliveryUnconfirmedText).toBe('slow but delivered');

    statMtime += 1; // the transcript changed
    parseMessages.mockResolvedValue([{ role: 'user', text: 'slow but delivered', ts: new Date(Date.now() - 59_000).toISOString() }]);
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.deliveryUnconfirmedText).toBeNull();
    expect(toPublicManagedSession(session!).undeliveredMessages).toEqual([]);
  });
});

describe('polling.tick — CLI-still-alive check', () => {
  async function makeLaunchedSession(status: 'ready' | 'launching' = 'ready'): Promise<string> {
    const id = await makeWaitingSession();
    const session = await registry.getSession(id);
    const conversation = session?.conversations?.find((candidate) => candidate.id === session.activeConversationId);
    if (!conversation) throw new Error('missing active conversation fixture');
    await registry.updateConversation(id, conversation.id, {
      transcript: { state: 'resolved', file: '/fake/session.jsonl', identity: 'pinned_id' },
      turns: [{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'hello', at: 't2' } }],
    });
    // 'ready' as it used to be stored: no turn in progress.
    await registry.updateSession(id, status === 'ready' ? { status, turnPhase: 'idle' } : { status });
    return id;
  }

  it('leaves a session alone when the pane still runs the expected CLI', async () => {
    const id = await makeLaunchedSession();
    getPaneLiveness.mockResolvedValue('alive');
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([]);

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.provider).toBe('claude');
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(getPaneLiveness).toHaveBeenCalledWith(session?.tmuxName, { commands: ['claude'], wrappers: [] });
  });

  it('ends the active segment when the pane has reverted to a shell, preserving its turns', async () => {
    const id = await makeLaunchedSession();
    getPaneLiveness.mockResolvedValue('dead');

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.provider).toBeNull();
    expect(session?.status).toBe('idle');
    expect(session?.providerSessionId).toBeNull();
    expect(session?.providerSessionFile).toBeNull();
    expect(session?.providerLaunchedAt).toBeNull();
    // The actual conversation history is real and must survive this reset.
    expect(session?.conversations?.[0]?.turns).toHaveLength(1);
    expect(session?.conversations?.[0]?.endReason).toBe('cli_exit');
  });

  it('does not run the check while a session is still launching (avoids racing pane startup)', async () => {
    const id = await makeLaunchedSession('launching');
    getPaneLiveness.mockResolvedValue('dead'); // would flag if the check ran

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.provider).toBe('claude');
    expect(session?.status).toBe('launching');
    expect(getPaneLiveness).not.toHaveBeenCalled();
  });

  it('does nothing when the pane command cannot be determined at all', async () => {
    const id = await makeLaunchedSession();
    getPaneLiveness.mockResolvedValue('unknown');

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.provider).toBe('claude');
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });

  it('marks a session dead once its tmux is gone, without anyone listing sessions', async () => {
    const id = await makeWaitingSession();
    await registry.updateSession(id, { paneActivity: 'busy' });
    const other = await makeLaunchedSession();
    const otherName = (await registry.getSession(other))!.tmuxName;
    listManagedSessionNames.mockResolvedValue([otherName]);

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'dead', paneActivity: 'unknown' });
    expect((await registry.getSession(other))?.status).toBe('ready');
  });

  it('ends nothing when tmux cannot list its sessions', async () => {
    const id = await makeLaunchedSession();
    listManagedSessionNames.mockRejectedValue(new Error('lost server'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await polling.tick();

    expect((await registry.getSession(id))?.status).toBe('ready');
    logged.mockRestore();
  });

  it('preserves Codex when the pane wrapper is ambiguous rather than clearing provider state', async () => {
    const id = await makeLaunchedSession();
    await registry.commitConversationLaunch(id, {
      provider: 'codex', providerSessionId: null, providerLaunchedAt: new Date().toISOString(), launchProfile: null,
    });
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    getPaneLiveness.mockResolvedValue('unknown');

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.provider).toBe('codex');
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });
});

describe('selectNewTurns', () => {
  const turn = (index: number, at: string | null, text = `q${index}`): Turn => ({
    index, user: { text, at }, assistant: { text: `a${index}`, at },
  });

  it('anchors on the last stored turn timestamp, so a newly recognized earlier turn is not re-imported', () => {
    const stored = [turn(1, '2026-01-01T00:00:01Z'), turn(2, '2026-01-01T00:00:03Z')];
    // The parser now also recognizes an interrupted turn at 00:00:02, shifting positions by one.
    const parsed = [turn(1, '2026-01-01T00:00:01Z'), turn(2, '2026-01-01T00:00:02Z'), turn(3, '2026-01-01T00:00:03Z'), turn(4, '2026-01-01T00:00:04Z')];
    expect(selectNewTurns(parsed, { turns: stored, transcriptTurnOffset: 0 }).map((t) => t.index)).toEqual([4]);
  });

  it('falls back to the count (plus recovery offset) when timestamps are unusable or nothing is stored', () => {
    const parsed = [turn(1, null), turn(2, null), turn(3, null)];
    expect(selectNewTurns(parsed, { turns: [turn(1, null)], transcriptTurnOffset: 1 }).map((t) => t.index)).toEqual([3]);
    const timed = [turn(1, '2026-01-01T00:00:01Z'), turn(2, '2026-01-01T00:00:02Z')];
    expect(selectNewTurns(timed, { turns: [], transcriptTurnOffset: 1 }).map((t) => t.index)).toEqual([2]);
  });
});

describe('turns the parser now reads longer', () => {
  const turn = (index: number, text: string): Turn => ({
    index, user: { text: `q${index}`, at: `2026-01-01T00:00:0${index}Z` }, assistant: { text, at: `2026-01-01T00:00:0${index}Z` },
  });

  it('keeps every stored part when text is added before, between or after them', () => {
    expect(keepsEveryPart('a\n\nb', 'a\n\nb\n\nc')).toBe(true);
    expect(keepsEveryPart('a\n\nb', 'a\n\nnote\n\nb')).toBe(true);
    expect(keepsEveryPart('a\n\nb', 'b\n\na')).toBe(false);
    expect(keepsEveryPart('a\n\nb', 'a\n\nc')).toBe(false);
  });

  it('grows the last turn when a newly read part lands in the middle', () => {
    const stored = [turn(1, '先看。\n\n第 1 步開始了。')];
    const parsed = [turn(1, '先看。\n\n流程確認。\n\n第 1 步開始了。\n\n第 2 步合併了。')];
    const changes = diffTurns(parsed, { turns: stored, transcriptTurnOffset: 0 });
    expect(changes.grownLast?.assistant.text).toBe(parsed[0]!.assistant.text);
    expect(changes.newTurns).toEqual([]);
  });

  it('revises stored turns read longer, by their user message, and leaves the rest', () => {
    const stored = [turn(1, 'a'), turn(2, 'b\n\nc'), turn(3, 'd')];
    const parsed = [turn(1, 'a'), turn(2, 'b\n\nnote\n\nc'), { ...turn(3, 'x\n\ny'), index: 9 }];
    expect(revisedTurns(parsed, stored)).toEqual([turn(2, 'b\n\nnote\n\nc')]);
  });
});

describe('polling.importTurnsAfterStop', () => {
  const interrupted: Turn = {
    index: 1,
    user: { text: 'explain the build', at: '2026-01-01T00:00:01Z' },
    assistant: { text: 'The build first', at: '2026-01-01T00:00:02Z', interrupted: true },
  };

  async function makeStoppedSession(): Promise<string> {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    return id;
  }

  it('imports the interrupted turn once its marker lands, without touching status', async () => {
    const id = await makeStoppedSession();
    parseTurns
      .mockResolvedValueOnce([{ ...interrupted, assistant: { text: 'The build first', at: '2026-01-01T00:00:02Z' } }])
      .mockResolvedValue([interrupted]);

    await polling.importTurnsAfterStop(id);

    const session = await registry.getSession(id);
    expect(session?.turns).toEqual([interrupted]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(parseTurns).toHaveBeenCalledTimes(2);
  });

  it('backs off when a new send already took the session back to waiting', async () => {
    const id = await makeStoppedSession();
    await registry.updateSession(id, { status: 'ready', turnPhase: 'replying' });
    parseTurns.mockResolvedValue([interrupted]);

    await polling.importTurnsAfterStop(id);

    expect(parseTurns).not.toHaveBeenCalled();
    expect((await registry.getSession(id))?.turns).toEqual([]);
  });

  it('imports whatever complete turn exists at the timeout when no marker ever appears', async () => {
    vi.useFakeTimers();
    try {
      const id = await makeStoppedSession();
      const partial: Turn = { ...interrupted, assistant: { text: 'partial', at: '2026-01-01T00:00:02Z' } };
      parseTurns.mockResolvedValue([partial]);

      const done = polling.importTurnsAfterStop(id);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;

      expect((await registry.getSession(id))?.turns).toEqual([partial]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('polling.tick — ready sessions (input typed straight into tmux)', () => {
  const turn = (index: number, at: string): Turn => ({
    index, user: { text: `q${index}`, at }, assistant: { text: `a${index}`, at },
  });

  async function makeReadySession(stored: Turn[] = []): Promise<string> {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', stored);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle', lastUserMessageAt: '2026-01-01T00:00:00Z' });
    const session = await registry.getSession(id);
    await registry.updateConversation(id, session!.activeConversationId!, { lastUserMessageAt: '2026-01-01T00:00:00Z' });
    return id;
  }

  it('imports complete turns once the transcript goes quiet, parsing it only once per change', async () => {
    const id = await makeReadySession([turn(1, '2026-01-01T00:00:01Z')]);
    parseMessages.mockResolvedValue([{ role: 'assistant', text: 'a2', ts: '2026-01-01T00:00:03Z' }]);
    parseTurns.mockResolvedValue([turn(1, '2026-01-01T00:00:01Z'), turn(2, '2026-01-01T00:00:02Z')]);

    for (let i = 0; i < 5; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.turns.map((t) => t.index)).toEqual([1, 2]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(parseTurns).toHaveBeenCalledTimes(1);
  });

  it('does not import while the adapter says the turn is still in progress', async () => {
    const id = await makeReadySession();
    isTurnComplete.mockResolvedValue(completionResult(false));
    parseTurns.mockResolvedValue([turn(1, '2026-01-01T00:00:02Z')]);

    for (let i = 0; i < 3; i++) await polling.tick();

    expect((await registry.getSession(id))?.turns).toEqual([]);
  });

  it('flips to waiting when a new user message with no reply shows up', async () => {
    const id = await makeReadySession([turn(1, '2026-01-01T00:00:01Z')]);
    parseMessages.mockResolvedValue([{ role: 'user', text: 'typed in tmux', ts: '2026-01-01T00:00:05Z' }]);

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(session?.lastUserMessageAt).toBe('2026-01-01T00:00:05Z');
    expect(session?.lastUserMessageText).toBe('typed in tmux');
    expect(session?.lastError).toBeNull();
    // Remembered as typed in the terminal, so the chat can mark it.
    expect(session?.conversations?.find((c) => c.id === session.activeConversationId)?.terminalMessageAts).toEqual(['2026-01-01T00:00:05Z']);
  });

  it('flips to waiting while a new turn is mid-reply with interim assistant text', async () => {
    const id = await makeReadySession([turn(1, '2026-01-01T00:00:01Z')]);
    parseMessages.mockResolvedValue([
      { role: 'user', text: 'typed in tmux', ts: '2026-01-01T00:00:05Z' },
      { role: 'assistant', text: 'let me check', ts: '2026-01-01T00:00:06Z' },
    ]);
    isTurnComplete.mockResolvedValue(completionResult(false));

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });
  });

  it('leaves a finished new turn to the import instead of flipping', async () => {
    const id = await makeReadySession([turn(1, '2026-01-01T00:00:01Z')]);
    parseMessages.mockResolvedValue([
      { role: 'user', text: 'q2', ts: '2026-01-01T00:00:02Z' },
      { role: 'assistant', text: 'a2', ts: '2026-01-01T00:00:03Z' },
    ]);
    parseTurns.mockResolvedValue([turn(1, '2026-01-01T00:00:01Z'), turn(2, '2026-01-01T00:00:02Z')]);

    for (let i = 0; i < 3; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns.map((t) => t.index)).toEqual([1, 2]);
  });

  it('does not flip for a trailing user message that is not newer than the last send', async () => {
    const id = await makeReadySession();
    parseMessages.mockResolvedValue([{ role: 'user', text: 'old', ts: '2025-12-31T23:59:59Z' }]);

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });
});

describe('polling.tick — a turn the transcript shows still going after the app ended it', () => {
  const turn = (index: number, at: string, reply = `a${index}`): Turn => ({
    index, user: { text: `q${index}`, at }, assistant: { text: reply, at },
  });

  async function makeIdleSession(stored: Turn[]): Promise<string> {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', stored);
    const session = await registry.getSession(id);
    await registry.updateConversation(id, session!.activeConversationId!, { lastUserMessageAt: stored.at(-1)?.user.at ?? null });
    // Ended the way the app ends a turn (a stop, the pane safety net).
    const { applyTurnEffects } = await import('../src/sync/turnEffects.js');
    await applyTurnEffects((await registry.getSession(id))!, null, [{ kind: 'enter_phase', phase: 'idle' }]);
    isTurnComplete.mockResolvedValue(completionResult(false));
    return id;
  }

  async function events(): Promise<{ action: string; result: string }[]> {
    const text = await import('node:fs/promises').then((fs) => fs.readFile(path.join(stateDir, 'session-events.jsonl'), 'utf8')).catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { action: string; result: string });
  }

  it('is replying again once the transcript grows after the app ended it (#7: a stop the CLI never took)', async () => {
    const id = await makeIdleSession([turn(13, '2026-10-14T21:59:58.720Z', 'first line')]);
    openTurnAtEnd.mockResolvedValue({ openedBy: 'user', at: '2026-10-14T21:59:58.720Z' });
    statMtime = Date.now() + 1_000;
    // The mocked stat would report the events file that large, and rotate it.
    missingFiles.add(path.join(stateDir, 'session-events.jsonl'));

    await polling.tick();
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    // Its message was already recorded: not taken for a new terminal one.
    expect(session?.lastUserMessageAt).toBe('2026-10-14T21:59:58.720Z');
    expect(session?.conversations?.find((c) => c.id === session.activeConversationId)?.terminalMessageAts).toBeUndefined();
    expect(await events()).toContainEqual(expect.objectContaining({ action: 'turn_reopened', result: 'ok' }));
  });

  it('stays idle while the transcript has not been written since the app ended the turn', async () => {
    const id = await makeIdleSession([turn(1, '2026-01-01T00:00:01Z')]);
    openTurnAtEnd.mockResolvedValue({ openedBy: 'user', at: '2026-01-01T00:00:01Z' });
    statMtime = Date.now() - 1_000; // e.g. a dangling tool_use the pane already settled

    for (let i = 0; i < 3; i++) await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });

  it('stays idle for a transcript quiet past BACKGROUND_TURN_QUIET_MS', async () => {
    const { BACKGROUND_TURN_QUIET_MS } = await import('../src/sync/backgroundAgents.js');
    const id = await makeIdleSession([turn(1, '2026-01-01T00:00:01Z')]);
    const { trackerFor } = await import('../src/sync/tracker.js');
    trackerFor(id).turnEndedAt = undefined; // e.g. after an API restart
    openTurnAtEnd.mockResolvedValue({ openedBy: 'user', at: '2026-01-01T00:00:01Z' });
    statMtime = Date.now() - BACKGROUND_TURN_QUIET_MS - 1;

    for (let i = 0; i < 3; i++) await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });

  it('records a turn typed in the terminal that was never recorded as sent', async () => {
    const id = await makeIdleSession([turn(1, '2026-01-01T00:00:01Z')]);
    openTurnAtEnd.mockResolvedValue({ openedBy: 'user', at: '2026-01-01T00:00:09Z' });
    // Its reply is already under way, so the fresh-message check alone saw nothing new to flip on.
    parseMessages.mockResolvedValue([{ role: 'user', text: 'typed', ts: '2026-01-01T00:00:09Z' }, { role: 'assistant', text: 'on it', ts: '2026-01-01T00:00:10Z' }]);
    isTurnComplete.mockResolvedValue(completionResult(true)).mockResolvedValueOnce(completionResult(true));
    statMtime = Date.now() + 1_000;

    await polling.tick();
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying', lastUserMessageAt: '2026-01-01T00:00:09Z', lastUserMessageText: 'typed' });
    expect(session?.conversations?.find((c) => c.id === session.activeConversationId)?.terminalMessageAts).toEqual(['2026-01-01T00:00:09Z']);
  });

  it("shows the CLI's own turn as it is written, staying idle", async () => {
    const id = await makeIdleSession([turn(1, '2026-01-01T00:00:01Z', 'done')]);
    openTurnAtEnd.mockResolvedValue({ openedBy: 'cli', at: null });
    parseTurns.mockResolvedValue([turn(1, '2026-01-01T00:00:01Z', 'done\n\nwoken by a subagent, working on it')]);
    statMtime = Date.now() + 1_000;

    await polling.tick();
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns[0]?.assistant.text).toBe('done\n\nwoken by a subagent, working on it');
  });
});

describe('polling.tick — permission prompt confirmed on the pane', () => {
  const toolUse = { kind: 'tool_permission' as const, toolUseId: 't1', toolName: 'Bash', input: {}, detectedAt: 'x' };

  it('treats an unresolved tool_use as a running tool when no prompt is on screen', async () => {
    paneReading = true;
    paneShowsPermissionPrompt.mockReturnValue(false);
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult(toolUse));
    isTurnComplete.mockResolvedValue(completionResult(false));

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(session?.pendingInteraction).toBeNull();
  });

  it('shows the interaction when the prompt is actually on screen', async () => {
    paneReading = true;
    paneShowsPermissionPrompt.mockReturnValue(true);
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult(toolUse));

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
    expect(session?.pendingInteraction?.toolName).toBe('Bash');
  });

  it('falls back to the transcript answer when the pane cannot be read', async () => {
    paneReading = true;
    capturePane.mockRejectedValue(new Error('no pane'));
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult(toolUse));

    await polling.tick();

    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
  });
});

describe('polling.tick — a prompt only the pane shows (Claude Code 2.1.284)', () => {
  // Claude Code 2.1.284 writes nothing to the transcript while a permission or
  // a question waits; the pane is all there is.
  const prompt = (screen: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', 'interaction-prompts', `claude.${screen}.2.1.284.txt`), 'utf8');

  async function waitingOn(screen: string): Promise<string> {
    paneReading = true;
    capturePane.mockResolvedValue(prompt(screen));
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult(null));
    isTurnComplete.mockResolvedValue(completionResult(false));
    return id;
  }

  it('shows a question read off the pane, ready to answer', async () => {
    const id = await waitingOn('q-multi-q1');

    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
    expect(session?.pendingInteraction).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion', input: null });
    expect(session?.pendingInteraction?.screen?.title).toBe('你喜歡哪種水果？');
  });

  it('shows a permission read off the pane', async () => {
    const id = await waitingOn('perm-bash');

    await polling.tick();

    expect((await registry.getSession(id))?.pendingInteraction).toMatchObject({ kind: 'tool_permission', toolName: 'Bash' });
  });

  it('follows the prompt on to its next question', async () => {
    const id = await waitingOn('q-multi-q1');
    await polling.tick();

    capturePane.mockResolvedValue(prompt('q-multi-q3'));
    await polling.tick();

    expect((await registry.getSession(id))?.pendingInteraction?.screen?.title).toBe('你喜歡哪種動物？');
  });

  it('goes back to replying once the prompt is answered', async () => {
    const id = await waitingOn('q-single');
    await polling.tick();

    capturePane.mockResolvedValue(prompt('idle-after-question'));
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.turnPhase).not.toBe('awaiting_approval');
    expect(session?.pendingInteraction).toBeNull();
  });
});

describe('polling.tick — pane activity while waiting', () => {
  async function makeObservedSession(): Promise<string> {
    paneReading = true;
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(false));
    parseTurns.mockResolvedValue([]);
    return id;
  }
  const showPane = (state: 'busy' | 'idle' | 'other') => {
    paneShowsBusy.mockReturnValue(state === 'busy');
    paneShowsIdle.mockReturnValue(state === 'idle');
  };

  it('records busy and idle from the pane, surfaced through the derived activity', async () => {
    const { toPublicManagedSession } = await import('../src/session-dto.js');
    const id = await makeObservedSession();
    showPane('busy');
    await polling.tick();
    let session = await registry.getSession(id);
    expect(session?.paneActivity).toBe('busy');
    expect(toPublicManagedSession(session!).activity).toBe('busy');

    showPane('idle');
    await polling.tick();
    session = await registry.getSession(id);
    expect(session?.paneActivity).toBe('idle');
    expect(toPublicManagedSession(session!).activity).toBe('idle');

    showPane('other'); // e.g. a /status panel: neither busy nor the input box
    await polling.tick();
    expect((await registry.getSession(id))?.paneActivity).toBe('unknown');
  });

  it('only writes (and publishes) when the observation changes', async () => {
    const id = await makeObservedSession();
    showPane('busy');
    const sessionStream = await import('../src/session-stream.js');
    let updateCount = 0;
    sessionStream.subscribe(id, (event) => {
      if (event.type === 'update') updateCount++;
    });

    await polling.tick(); // unknown -> busy: one update
    await polling.tick();
    await polling.tick();
    expect(updateCount).toBe(1);

    showPane('idle');
    await polling.tick(); // busy -> idle: one more
    await polling.tick();
    expect(updateCount).toBe(2);
  });

  it('resets to unknown once the turn is imported', async () => {
    const id = await makeObservedSession();
    showPane('busy');
    await polling.tick();
    expect((await registry.getSession(id))?.paneActivity).toBe('busy');

    isTurnComplete.mockResolvedValue(completionResult(true));
    parseTurns.mockResolvedValue([{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'done', at: 't2' } }]);
    await polling.tick();
    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.paneActivity).toBe('unknown');
  });

  it('resets a stale observation when something else moved the session out of waiting', async () => {
    const id = await makeObservedSession();
    showPane('busy');
    await polling.tick();
    // e.g. the stop button: the route unlocks to 'ready' directly.
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    await polling.tick();
    expect((await registry.getSession(id))?.paneActivity).toBe('unknown');
  });

  it('resets to unknown when a permission prompt takes over', async () => {
    const id = await makeObservedSession();
    showPane('busy');
    await polling.tick();
    paneShowsPermissionPrompt.mockReturnValue(true);
    findPendingInteraction.mockResolvedValue(pendingResult({ kind: 'tool_permission', toolUseId: 't1', toolName: 'Bash', input: {}, detectedAt: 'x' }));
    await polling.tick();
    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'awaiting_approval' });
    expect(session?.paneActivity).toBe('unknown');
  });

  it('reads an unreadable pane as unknown and keeps polling', async () => {
    const id = await makeObservedSession();
    showPane('busy');
    await polling.tick();
    capturePane.mockRejectedValue(new Error('no pane'));
    await polling.tick();
    expect((await registry.getSession(id))?.paneActivity).toBe('unknown');

    isTurnComplete.mockResolvedValue(completionResult(true));
    parseTurns.mockResolvedValue([{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'done', at: 't2' } }]);
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });

  it('leaves the observation unknown for an adapter without pane reading', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(false));
    await polling.tick();
    expect((await registry.getSession(id))?.paneActivity ?? 'unknown').toBe('unknown');
    expect(capturePane).not.toHaveBeenCalled();
  });
});

describe('polling.tick — finalizing on an idle pane', () => {
  const turns: Turn[] = [{ index: 1, user: { text: 'hi', at: 't1' }, assistant: { text: 'reply', at: 't2' } }];

  // A transcript that never says "done" (e.g. a tool interrupted before its
  // tool_result), sitting quiet while the pane shows the input box.
  async function makeStuckSession(): Promise<string> {
    paneReading = true;
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());
    isTurnComplete.mockResolvedValue(completionResult(false));
    parseTurns.mockResolvedValue(turns);
    paneShowsBusy.mockReturnValue(false);
    paneShowsIdle.mockReturnValue(true);
    return id;
  }

  async function withFakeDate(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  }

  it('imports and unlocks once the pane has been idle for PANE_IDLE_FINALIZE_MS and the transcript quiet for PANE_IDLE_FINALIZE_QUIET_MS', () => withFakeDate(async () => {
    const { PANE_IDLE_FINALIZE_MS, PANE_IDLE_FINALIZE_QUIET_MS } = await import('../src/config.js');
    const id = await makeStuckSession();
    await polling.tick(); // stability 1, idle clock starts
    await polling.tick(); // stability 2, idle for 0ms
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });

    await registry.updateSession(id, { stuckSince: new Date().toISOString() });
    vi.setSystemTime(Date.now() + Math.max(PANE_IDLE_FINALIZE_MS, PANE_IDLE_FINALIZE_QUIET_MS));
    await polling.tick();

    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns).toEqual(turns);
    expect(session?.lastError).toBeNull();
    expect(session?.stuckSince).toBeNull();
    expect(session?.paneActivity).toBe('unknown');
  }));

  it('unlocks even when there is no complete turn to import', () => withFakeDate(async () => {
    const id = await makeStuckSession();
    parseTurns.mockResolvedValue([]);
    await polling.tick();
    await polling.tick();
    vi.setSystemTime(Date.now() + 15_000);
    await polling.tick();
    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns).toEqual([]);
  }));

  it('does not fire while the transcript was written too recently, however long the pane looked idle', () => withFakeDate(async () => {
    // A CLI on another screen (a subagent's view) can look idle while it
    // keeps writing between quiet spells.
    const id = await makeStuckSession();
    await polling.tick();
    await polling.tick();
    vi.setSystemTime(Date.now() + 14_000);
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });
  }));

  it('does not fire before the pane has been idle long enough', () => withFakeDate(async () => {
    const id = await makeStuckSession();
    await polling.tick();
    await polling.tick();
    vi.setSystemTime(Date.now() + 4_000);
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    // What's written so far shows; the turn just isn't over.
    expect((await registry.getSession(id))?.turns).toEqual(turns);
  }));

  it('restarts the clock after any non-idle observation', () => withFakeDate(async () => {
    const id = await makeStuckSession();
    await polling.tick();
    // The transcript has long been quiet; only the pane's clock is tested.
    vi.setSystemTime(Date.now() + 15_000);
    paneShowsIdle.mockReturnValue(false); // e.g. a /status panel opened briefly
    await polling.tick();
    paneShowsIdle.mockReturnValue(true);
    vi.setSystemTime(Date.now() + 3_000);
    await polling.tick(); // idle again, but only since now
    vi.setSystemTime(Date.now() + 3_000);
    await polling.tick(); // 3s of continuous idle: still not enough
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });

    vi.setSystemTime(Date.now() + 2_000);
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  }));

  it('never fires while the pane says busy', () => withFakeDate(async () => {
    const id = await makeStuckSession();
    paneShowsBusy.mockReturnValue(true);
    await polling.tick();
    await polling.tick();
    vi.setSystemTime(Date.now() + 60_000);
    await polling.tick();
    expect(await registry.getSession(id)).toMatchObject({ status: 'ready', turnPhase: 'replying' });
  }));

  it('leaves the normal path alone when isTurnComplete says done', async () => {
    const id = await makeStuckSession();
    paneShowsIdle.mockReturnValue(false);
    isTurnComplete.mockResolvedValue(completionResult(true));
    await polling.tick();
    await polling.tick(); // no idle wait needed
    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(session?.turns).toEqual(turns);
  });

  it('is disabled for an adapter that cannot recognize an idle pane', () => withFakeDate(async () => {
    paneIdleReading = false;
    const id = await makeStuckSession();
    await polling.tick();
    await polling.tick();
    vi.setSystemTime(Date.now() + 60_000);
    await polling.tick();
    const session = await registry.getSession(id);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
    expect(session?.turns).toEqual(turns);
  }));
});

describe('diffTurns — the last stored reply growing in place', () => {
  const turn = (index: number, at: string, reply: string): Turn => ({
    index, user: { text: `q${index}`, at }, assistant: { text: reply, at },
  });

  it('refreshes the last stored turn when its reply grew, keeping the stored index', () => {
    const stored = [turn(7, '2026-01-01T00:00:01Z', 'started')];
    // The parser now numbers it differently; the stored index must win.
    const parsed = [{ ...turn(9, '2026-01-01T00:00:01Z', 'started\n\nand kept going'), user: stored[0]!.user }];
    const changes = diffTurns(parsed, { turns: stored, transcriptTurnOffset: 0 });
    expect(changes.newTurns).toEqual([]);
    expect(changes.grownLast).toEqual({ ...stored[0], assistant: { text: 'started\n\nand kept going', at: '2026-01-01T00:00:01Z' } });
  });

  it('refreshes the last stored turn once it is marked interrupted, even with its text unchanged', () => {
    const stored = [turn(4, '2026-01-01T00:00:01Z', 'partial')];
    const parsed = [{ ...stored[0]!, assistant: { ...stored[0]!.assistant, interrupted: true as const } }];
    expect(diffTurns(parsed, { turns: stored, transcriptTurnOffset: 0 }).grownLast).toEqual(parsed[0]);
    // Already stored as interrupted: nothing to do.
    expect(diffTurns(parsed, { turns: parsed, transcriptTurnOffset: 0 }).grownLast).toBeNull();
  });

  it('refreshes the last stored turn when a mid-reply follow-up joined it', () => {
    const stored = [turn(3, '2026-01-01T00:00:01Z', 'working')];
    const followUps = [{ text: 'also this', at: '2026-01-01T00:00:05Z' }];
    const changes = diffTurns([{ ...stored[0]!, followUps }], { turns: stored, transcriptTurnOffset: 0 });
    expect(changes.grownLast).toEqual({ ...stored[0], followUps });
    // Already stored with that follow-up: nothing to do.
    expect(diffTurns([{ ...stored[0]!, followUps }], { turns: [{ ...stored[0]!, followUps }] }).grownLast).toBeNull();
  });

  it('ignores a reply that changed without keeping the stored text as its prefix, or got shorter', () => {
    const stored = [turn(1, '2026-01-01T00:00:01Z', 'original reply')];
    expect(diffTurns([turn(1, '2026-01-01T00:00:01Z', 'rewritten reply that is longer')], { turns: stored }).grownLast).toBeNull();
    expect(diffTurns([turn(1, '2026-01-01T00:00:01Z', 'orig')], { turns: stored }).grownLast).toBeNull();
  });

  it('only matches by user message, and never when the stored turn has no timestamp', () => {
    expect(diffTurns([turn(1, '2026-01-01T00:00:09Z', 'a longer reply')], { turns: [turn(1, '2026-01-01T00:00:01Z', 'a')] }).grownLast).toBeNull();
    const untimed: Turn = { index: 1, user: { text: 'q1', at: null }, assistant: { text: 'a', at: null } };
    expect(diffTurns([{ ...untimed, assistant: { text: 'a longer reply', at: null } }], { turns: [untimed] }).grownLast).toBeNull();
  });
});

describe('polling.tick — a stored reply that keeps growing', () => {
  const first: Turn = { index: 1, user: { text: '請開始', at: '2026-01-01T00:00:01Z' }, assistant: { text: 'subagent started', at: '2026-01-01T00:00:02Z' } };
  const grown: Turn = { ...first, assistant: { text: 'subagent started\n\nreview done', at: '2026-01-01T00:00:02Z' } };

  it('updates it for a ready session once the transcript settles (e.g. woken by an isMeta hand-back)', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', [first]);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    parseMessages.mockResolvedValue([{ role: 'assistant', text: 'review done', ts: '2026-01-01T00:05:00Z' }]);
    parseTurns.mockResolvedValue([grown]);

    for (let i = 0; i < 3; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.turns).toEqual([grown]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    const dialogueStore = await import('../src/dialogue-store.js');
    expect(dialogueStore.upsertTurn).toHaveBeenCalledWith(expect.anything(), expect.anything(), grown);
    const summary = toPublicManagedSession(session!).conversations.at(-1)!;
    expect(summary.turnsCount).toBe(1);
    expect(summary.turnsFingerprint).toBe(`1:${grown.assistant.text.length}`);
  });

  it('refreshes it while waiting without claiming the awaited reply has landed', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', [first]);
    // The send being waited on came after that turn.
    const conversationId = (await registry.getSession(id))!.activeConversationId!;
    await registry.updateConversation(id, conversationId, { lastUserMessageAt: '2026-01-01T00:10:00Z' });
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([grown]);

    for (let i = 0; i < 3; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.turns).toEqual([grown]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'replying' });
  });

  it('lands together with a new turn and unlocks as usual', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', [first]);
    findPendingInteraction.mockResolvedValue(pendingResult());
    const next: Turn = { index: 2, user: { text: 'next', at: '2026-01-01T00:06:00Z' }, assistant: { text: 'ok', at: '2026-01-01T00:06:01Z' } };
    parseTurns.mockResolvedValue([grown, next]);

    for (let i = 0; i < 3; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.turns).toEqual([grown, next]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });
});

describe('polling.tick — following a transcript the CLI moved', () => {
  const old: Turn = { index: 1, user: { text: '請開始', at: '2026-01-01T00:00:01Z' }, assistant: { text: 'done', at: '2026-01-01T00:00:02Z' } };
  const later: Turn = { index: 2, user: { text: '開 worktree', at: '2026-01-01T00:10:00Z' }, assistant: { text: 'ok', at: '2026-01-01T00:10:05Z' } };

  // Claude Code entering a worktree moves <id>.jsonl, whole, into the
  // worktree's project directory: same name and id, old path gone.
  function moveTo(file: string, identity: 'pinned_id' | 'verified_metadata' = 'pinned_id') {
    missingFiles.add('/fake/old.jsonl');
    locateSessionFile.mockResolvedValue({ status: 'resolved', file, identity });
    parseTurns.mockImplementation(async (from) => (from === file ? [old, later] : []));
  }

  it('rebinds the same conversation to where the file went, then imports what came after', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/old.jsonl', [old]);
    const before = await registry.getSession(id);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    moveTo('/fake/worktree/old.jsonl');
    parseMessages.mockResolvedValue([{ role: 'assistant', text: 'ok', ts: '2026-01-01T00:10:05Z' }]);

    for (let i = 0; i < 4; i++) await polling.tick();

    const session = await registry.getSession(id);
    const conversation = session?.conversations?.find((c) => c.id === session.activeConversationId);
    expect(session?.conversations).toHaveLength(before!.conversations!.length);
    expect(conversation?.transcript).toMatchObject({ state: 'resolved', file: '/fake/worktree/old.jsonl', identity: 'pinned_id' });
    expect(conversation?.providerSessionId).toBe(before?.providerSessionId);
    expect(session?.providerSessionFile).toBe('/fake/worktree/old.jsonl');
    expect(session?.turns).toEqual([old, later]);
  });

  it('follows it while waiting too, and finishes the awaited turn from the new place', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/old.jsonl', [old]);
    moveTo('/fake/worktree/old.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());

    for (let i = 0; i < 4; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.providerSessionFile).toBe('/fake/worktree/old.jsonl');
    expect(session?.turns).toEqual([old, later]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
  });

  it('stays on the missing file unless the lookup finds it by the session id itself', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/old.jsonl', [old]);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    moveTo('/fake/elsewhere.jsonl', 'verified_metadata');

    for (let i = 0; i < 3; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.providerSessionFile).toBe('/fake/old.jsonl');
    expect(session?.turns).toEqual([old]);
  });
});

describe('polling.tick — following the CLI to a continued transcript', () => {
  const old: Turn = { index: 1, user: { text: '請開始', at: '2026-01-01T00:00:01Z' }, assistant: { text: 'done', at: '2026-01-01T00:00:02Z' } };
  const later: Turn = { index: 2, user: { text: '查看一下', at: '2026-01-01T00:10:00Z' }, assistant: { text: 'found it', at: '2026-01-01T00:10:05Z' } };

  function continueTo(file: string) {
    followContinuation.mockImplementation(async (from) => (from === '/fake/old.jsonl' ? { file, providerSessionId: 'new-session' } : null));
  }

  it('rebinds the same conversation and session id, then imports only what came after', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/old.jsonl', [old]);
    const before = await registry.getSession(id);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    continueTo('/fake/new.jsonl');
    parseMessages.mockResolvedValue([{ role: 'assistant', text: 'found it', ts: '2026-01-01T00:10:05Z' }]);
    // The new file repeats the old history before what's new.
    parseTurns.mockImplementation(async (file) => (file === '/fake/new.jsonl' ? [old, later] : [old]));

    for (let i = 0; i < 4; i++) await polling.tick();

    const session = await registry.getSession(id);
    const conversation = session?.conversations?.find((c) => c.id === session.activeConversationId);
    expect(session?.conversations).toHaveLength(before!.conversations!.length);
    expect(conversation?.id).toBe(before?.activeConversationId);
    expect(conversation?.transcript).toMatchObject({ state: 'resolved', file: '/fake/new.jsonl', identity: 'pinned_id' });
    expect(conversation?.providerSessionId).toBe('new-session');
    expect(session?.providerSessionId).toBe('new-session');
    expect(session?.providerSessionFile).toBe('/fake/new.jsonl');
    expect(session?.turns).toEqual([old, later]);
  });

  it('follows it while waiting too, and finishes the awaited turn from the new file', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/old.jsonl', [old]);
    continueTo('/fake/new.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockImplementation(async (file) => (file === '/fake/new.jsonl' ? [old, later] : [old]));

    for (let i = 0; i < 4; i++) await polling.tick();

    const session = await registry.getSession(id);
    expect(session?.providerSessionFile).toBe('/fake/new.jsonl');
    expect(session?.turns).toEqual([old, later]);
    expect(session).toMatchObject({ status: 'ready', turnPhase: 'idle' });
    expect(parseTurns).not.toHaveBeenCalledWith('/fake/old.jsonl');
  });

  it('leaves the binding alone when there is no continuation', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/old.jsonl', [old]);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    parseTurns.mockResolvedValue([old]);

    for (let i = 0; i < 3; i++) await polling.tick();

    expect((await registry.getSession(id))?.providerSessionFile).toBe('/fake/old.jsonl');
    expect(followContinuation).toHaveBeenCalledWith('/fake/old.jsonl');
  });
});

describe('polling.tick — stuck hint and control keys', () => {
  it('restarts the quiet clock when a control key is sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const id = await makeWaitingSession();
      await registry.updateSession(id, { lastUserMessageAt: new Date(Date.now() - 60_000).toISOString() });
      findPendingInteraction.mockResolvedValue(pendingResult());
      isTurnComplete.mockResolvedValue(completionResult(false));
      await polling.tick();

      vi.setSystemTime(Date.now() + 25_000);
      polling.noteControlKey(id);
      vi.setSystemTime(Date.now() + 10_000); // 35s of quiet file, but only 10s since the key
      await polling.tick();
      expect((await registry.getSession(id))?.stuckSince ?? null).toBeNull();

      vi.setSystemTime(Date.now() + 25_000);
      await polling.tick();
      expect((await registry.getSession(id))?.stuckSince).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });
});

// Edge paths pinned down before the conversation-sync refactor (so the
// refactor can be checked against them), and kept as regression guards.
describe('conversation sync — edge paths', () => {
  const t1: Turn = { index: 1, user: { text: 'q1', at: '2026-01-01T00:00:01Z' }, assistant: { text: 'a1', at: '2026-01-01T00:00:02Z' } };
  const t2: Turn = { index: 2, user: { text: 'q2', at: '2026-01-01T00:01:00Z' }, assistant: { text: 'a2', at: '2026-01-01T00:01:05Z' } };

  it('keeps polling after an unreadable transcript, in both waiting and ready', async () => {
    const waiting = await makeWaitingSession();
    await setTranscript(waiting, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([t1]);
    statFails = true;
    await polling.tick();
    expect((await registry.getSession(waiting))?.turns).toEqual([]);

    statFails = false;
    for (let i = 0; i < 3; i++) await polling.tick();
    expect((await registry.getSession(waiting))?.turns).toEqual([t1]);
    expect(await registry.getSession(waiting)).toMatchObject({ status: 'ready', turnPhase: 'idle' });

    // Now ready: an unreadable file is skipped the same way.
    parseTurns.mockResolvedValue([t1, t2]);
    statMtime += 1;
    statFails = true;
    await polling.tick();
    statFails = false;
    for (let i = 0; i < 3; i++) await polling.tick();
    expect((await registry.getSession(waiting))?.turns).toEqual([t1, t2]);
  });

  it('records an unresolvable transcript without importing, and binds once it resolves', async () => {
    const id = await makeWaitingSession();
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([t1]);
    locateSessionFile.mockResolvedValue({ status: 'ambiguous' });
    await polling.tick();
    let active = (await registry.getSession(id))?.conversations?.at(-1);
    expect(active?.transcript).toEqual({ state: 'ambiguous', file: null, identity: null });
    expect(active?.transcriptError).toContain('無法確定');
    expect(parseTurns).not.toHaveBeenCalled();

    locateSessionFile.mockResolvedValue({ status: 'not_found' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await registry.updateConversation(id, active!.id, { lastUserMessageAt: new Date().toISOString() });
      // Just sent: the CLI may not have written its transcript yet.
      await polling.tick();
      active = (await registry.getSession(id))?.conversations?.at(-1);
      expect(active?.transcript.state).toBe('pending');
      expect(active?.transcriptError).toBeNull();

      vi.setSystemTime(Date.now() + TRANSCRIPT_NOT_FOUND_GRACE_MS);
      await polling.tick();
      active = (await registry.getSession(id))?.conversations?.at(-1);
      expect(active?.transcript.state).toBe('not_found');
      expect(active?.transcriptError).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    locateSessionFile.mockResolvedValue({ status: 'resolved', file: '/fake/session.jsonl', identity: 'pinned_id' });
    for (let i = 0; i < 4; i++) await polling.tick();
    active = (await registry.getSession(id))?.conversations?.at(-1);
    expect(active?.transcript).toEqual({ state: 'resolved', file: '/fake/session.jsonl', identity: 'pinned_id' });
    expect(active?.turns).toEqual([t1]);
  });

  it('never lets a ready session import before a recovered runtime has its baseline', async () => {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    const session = await registry.getSession(id);
    await registry.updateConversation(id, session!.activeConversationId!, { startReason: 'runtime_recovery', transcriptTurnOffset: null });
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    parseTurns.mockResolvedValue([t1]);
    parseMessages.mockResolvedValue([{ role: 'assistant', text: 'a1', ts: '2026-01-01T00:00:02Z' }]);

    for (let i = 0; i < 3; i++) await polling.tick();

    expect((await registry.getSession(id))?.turns).toEqual([]);
    expect((await registry.getSession(id))?.conversations?.at(-1)?.transcriptTurnOffset).toBe(1);

    const nextTurn: Turn = { index: 2, user: { text: 'after recovery', at: '2026-01-01T00:00:03Z' }, assistant: { text: 'new', at: '2026-01-01T00:00:04Z' } };
    parseTurns.mockResolvedValue([t1, nextTurn]);
    statMtime++;
    for (let i = 0; i < 4; i++) await polling.tick();
    expect((await registry.getSession(id))?.turns).toEqual([nextTurn]);
  });

  it('runs without continuation support (Codex/Gemini adapters have none)', async () => {
    continuationSupported = false;
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl');
    findPendingInteraction.mockResolvedValue(pendingResult());
    parseTurns.mockResolvedValue([t1]);

    for (let i = 0; i < 3; i++) await polling.tick();

    const after = await registry.getSession(id);
    expect(after?.turns).toEqual([t1]);
    expect(after?.providerSessionFile).toBe('/fake/session.jsonl');
  });

  it('diffTurns borrows the parsed reply time when the stored one had none', () => {
    const stored: Turn = { ...t1, assistant: { text: 'a1', at: null } };
    const grown = diffTurns([{ ...t1, assistant: { text: 'a1 and more', at: '2026-01-01T00:00:09Z' } }], { turns: [stored] }).grownLast;
    expect(grown?.assistant).toEqual({ text: 'a1 and more', at: '2026-01-01T00:00:09Z' });
  });
});

describe('polling.importTurnsAfterStop — edge paths', () => {
  const t1: Turn = { index: 1, user: { text: '請開始', at: '2026-01-01T00:00:01Z' }, assistant: { text: 'started', at: '2026-01-01T00:00:02Z' } };

  async function stoppedWith(stored: Turn[]): Promise<string> {
    const id = await makeWaitingSession();
    await setTranscript(id, '/fake/session.jsonl', stored);
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    return id;
  }

  it('closes a stored turn whose reply grew and was then interrupted (stopped after an isMeta wake-up)', async () => {
    const id = await stoppedWith([t1]);
    const interrupted: Turn = { ...t1, assistant: { text: 'started\n\nmore', at: t1.assistant.at, interrupted: true } };
    parseTurns.mockResolvedValue([interrupted]);

    await polling.importTurnsAfterStop(id);

    expect((await registry.getSession(id))?.turns).toEqual([interrupted]);
  });

  it('gives up quietly at the timeout when nothing new ever shows up', async () => {
    vi.useFakeTimers();
    try {
      const id = await stoppedWith([t1]);
      parseTurns.mockResolvedValue([t1]);
      const done = polling.importTurnsAfterStop(id);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect((await registry.getSession(id))?.turns).toEqual([t1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing without a resolved transcript', async () => {
    const id = await makeWaitingSession();
    await registry.updateSession(id, { status: 'ready', turnPhase: 'idle' });
    await polling.importTurnsAfterStop(id);
    expect(parseTurns).not.toHaveBeenCalled();
  });
});

describe('startPolling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never starts a tick while the previous one is still running', async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxRunning = 0;
    let finishSlowTick: () => void = () => {};
    const runTick = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (runTick.mock.calls.length === 1) await new Promise<void>((resolve) => { finishSlowTick = resolve; });
      running -= 1;
    });
    const handle = polling.startPolling(runTick);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);
    // Many intervals pass while the first tick hangs: no second tick yet.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(runTick).toHaveBeenCalledTimes(1);

    finishSlowTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(runTick).toHaveBeenCalledTimes(1); // the gap still applies after a slow tick
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
    handle.stop();
  });

  it('keeps polling after a failed tick, logging it, and stops when asked', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runTick = vi.fn(async () => { throw new Error('boom'); });
    const handle = polling.startPolling(runTick);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(runTick).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('[polling] tick failed', expect.any(Error));

    handle.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(runTick).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
