import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { ManagedSession } from '../../src/types.js';

vi.mock('../../src/registry.js', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(async () => []),
  reconcile: vi.fn(async () => {}),
}));
vi.mock('../../src/sync/binding.js', () => ({ resolvedBinding: vi.fn() }));

const registry = await import('../../src/registry.js');
const { resolvedBinding } = await import('../../src/sync/binding.js');

const session = { id: 'sess-1', status: 'ready', providerLaunchedAt: '2026-10-10T01:00:00Z' } as ManagedSession;
const listSubagents = vi.fn();
const readSubagentMessages = vi.fn();
let auth: string;

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
  vi.mocked(registry.getSession).mockResolvedValue(session);
  vi.mocked(resolvedBinding).mockReturnValue({
    session, conversation: {}, file: '/p/sid.jsonl', adapter: { listSubagents, readSubagentMessages },
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/sessions/:id/subagents', () => {
  it("lists the active conversation's subagents from its bound transcript", async () => {
    listSubagents.mockResolvedValueOnce([{ agentId: 'a1b2c3d4e5f6a7b8c', status: 'running' }]);
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subagents: [{ agentId: 'a1b2c3d4e5f6a7b8c', status: 'running' }] });
    expect(listSubagents).toHaveBeenCalledWith('/p/sid.jsonl');
  });

  it('lists none without an attributed transcript', async () => {
    vi.mocked(resolvedBinding).mockReturnValueOnce(null);
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents').set('Authorization', auth);
    expect(res.body).toEqual({ subagents: [] });
  });

  it('404s an unknown session', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const res = await request(createApp()).get('/api/sessions/nope/subagents').set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('a subagent left running by a CLI that is gone', () => {
  const running = (agentId: string, startedAt: string) => ({ agentId, status: 'running', startedAt });

  it('is stopped once the session has ended', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce({ ...session, status: 'dead' });
    listSubagents.mockResolvedValueOnce([running('a1b2c3d4e5f6a7b8c', '2026-10-10T02:00:00Z'), { agentId: 'bbbbbbbbbbbbbbbbb', status: 'completed', startedAt: null }]);
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents').set('Authorization', auth);
    expect(res.body.subagents.map((agent: { status: string }) => agent.status)).toEqual(['stopped', 'completed']);
  });

  it('is stopped when it started before the CLI was last launched', async () => {
    listSubagents.mockResolvedValueOnce([running('a1b2c3d4e5f6a7b8c', '2026-10-10T00:30:00Z'), running('ccccccccccccccccc', '2026-10-10T02:00:00Z')]);
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents').set('Authorization', auth);
    expect(res.body.subagents.map((agent: { status: string }) => agent.status)).toEqual(['stopped', 'running']);
  });
});

describe('GET /api/sessions/:id/subagents/:agentId', () => {
  it("returns one subagent's messages, with its summary as of now", async () => {
    readSubagentMessages.mockResolvedValueOnce([{ role: 'assistant', text: 'PONG', ts: null }]);
    listSubagents.mockResolvedValueOnce([{ agentId: 'a1b2c3d4e5f6a7b8c', status: 'completed', startedAt: '2026-10-10T02:00:00Z' }]);
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents/a1b2c3d4e5f6a7b8c').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agentId: 'a1b2c3d4e5f6a7b8c', messages: [{ role: 'assistant', text: 'PONG', ts: null }],
      subagent: { agentId: 'a1b2c3d4e5f6a7b8c', status: 'completed', startedAt: '2026-10-10T02:00:00Z' },
    });
    expect(readSubagentMessages).toHaveBeenCalledWith('/p/sid.jsonl', 'a1b2c3d4e5f6a7b8c');
  });

  it('404s an agent the conversation does not name', async () => {
    readSubagentMessages.mockResolvedValueOnce(null);
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents/a1b2c3d4e5f6a7b8c').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed id before reading anything', async () => {
    for (const id of ['..%2F..%2Fetc', 'a.b.c.d.e.f', 'abc', '%2Ftmp%2Fxxxxxx']) {
      const res = await request(createApp()).get(`/api/sessions/sess-1/subagents/${id}`).set('Authorization', auth);
      expect(res.status).toBe(404);
    }
    expect(readSubagentMessages).not.toHaveBeenCalled();
  });

  // Codex's agent ids are thread UUIDs; the adapter checks the shape itself.
  it('passes a UUID id through to the adapter', async () => {
    const id = '01a12398-39c3-7172-9788-f6bcec33e4e3';
    readSubagentMessages.mockResolvedValueOnce([]);
    listSubagents.mockResolvedValueOnce([{ agentId: id, status: 'running', startedAt: '2026-10-10T02:15:41Z' }]);
    const res = await request(createApp()).get(`/api/sessions/sess-1/subagents/${id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(readSubagentMessages).toHaveBeenCalledWith('/p/sid.jsonl', id);
    expect(res.body.subagent).toMatchObject({ agentId: id, status: 'running' });
  });

  it('requires auth', async () => {
    const res = await request(createApp()).get('/api/sessions/sess-1/subagents');
    expect(res.status).toBe(401);
  });
});
