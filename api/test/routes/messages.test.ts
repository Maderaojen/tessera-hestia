import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedSession } from '../../src/types.js';
import { readClaudeInteraction } from '../../src/providers/claude-interaction.js';
import { interactionId } from '../../src/sync/interaction.js';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  sendText: vi.fn(async () => {}),
  pasteText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  typeText: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  capturePane: vi.fn(async () => ''),
  getPaneSize: vi.fn(async () => null),
  sessionPresence: vi.fn(async () => 'present'),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'C-c'],
}));

vi.mock('../../src/polling.js', () => ({
  importTurnsAfterStop: vi.fn(async () => {}),
  noteControlKey: vi.fn(),
  refreshPendingInteraction: vi.fn(async () => {}),
}));

vi.mock('../../src/registry.js', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  markDeadUnlessRunning: vi.fn(async () => []),
  updateSession: vi.fn(),
  updateConversation: vi.fn(),
  beginPendingClear: vi.fn(),
  notePendingClearDelivery: vi.fn(async () => undefined),
  releaseClearAttempt: vi.fn(),
  removeSession: vi.fn(),
  reconcile: vi.fn(async () => {}),
}));

const registry = await import('../../src/registry.js');
const tmuxCli = await import('../../src/tmux.js');
const polling = await import('../../src/polling.js');

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1',
    tmuxName: 'hestia-sess-1',
    cwd: '/some/project',
    projectId: 'proj-1',
    alias: null,
    createdAt: '2026-01-01T00:00:00Z',
    provider: 'claude',
    providerSessionId: 'abc',
    providerSessionFile: null,
    providerLaunchedAt: '2026-01-01T00:00:00Z',
    status: 'ready',
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    lastError: null,
    pendingInteraction: null,
    turns: [],
    turnsSourceFile: null,
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: null, providerSessionId: 'abc',
      startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'launch', endReason: null,
      transcript: { state: 'pending', file: null, identity: null }, lastUserMessageAt: null, lastUserMessageText: null,
      deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    }],
    ...overrides,
  };
}

let auth: string;

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
});

afterEach(() => {
  // Reset, not just clear: an unconsumed mockResolvedValueOnce must never
  // leak into the next test (vitest 3 restores each vi.fn's own default).
  vi.resetAllMocks();
});

describe('POST /api/sessions/:id/messages', () => {
  it('400s on empty text', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '' });
    expect(res.status).toBe(400);
  });

  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nope/messages')
      .set('Authorization', auth)
      .send({ text: 'hi' });
    expect(res.status).toBe(404);
  });

  it('409s when the session is dead', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/messages')
      .set('Authorization', auth)
      .send({ text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/dead/);
    expect(res.body.code).toBe('session_dead');
  });

  it('409s, typing nothing, when the tmux is gone though the record still says ready', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({ status: 'ready' }));
    vi.mocked(registry.listSessions).mockResolvedValue([]);
    vi.mocked(tmuxCli.sessionPresence).mockResolvedValue('gone');
    for (const text of ['hi', '/clear']) {
      const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('session_dead');
    }
    const cleared = await request(createApp()).post('/api/sessions/sess-1/clear').set('Authorization', auth).send();
    expect(cleared.body.code).toBe('session_dead');
    // Reconciled the way GET /sessions would have.
    expect(registry.markDeadUnlessRunning).toHaveBeenCalled();
    expect(tmuxCli.pasteText).not.toHaveBeenCalled();
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });

  // Sending is deliberately not gated on status === 'ready' — a session
  // stuck in 'waiting' (e.g. a slash command that never produces a real
  // transcript entry — see conversation notes) would otherwise become
  // permanently unable to accept new input, which is worse than the risk
  // of a send landing while the CLI isn't actually listening.
  it('still sends text even when the session is already waiting', async () => {
    const session = makeSession({ status: 'ready', turnPhase: 'replying' });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(makeSession({ status: 'ready', turnPhase: 'replying' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/messages')
      .set('Authorization', auth)
      .send({ text: 'hi' });
    expect(res.status).toBe(202);
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, 'hi');
  });

  it("pastes into a Codex pane with the Codex driver's submit delay", async () => {
    const base = makeSession();
    const session = makeSession({
      provider: 'codex', runtimeId: 'codex-cli',
      conversations: [{ ...base.conversations![0]!, provider: 'codex', runtimeId: 'codex-cli' }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(session);
    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: 'hi' });
    expect(res.status).toBe(202);
    expect(tmuxCli.pasteText).toHaveBeenCalledWith(session.tmuxName, 'hi', 100);
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('sends text, sets status to waiting, records lastUserMessageText, returns 202', async () => {
    const session = makeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(makeSession({ status: 'ready', turnPhase: 'replying' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/messages')
      .set('Authorization', auth)
      .send({ text: 'hello there' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('waiting');
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, 'hello there');
    expect(registry.updateConversation).toHaveBeenCalledWith(session.id, 'conversation-1', expect.objectContaining({
      lastUserMessageText: 'hello there',
      deliveryUnconfirmedText: null,
    }), { turnPhase: 'replying' });
  });

  it('keeps tracking an earlier unconfirmed send when a new message is sent', async () => {
    const earlier = { text: '第一個問題', at: '2026-09-25T10:00:00.000Z', flagged: false };
    const session = makeSession({
      conversations: [{ ...makeSession().conversations![0]!, unconfirmedSends: [earlier] }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(makeSession({ status: 'ready', turnPhase: 'replying' }));

    await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: 'Hi' });

    const patch = vi.mocked(registry.updateConversation).mock.calls[0]![2];
    expect(patch.unconfirmedSends).toEqual([earlier, { text: 'Hi', at: expect.any(String), flagged: false }]);
  });

  it('remembers which parts of a send were pasted, adding to the ones before', async () => {
    const earlier = { head: 'older paste', length: 11, hash: 'abc' };
    const session = makeSession({
      conversations: [{ ...makeSession().conversations![0]!, pastedTexts: [earlier] }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(makeSession({ status: 'ready', turnPhase: 'replying' }));
    const text = '看這段\n\npasted block of text';

    await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth)
      .send({ text, pastes: [{ start: 5, end: text.length }] });

    const patch = vi.mocked(registry.updateConversation).mock.calls[0]![2];
    expect(patch.pastedTexts).toEqual([earlier, { head: 'pasted block of text', length: 20, hash: expect.any(String) }]);
  });

  it('400s on pastes that are not ranges', async () => {
    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth)
      .send({ text: 'hi', pastes: [{ start: -1, end: 'x' }] });
    expect(res.status).toBe(400);
  });

  it('turns Claude /clear into one exit request and immediately reports restarting', async () => {
    const profile = {
      id: 'native:claude', provider: 'claude' as const, source: 'native' as const,
      home: '/home/test/.claude', conversationRoot: '/home/test/.claude/projects',
      args: ['--dangerously-skip-permissions'],
      delegate: { kind: 'native' as const, executable: 'claude' },
    };
    const session = makeSession({
      launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => makeSession({
      ...session,
      status: 'launching',
      clearPending: attempt,
    }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/messages')
      .set('Authorization', auth)
      .send({ text: ' /clear ' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('launching');
    expect(res.body.claudeClearPending).toBe(true);
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, '/exit');
    expect(registry.beginPendingClear).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ conversationId: 'conversation-1', phase: 'waiting_exit', newProviderSessionId: expect.any(String) }),
    );
    expect(vi.mocked(registry.beginPendingClear).mock.calls[0]?.[1].launchArgv).toEqual([
      'env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', 'claude', '--dangerously-skip-permissions', '--session-id', expect.any(String),
    ]);
    expect(tmuxCli.sendText).not.toHaveBeenCalledWith(session.tmuxName, '/clear');
  });

  it('uses the saved Janus profile when restarting Claude after /clear', async () => {
    const profile = {
      id: 'janus:work', provider: 'claude' as const, source: 'janus' as const, profileName: 'work',
      home: '/janus/work', conversationRoot: '/janus/work/projects',
      delegate: { kind: 'janus' as const, executable: '/usr/local/bin/janus' },
    };
    const session = makeSession({
      launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => makeSession({
      ...session, status: 'launching', clearPending: attempt,
    }));
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '/clear' });

    expect(res.status).toBe(202);
    expect(vi.mocked(registry.beginPendingClear).mock.calls[0]?.[1].launchArgv).toEqual([
      'env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/usr/local/bin/janus', 'run', 'work', '--session-id', expect.any(String),
    ]);
  });

  it.each([
    { provider: 'codex' as const, runtimeId: 'codex-cli' as const, executable: 'codex', exit: 'control' as const },
    { provider: 'gemini' as const, runtimeId: 'agy' as const, executable: 'agy', exit: 'text' as const },
  ])('starts a fresh $runtimeId after its validated exit plan', async ({ provider, runtimeId, executable, exit }) => {
    const profile = {
      id: `native:${executable}`, provider, runtimeId, source: 'native' as const,
      home: `/private/${executable}`, conversationRoot: `/private/${executable}/conversations`,
      delegate: { kind: 'native' as const, executable },
    };
    const session = makeSession({
      provider, runtimeId, providerSessionId: null, launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, provider, runtimeId, providerSessionId: null, launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => makeSession({
      ...session, status: 'launching', clearPending: attempt,
    }));

    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '/clear' });

    expect(res.status).toBe(202);
    expect(registry.beginPendingClear).toHaveBeenCalledWith(session.id, expect.objectContaining({
      runtimeId, provider, phase: 'waiting_exit', delivery: 'exit_uncertain', newProviderSessionId: null,
      launchArgv: runtimeId === 'codex-cli' ? ['env', 'CODEX_HOME=/private/codex', 'codex', '-c', 'check_for_update_on_startup=false', '--no-daemon'] : ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'],
    }));
    if (exit === 'control') expect(tmuxCli.sendKey).toHaveBeenCalledWith(session.tmuxName, 'C-c');
    else expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, '/exit');
    expect(registry.notePendingClearDelivery).toHaveBeenCalledWith(session.id, expect.any(String), 'confirmed');
  });

  it('interrupts a replying Codex before its exit key, since C-c mid-turn only interrupts', async () => {
    const profile = {
      id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, source: 'native' as const,
      home: '/private/codex', conversationRoot: '/private/codex/sessions', delegate: { kind: 'native' as const, executable: 'codex' },
    };
    const session = makeSession({
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, launchProfile: profile, turnPhase: 'replying',
      conversations: [{ ...makeSession().conversations![0]!, provider: 'codex', runtimeId: 'codex-cli', providerSessionId: null, launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => makeSession({ ...session, status: 'launching', clearPending: attempt }));

    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '/clear' });

    expect(res.status).toBe(202);
    expect(vi.mocked(tmuxCli.sendKey).mock.calls).toEqual([[session.tmuxName, 'Escape'], [session.tmuxName, 'C-c']]);
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('refuses /clear mid-reply for a runtime without a verified interrupt, sending nothing', async () => {
    const profile = {
      id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const, source: 'native' as const,
      home: '/private/agy', conversationRoot: '/private/agy/conversations', delegate: { kind: 'native' as const, executable: 'agy' },
    };
    const session = makeSession({
      provider: 'gemini', runtimeId: 'agy', providerSessionId: null, launchProfile: profile, turnPhase: 'replying',
      conversations: [{ ...makeSession().conversations![0]!, provider: 'gemini', runtimeId: 'agy', providerSessionId: null, launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);

    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '/clear' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('請先停止回覆');
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('retains the clear reservation if exit delivery is uncertain', async () => {
    const profile = {
      id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const, source: 'native' as const,
      home: '/private/agy', conversationRoot: '/private/agy/conversations',
      delegate: { kind: 'native' as const, executable: 'agy' },
    };
    const session = makeSession({
      provider: 'gemini', runtimeId: 'agy', launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, provider: 'gemini', runtimeId: 'agy', launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => makeSession({
      ...session, clearPending: attempt,
    }));
    vi.mocked(tmuxCli.sendText).mockRejectedValueOnce(new Error('tmux delivery unknown'));

    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '/clear' });

    expect(res.status).toBe(503);
    expect(registry.notePendingClearDelivery).toHaveBeenCalledWith(session.id, expect.any(String), 'exit_uncertain', expect.any(String));
    expect(registry.releaseClearAttempt).toHaveBeenCalled();
  });

  it('fails closed for a provider whose exit capability is not validated', async () => {
    const session = makeSession({ provider: 'codex' });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '/clear' });

    expect(res.status).toBe(409);
    expect(tmuxCli.sendText).not.toHaveBeenCalledWith(session.tmuxName, '/clear');
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id/messages', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/sessions/nope/messages').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('returns the status/turns/lastError/pendingInteraction shape', async () => {
    const session = makeSession({
      turns: [{ index: 0, user: { text: 'hi', at: 't1' }, assistant: { text: 'hello', at: 't2' } }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1/messages').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: session.status,
      turns: [{ ...session.turns[0], user: { ...session.turns[0]!.user, attachments: [] } }],
      lastError: session.lastError,
      pendingInteraction: session.pendingInteraction,
    });
  });
});

describe('POST /api/sessions/:id/respond', () => {
  it('400s on an invalid body (neither key nor text)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/respond').set('Authorization', auth).send({});
    expect(res.status).toBe(400);
  });

  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nope/respond')
      .set('Authorization', auth)
      .send({ key: 'Enter' });
    expect(res.status).toBe(404);
  });

  it('409s when there is no running CLI (no provider)', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ provider: null }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/respond')
      .set('Authorization', auth)
      .send({ key: 'Enter' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'no_running_cli', params: { status: expect.any(String) } });
  });

  it('409s when the session is dead', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/respond')
      .set('Authorization', auth)
      .send({ key: 'Enter' });
    expect(res.status).toBe(409);
  });

  it('sends a control key and returns 202', async () => {
    const session = makeSession({ status: 'ready', turnPhase: 'awaiting_approval' });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/respond')
      .set('Authorization', auth)
      .send({ key: 'Escape' });
    expect(res.status).toBe(202);
    expect(tmuxCli.sendKey).toHaveBeenCalledWith(session.tmuxName, 'Escape');
    // A keypress restarts the stuck-hint clock without pretending a message was sent.
    expect(polling.noteControlKey).toHaveBeenCalledWith('sess-1');
    expect(registry.updateConversation).not.toHaveBeenCalled();
  });

  it('sends free text and returns 202', async () => {
    const session = makeSession({ status: 'ready', turnPhase: 'awaiting_approval' });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/respond')
      .set('Authorization', auth)
      .send({ text: 'yes' });
    expect(res.status).toBe(202);
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, 'yes');
  });

  it('rejects a key outside the known CONTROL_KEYS set', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/respond')
      .set('Authorization', auth)
      .send({ key: 'NotARealKey' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/:id/resume', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).post('/api/sessions/nope/resume').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it("409s when the session isn't waiting/needs_interaction", async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'ready' }));
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/resume').set('Authorization', auth);
    expect(res.status).toBe(409);
  });

  it('resumes a needs_interaction session back to ready, clearing pendingInteraction/lastError', async () => {
    const session = makeSession({
      status: 'ready',
      turnPhase: 'awaiting_approval',
      pendingInteraction: { kind: 'tool_permission', toolUseId: 't1', toolName: 'Write', input: {}, detectedAt: 'x' },
      lastError: 'stuck',
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(
      makeSession({ status: 'ready', turnPhase: 'idle', pendingInteraction: null, lastError: null }),
    );
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/resume').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.pendingInteraction).toBeNull();
    expect(res.body.lastError).toBeNull();
  });
});

describe('POST /api/sessions/:id/stop', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).post('/api/sessions/nope/stop').set('Authorization', auth);
    expect(res.status).toBe(404);
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });

  it('409s without sending anything when the session is dead', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/stop').set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });

  it('sends Esc into tmux and unlocks a waiting session straight to ready', async () => {
    const session = makeSession({ status: 'ready', turnPhase: 'replying', lastError: 'stuck' });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(makeSession({ status: 'ready', lastError: null }));
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/stop').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(tmuxCli.sendKey).toHaveBeenCalledWith(session.tmuxName, 'Escape');
    expect(registry.updateConversation).toHaveBeenCalledWith('sess-1', 'conversation-1', { pendingInteraction: null }, {
      turnPhase: 'idle',
      pendingInteraction: null,
      lastError: null,
      stuckSince: null,
    });
    expect(res.body.status).toBe('ready');
    expect(polling.importTurnsAfterStop).toHaveBeenCalledWith('sess-1');
  });

  it('still sends Esc but leaves state alone when the session is already ready', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'ready' }));
    const app = createApp();
    const res = await request(app).post('/api/sessions/sess-1/stop').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(tmuxCli.sendKey).toHaveBeenCalledWith('hestia-sess-1', 'Escape');
    expect(registry.updateConversation).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/undelivered/dismiss', () => {
  const lost = { text: '第一個問題', at: '2026-09-25T10:00:00.000Z', flagged: true };
  const later = { text: 'Hi', at: '2026-09-25T10:00:30.000Z', flagged: true };

  it('drops only the named send and keeps the pending bubble flag in step', async () => {
    const session = makeSession({
      lastUserMessageText: 'Hi',
      conversations: [{ ...makeSession().conversations![0]!, lastUserMessageText: 'Hi', unconfirmedSends: [lost, later] }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(session);

    const res = await request(createApp()).post('/api/sessions/sess-1/undelivered/dismiss').set('Authorization', auth).send({ sentAt: lost.at });

    expect(res.status).toBe(200);
    expect(registry.updateConversation).toHaveBeenCalledWith('sess-1', 'conversation-1', { unconfirmedSends: [later], deliveryUnconfirmedText: 'Hi' });
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('is a no-op for a send that is no longer tracked', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());

    const res = await request(createApp()).post('/api/sessions/sess-1/undelivered/dismiss').set('Authorization', auth).send({ sentAt: lost.at });

    expect(res.status).toBe(200);
    expect(registry.updateConversation).not.toHaveBeenCalled();
  });

  it('400s without sentAt and 404s without an active conversation', async () => {
    expect((await request(createApp()).post('/api/sessions/sess-1/undelivered/dismiss').set('Authorization', auth).send({})).status).toBe(400);
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ activeConversationId: null }));
    expect((await request(createApp()).post('/api/sessions/sess-1/undelivered/dismiss').set('Authorization', auth).send({ sentAt: lost.at })).status).toBe(404);
  });
});

describe('start-up prompts (workspace trust)', () => {
  const TRUST = [
    'Do you trust the contents of this project?',
    'Antigravity CLI requires permission to read, edit, and execute files here.',
    '> Yes, I trust this folder',
    '  No, exit',
    '  ↑/↓ Navigate · enter Confirm',
  ].join('\n');
  function agySession(overrides: Partial<ManagedSession> = {}): ManagedSession {
    const profile = {
      id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const, source: 'native' as const,
      home: '/private/agy', conversationRoot: '/private/agy/conversations', delegate: { kind: 'native' as const, executable: 'agy' },
    };
    return makeSession({
      provider: 'gemini', runtimeId: 'agy', providerSessionId: null, launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, provider: 'gemini', runtimeId: 'agy', providerSessionId: null, launchProfile: profile }],
      ...overrides,
    });
  }

  // The legacy Gemini CLI has no start-up prompt the app knows how to read.
  function geminiCliSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
    return makeSession({
      provider: 'gemini', runtimeId: 'gemini-cli',
      conversations: [{ ...makeSession().conversations![0]!, provider: 'gemini', runtimeId: 'gemini-cli' }],
      ...overrides,
    });
  }

  it('does not type a message into a recognized trust prompt, and says why', async () => {
    const session = agySession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(tmuxCli.capturePane).mockResolvedValueOnce(TRUST);

    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: '第一個問題' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('trust');
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(registry.updateSession).toHaveBeenCalledWith(session.id, { startupPrompt: { kind: 'workspace_trust', detectedAt: expect.any(String) } });
    expect(registry.updateConversation).not.toHaveBeenCalled();
  });

  it('sends normally when the pane shows no recognized prompt', async () => {
    const session = agySession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(tmuxCli.capturePane).mockResolvedValueOnce('> \n? for shortcuts');
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(agySession({ status: 'ready', turnPhase: 'replying' }));

    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: 'Hi' });

    expect(res.status).toBe(202);
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, 'Hi');
  });

  it('never reads the pane for a runtime without a known start-up prompt', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(geminiCliSession());
    vi.mocked(registry.updateConversation).mockResolvedValueOnce(geminiCliSession({ status: 'ready', turnPhase: 'replying' }));

    await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: 'hello' });

    expect(tmuxCli.capturePane).not.toHaveBeenCalled();
  });

  it('answers the prompt with the chosen option, confirming only a positively selected one', async () => {
    const session = agySession({ startupPrompt: { kind: 'workspace_trust', detectedAt: '2026-09-25T10:00:00.000Z' } });
    vi.mocked(registry.getSession).mockResolvedValue(session);
    vi.mocked(tmuxCli.capturePane).mockResolvedValueOnce(TRUST).mockResolvedValueOnce('> \n? for shortcuts');

    const res = await request(createApp()).post('/api/sessions/sess-1/startup-prompt').set('Authorization', auth).send({ choice: 'trust' });

    expect(res.status).toBe(200);
    expect(vi.mocked(tmuxCli.sendKey).mock.calls).toEqual([[session.tmuxName, 'Enter']]);
    expect(registry.updateSession).toHaveBeenCalledWith(session.id, { startupPrompt: null });
  });

  it('refuses an answer for a runtime without a known start-up prompt, and validates the choice', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(geminiCliSession());
    expect((await request(createApp()).post('/api/sessions/sess-1/startup-prompt').set('Authorization', auth).send({ choice: 'trust' })).status).toBe(409);
    expect((await request(createApp()).post('/api/sessions/sess-1/startup-prompt').set('Authorization', auth).send({ choice: 'maybe' })).status).toBe(400);
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/clear', () => {
  const clear = () => request(createApp()).post('/api/sessions/sess-1/clear').set('Authorization', auth).send();
  function claudeSession(): ManagedSession {
    const profile = {
      id: 'native:claude', provider: 'claude' as const, source: 'native' as const,
      home: '/home/test/.claude', conversationRoot: '/home/test/.claude/projects', args: [],
      delegate: { kind: 'native' as const, executable: 'claude' },
    };
    return makeSession({ launchProfile: profile, conversations: [{ ...makeSession().conversations![0]!, launchProfile: profile }] });
  }

  it('restarts the conversation exactly as a /clear typed into the composer does', async () => {
    const session = claudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(registry.beginPendingClear).mockImplementationOnce(async (_id, attempt) => makeSession({ ...session, status: 'launching', clearPending: attempt }));

    const res = await clear();

    expect(res.status).toBe(202);
    expect(res.body.clearPending).toMatchObject({ phase: 'waiting_exit' });
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, '/exit');
    expect(registry.beginPendingClear).toHaveBeenCalledWith(session.id, expect.objectContaining({ conversationId: 'conversation-1' }));
  });

  it('refuses a missing, ended or unlaunched session without touching the pane', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    expect((await clear()).status).toBe(404);
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    expect((await clear()).body.code).toBe('session_dead');
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ provider: null, activeConversationId: null }));
    expect((await clear()).body.code).toBe('no_active_conversation');
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
  });

  it('never types an exit into a trust prompt on screen', async () => {
    const profile = {
      id: 'native:agy', provider: 'gemini' as const, runtimeId: 'agy' as const, source: 'native' as const,
      home: '/private/agy', conversationRoot: '/private/agy/conversations', delegate: { kind: 'native' as const, executable: 'agy' },
    };
    const session = makeSession({
      provider: 'gemini', runtimeId: 'agy', providerSessionId: null, launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, provider: 'gemini', runtimeId: 'agy', providerSessionId: null, launchProfile: profile }],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(tmuxCli.capturePane).mockResolvedValueOnce([
      'Do you trust the contents of this project?',
      '> Yes, I trust this folder',
      '  No, exit',
      '  ↑/↓ Navigate · enter Confirm',
    ].join('\n'));

    const res = await clear();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('startup_prompt_pending');
    expect(res.body.error).toContain('new conversation');
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
  });

  it('refuses a runtime whose exit is not verified, as the typed /clear does', async () => {
    const profile = {
      id: 'native:gemini', provider: 'gemini' as const, runtimeId: 'gemini-cli' as const, source: 'native' as const,
      home: '/private/gemini', conversationRoot: '/private/gemini/tmp', delegate: { kind: 'native' as const, executable: 'gemini' },
    };
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({
      provider: 'gemini', runtimeId: 'gemini-cli', launchProfile: profile,
      conversations: [{ ...makeSession().conversations![0]!, provider: 'gemini', runtimeId: 'gemini-cli', launchProfile: profile }],
    }));
    const res = await clear();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clear_exit_unverified');
    expect(registry.beginPendingClear).not.toHaveBeenCalled();
  });
});

// Claude Code 2.1.284 prompts, as captured (test/fixtures/interaction-prompts).
const prompt = (screen: string) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'interaction-prompts', `claude.${screen}.2.1.284.txt`), 'utf8');

describe('a prompt the CLI waits on holds typed input back', () => {
  it('409s a message while the pane shows a permission, sending nothing', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ turnPhase: 'replying' }));
    vi.mocked(tmuxCli.capturePane).mockResolvedValue(prompt('perm-write'));
    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: 'please wait' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('interaction_pending');
    // Its Enter would have approved the write.
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('409s a message while one is recorded as pending', async () => {
    const pendingInteraction = { kind: 'question' as const, toolUseId: 'pane:x', toolName: 'AskUserQuestion', input: null, detectedAt: '' };
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ turnPhase: 'awaiting_approval', pendingInteraction }));
    const res = await request(createApp()).post('/api/sessions/sess-1/messages').set('Authorization', auth).send({ text: 'hi' });
    expect(res.body.code).toBe('interaction_pending');
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('409s the app\'s /clear too', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ turnPhase: 'replying' }));
    vi.mocked(tmuxCli.capturePane).mockResolvedValue(prompt('q-single'));
    const res = await request(createApp()).post('/api/sessions/sess-1/clear').set('Authorization', auth).send({});
    expect(res.body.code).toBe('interaction_pending');
  });
});

describe('POST /api/sessions/:id/interaction', () => {
  const idOf = (screen: string) => interactionId(readClaudeInteraction(prompt(screen))!.screen);

  it('answers the prompt on screen and reads what comes next', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({ turnPhase: 'awaiting_approval' }));
    vi.mocked(tmuxCli.capturePane).mockResolvedValue(prompt('q-single'));
    const res = await request(createApp()).post('/api/sessions/sess-1/interaction').set('Authorization', auth)
      .send({ promptId: idOf('q-single'), option: 1 });
    expect(res.status).toBe(200);
    expect(tmuxCli.sendKey).toHaveBeenCalledWith('hestia-sess-1', 'Enter');
    expect(polling.noteControlKey).toHaveBeenCalledWith('sess-1');
    expect(polling.refreshPendingInteraction).toHaveBeenCalledWith('sess-1');
  });

  it('types a free-text answer', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({ turnPhase: 'awaiting_approval' }));
    const q1 = prompt('q-multi-q1');
    const onRow = (row: number) => q1.replace('❯ 1. 蘋果', '  1. 蘋果').replace(`  ${row}. `, `❯ ${row}. `);
    vi.mocked(tmuxCli.capturePane)
      .mockResolvedValueOnce(q1).mockResolvedValueOnce(onRow(2)).mockResolvedValueOnce(onRow(3))
      .mockResolvedValue(prompt('q-multi-q1-typed'));
    const res = await request(createApp()).post('/api/sessions/sess-1/interaction').set('Authorization', auth)
      .send({ promptId: idOf('q-multi-q1'), option: 3, text: '芭樂' });
    expect(res.status).toBe(200);
    expect(tmuxCli.typeText).toHaveBeenCalledWith('hestia-sess-1', '芭樂');
    expect(vi.mocked(tmuxCli.sendKey).mock.calls.map((call) => call[1])).toEqual(['Down', 'Down', 'Enter']);
  });

  it('leaves a prompt that took its place alone', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({ turnPhase: 'awaiting_approval' }));
    vi.mocked(tmuxCli.capturePane).mockResolvedValue(prompt('q-multi-q3'));
    const res = await request(createApp()).post('/api/sessions/sess-1/interaction').set('Authorization', auth)
      .send({ promptId: idOf('q-multi-q1'), option: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('interaction_changed');
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });

  it('409s when no prompt is on screen', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({ turnPhase: 'replying' }));
    vi.mocked(tmuxCli.capturePane).mockResolvedValue(prompt('idle-after'));
    const res = await request(createApp()).post('/api/sessions/sess-1/interaction').set('Authorization', auth)
      .send({ promptId: 'pane:x', option: 1 });
    expect(res.body.code).toBe('no_interaction');
  });

  it('400s a malformed answer', async () => {
    const res = await request(createApp()).post('/api/sessions/sess-1/interaction').set('Authorization', auth).send({ option: 0 });
    expect(res.status).toBe(400);
  });
});
