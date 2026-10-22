import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import { clearModelLists } from '../../src/routes/models.js';
import type { LaunchProfileSnapshot, ManagedSession } from '../../src/types.js';

vi.mock('../../src/tmux.js', () => ({
  sendText: vi.fn(async () => {}),
  typeText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  capturePane: vi.fn(async () => ''),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'C-c'],
}));

vi.mock('../../src/registry.js', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
  updateConversation: vi.fn(),
  reconcile: vi.fn(async () => {}),
}));

const registry = await import('../../src/registry.js');
const tmuxCli = await import('../../src/tmux.js');

const PROFILE: LaunchProfileSnapshot = {
  id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native',
  home: '/home/u/.claude', conversationRoot: '/home/u/.claude/projects', args: [], delegate: { kind: 'native', executable: 'claude' },
};

function makeSession(overrides: Partial<ManagedSession> = {}, profile: LaunchProfileSnapshot | null = PROFILE): ManagedSession {
  return {
    id: 'sess-1', tmuxName: 'hestia-sess-1', cwd: '/p', projectId: 'proj-1', alias: null, createdAt: '2026-01-01T00:00:00Z',
    provider: 'claude', providerSessionId: 'abc', providerSessionFile: null, providerLaunchedAt: '2026-01-01T00:00:00Z',
    status: 'ready', turnPhase: 'idle', lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null,
    pendingInteraction: null, turns: [], turnsSourceFile: null, activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: profile, providerSessionId: 'abc',
      startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'launch', endReason: null,
      transcript: { state: 'resolved', file: '/t.jsonl', identity: 'pinned_id' }, lastUserMessageAt: null, lastUserMessageText: null,
      deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null, turns: [],
    }],
    ...overrides,
  };
}

let auth: string;
beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
  clearModelLists();
});
afterEach(() => { vi.resetAllMocks(); });

describe('GET /api/sessions/:id/models', () => {
  it("lists Claude Code's aliases, with no current choice yet", async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    const res = await request(createApp()).get('/api/sessions/sess-1/models').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runtimeId: 'claude-code', source: 'builtin', current: null });
    expect(res.body.options.map((option: { id: string }) => option.id)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku']);
  });

  it('409s for a conversation without a launch profile', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({}, null));
    const res = await request(createApp()).get('/api/sessions/sess-1/models').set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('model_switch_unsupported');
  });
});

describe('POST /api/sessions/:id/model', () => {
  it('switches an idle CLI and records the choice', async () => {
    const session = makeSession();
    vi.mocked(registry.getSession).mockResolvedValue(session);
    let typed = false;
    vi.mocked(tmuxCli.sendText).mockImplementation(async () => { typed = true; });
    vi.mocked(tmuxCli.capturePane).mockImplementation(async () => typed
      ? '❯ /model sonnet\n  ⎿  Set model to Sonnet 5 and saved as your default for new sessions\n❯ \n'
      : '❯ \n');
    const res = await request(createApp()).post('/api/sessions/sess-1/model').set('Authorization', auth).send({ model: 'sonnet' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'sonnet', label: 'Sonnet 5', effort: null });
    expect(tmuxCli.sendText).toHaveBeenCalledWith('hestia-sess-1', '/model sonnet');
    expect(registry.updateConversation).toHaveBeenCalledWith('sess-1', 'conversation-1', { model: expect.objectContaining({ model: 'sonnet', label: 'Sonnet 5' }) });
  });

  it('refuses while a reply is being written, typing nothing', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession({ turnPhase: 'replying', paneActivity: 'busy' }));
    const res = await request(createApp()).post('/api/sessions/sess-1/model').set('Authorization', auth).send({ model: 'sonnet' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cli_busy');
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('refuses a model that is not listed', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    const res = await request(createApp()).post('/api/sessions/sess-1/model').set('Authorization', auth).send({ model: 'claude-9' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('model_unknown');
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('passes on a refusal from the CLI', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    let typed = false;
    vi.mocked(tmuxCli.sendText).mockImplementation(async () => { typed = true; });
    vi.mocked(tmuxCli.capturePane).mockImplementation(async () => typed ? "❯ /model fable\n  ⎿  Model 'fable' not found\n" : '❯ \n');
    const res = await request(createApp()).post('/api/sessions/sess-1/model').set('Authorization', auth).send({ model: 'fable' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('model_rejected');
    expect(registry.updateConversation).not.toHaveBeenCalled();
  });
});
