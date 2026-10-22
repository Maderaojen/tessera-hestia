import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityObservation, RuntimeDriver } from '../../src/runtimes/types.js';
import type { ConversationSegment, ManagedSession } from '../../src/types.js';

const tmux = {
  getPaneRuntimePid: vi.fn(async (..._args: unknown[]): Promise<number | null> => 4242),
  capturePane: vi.fn(async (..._args: unknown[]) => ''),
  sendKey: vi.fn(async (..._args: unknown[]) => {}),
};
vi.mock('../../src/tmux.js', () => ({
  getPaneRuntimePid: (...args: unknown[]) => tmux.getPaneRuntimePid(...args),
  capturePane: (...args: unknown[]) => tmux.capturePane(...args),
  sendKey: (...args: unknown[]) => tmux.sendKey(...args),
}));
const requestRuntimeExit = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../src/sync/exit.js', () => ({ requestRuntimeExit: (...args: unknown[]) => requestRuntimeExit(...args) }));

const {
  settleResumedIdentity, RESUME_CONFLICT_MESSAGE, RESUME_MISMATCH_MESSAGE, RESUME_STARTUP_PROMPT_MESSAGE, RESUME_UNCONFIRMED_MESSAGE,
} = await import('../../src/sync/resumeIdentity.js');
const { codexCliRuntime } = await import('../../src/runtimes/codex-cli.js');
const { claudeCodeRuntime } = await import('../../src/runtimes/claude-code.js');
const { RESUME_IDENTITY_TIMEOUT_MS } = await import('../../src/config.js');
const { t } = await import('../../src/i18n/index.js');

const SID = '01a10a0a-577d-78f0-b390-d594bfdf9eac';
const OTHER = '01a10a04-6d0c-7e82-8678-5bd980cdb65b';
const DISPATCHED = '2026-10-05T03:00:00.000Z';
const SOON = Date.parse(DISPATCHED) + 2_000;
const CONFLICT = [
  '• DAEMON-OK',
  '  🔒  This conversation is open in another app                    r to retry',
  '      Close it there and press R to continue here.',
  '   r retry   f fork   esc/ctrl+c/q exit   ctrl+t transcript',
].join('\n');

const session = { id: 's1', tmuxName: 'hestia-s1' } as ManagedSession;
const conversation = {
  id: 'c1', providerSessionId: SID, startedAt: '2026-10-01T00:00:00.000Z',
  launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/h/.codex', delegate: { kind: 'native', executable: 'codex' } },
} as ConversationSegment;

function codexObserving(observation: IdentityObservation): RuntimeDriver {
  return { ...codexCliRuntime, identity: { kind: 'observed_after_start', observe: async () => observation } };
}
const holding = (id: string): IdentityObservation => ({ status: 'resolved', providerSessionId: id, evidence: 'process_thread_lock' });
const holdingNone: IdentityObservation = { status: 'unobservable', reason: 'holds 0 thread locks (need exactly 1)' };

beforeEach(() => {
  vi.clearAllMocks();
  tmux.getPaneRuntimePid.mockResolvedValue(4242);
  tmux.capturePane.mockResolvedValue('');
});

describe('settleResumedIdentity', () => {
  it('confirms a runtime whose id is pinned on the command line without looking', async () => {
    const verdict = await settleResumedIdentity({ session, runtime: claudeCodeRuntime, conversation, dispatchedAt: DISPATCHED, now: SOON });
    expect(verdict).toEqual({ verdict: 'confirmed' });
    expect(tmux.getPaneRuntimePid).not.toHaveBeenCalled();
  });

  it('confirms once the CLI holds exactly the resumed conversation', async () => {
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving(holding(SID.toUpperCase())), conversation, dispatchedAt: DISPATCHED, now: SOON });
    expect(verdict).toEqual({ verdict: 'confirmed' });
    expect(requestRuntimeExit).not.toHaveBeenCalled();
  });

  it('exits a CLI holding another conversation', async () => {
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving(holding(OTHER)), conversation, dispatchedAt: DISPATCHED, now: SOON });
    expect(verdict).toEqual({ verdict: 'failed', message: t(RESUME_MISMATCH_MESSAGE) });
    expect(requestRuntimeExit).toHaveBeenCalledWith('hestia-s1', expect.anything(), 'idle');
  });

  it('leaves the "open in another app" screen with its own key, never typing into it', async () => {
    tmux.capturePane.mockResolvedValue(CONFLICT);
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving(holdingNone), conversation, dispatchedAt: DISPATCHED, now: SOON });
    expect(verdict).toEqual({ verdict: 'failed', message: t(RESUME_CONFLICT_MESSAGE) });
    expect(tmux.sendKey).toHaveBeenCalledWith('hestia-s1', 'Escape');
    expect(requestRuntimeExit).not.toHaveBeenCalled();
  });

  it('keeps waiting while the lock is not visible yet', async () => {
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving({ status: 'pending', reason: 'x' }), conversation, dispatchedAt: DISPATCHED, now: SOON });
    expect(verdict).toEqual({ verdict: 'waiting', message: null });
    expect(tmux.sendKey).not.toHaveBeenCalled();
    expect(requestRuntimeExit).not.toHaveBeenCalled();
  });

  it('waits on a start-up prompt however long it takes, telling the user to answer it', async () => {
    tmux.capturePane.mockResolvedValue('Trust this folder? Codex can read, edit, and run files here\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit');
    const late = Date.parse(DISPATCHED) + RESUME_IDENTITY_TIMEOUT_MS * 3;
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving(holdingNone), conversation, dispatchedAt: DISPATCHED, now: late });
    expect(verdict).toEqual({ verdict: 'waiting', message: t(RESUME_STARTUP_PROMPT_MESSAGE) });
  });

  it('gives up and exits the CLI once the identity stays unconfirmed past the timeout', async () => {
    const late = Date.parse(DISPATCHED) + RESUME_IDENTITY_TIMEOUT_MS;
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving(holdingNone), conversation, dispatchedAt: DISPATCHED, now: late });
    expect(verdict).toEqual({ verdict: 'failed', message: t(RESUME_UNCONFIRMED_MESSAGE) });
    expect(requestRuntimeExit).toHaveBeenCalledTimes(1);
  });

  it('looks at the pane even when the CLI process is not found yet', async () => {
    tmux.getPaneRuntimePid.mockResolvedValue(null);
    tmux.capturePane.mockResolvedValue(CONFLICT);
    const verdict = await settleResumedIdentity({ session, runtime: codexObserving(holding(SID)), conversation, dispatchedAt: DISPATCHED, now: SOON });
    expect(verdict.verdict).toBe('failed');
  });
});
