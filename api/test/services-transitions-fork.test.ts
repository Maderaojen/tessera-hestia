import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSegment } from '../src/types.js';

// transitions.launch with `fork`: a branch line's CLI forks the conversation
// it came from (ADR 0023 決策 3), claimed as a launch that remembers it.

const sendCommandLine = vi.fn(async (_target: string, _argv: string[]) => {});
vi.mock('../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  sessionPresence: vi.fn(async () => 'present'),
  sendCommandLine: (target: string, argv: string[]) => sendCommandLine(target, argv),
}));

// The CLIs are there: whether one is installed is runtimes/command-check's own test.
vi.mock('../src/runtimes/command-check.js', () => ({ checkCommandAvailable: async () => 'found' }));

vi.mock('../src/launch-profiles.js', () => ({
  getLaunchProfileCatalog: async () => ({
    profiles: [
      { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', label: 'Claude', executable: 'claude', args: [] },
      { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', label: 'Codex', executable: 'codex', args: [] },
    ],
  }),
}));

const FROM = 'a13782f4-715f-4abc-9233-2207319a1234';

function mainConversation(patch: Partial<ConversationSegment> = {}): ConversationSegment {
  return {
    id: 'main-c1', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code',
    launchProfile: { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', delegate: { kind: 'native', executable: 'claude' } },
    providerSessionId: FROM, startedAt: '2026-10-08T09:00:00.000Z', endedAt: null, startReason: 'launch', endReason: null,
    transcript: { state: 'resolved', file: '/home/test/.claude/projects/p/a.jsonl', identity: 'pinned_id' },
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    ...patch,
  };
}

let registry: typeof import('../src/registry.js');
let transitions: typeof import('../src/services/transitions.js');

beforeEach(async () => {
  vi.resetModules();
  registry = await import('../src/registry.js');
  transitions = await import('../src/services/transitions.js');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('a forked launch', () => {
  it('types the runtime\'s fork command and remembers where it forked from', async () => {
    const session = await registry.createSession('/work/hestia-fork-ab12', 'proj-1');
    const result = await transitions.launch(session.id, { profileId: 'native:claude', fork: { sessionId: 'main', conversation: mainConversation() } });
    expect(result.ok).toBe(true);
    const argv = sendCommandLine.mock.calls[0]![1];
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 4)).toEqual(['--resume', FROM, '--fork-session', '--session-id']);
    const pending = (await registry.getSession(session.id))?.launchPending;
    expect(pending?.fork).toEqual({ fromSessionId: 'main', fromConversationId: 'main-c1' });
    expect(pending?.providerSessionId).toBe(argv[argv.indexOf('--session-id') + 1]);
  });

  it('refuses a profile of another runtime, or a conversation that can\'t be forked, before anything is typed', async () => {
    const session = await registry.createSession('/work/hestia-fork-cd34', 'proj-1');
    const other = await transitions.launch(session.id, { profileId: 'native:codex', fork: { sessionId: 'main', conversation: mainConversation() } });
    expect(other).toMatchObject({ ok: false, code: 'launch_config_incomplete' });
    const unbound = await transitions.launch(session.id, { profileId: 'native:claude', fork: { sessionId: 'main', conversation: mainConversation({ providerSessionId: null }) } });
    expect(unbound).toMatchObject({ ok: false, code: 'launch_config_incomplete' });
    expect(sendCommandLine).not.toHaveBeenCalled();
  });
});
