import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import { registerTmuxEnv } from '../../src/services/tmux-env.js';
import type { ManagedSession } from '../../src/types.js';
import { toPublicManagedSession } from '../../src/session-dto.js';

// The session's working directory has to exist: a dead tmux is only
// reopened where its folder still is (recovery_cwd_missing).
const { PROJECT_DIR } = vi.hoisted(() => ({ PROJECT_DIR: process.cwd() }));

// An executable every test host has: /bin/true on Linux, /usr/bin/true on macOS.
const TRUE_BIN = ['/bin/true', '/usr/bin/true'].find((file) => existsSync(file)) ?? '/bin/true';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  sessionExists: vi.fn(async () => false),
  getPaneCurrentPath: vi.fn(async () => PROJECT_DIR),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  capturePane: vi.fn(async () => ''),
  getPaneSize: vi.fn(async () => null),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  getPaneLiveness: vi.fn(async () => 'unknown'),
  sessionPresence: vi.fn(async () => 'present'),
  respawnPane: vi.fn(async () => {}),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'C-c'],
}));

// Whether a CLI is installed: found unless a test says otherwise.
vi.mock('../../src/runtimes/command-check.js', () => ({
  checkCommandAvailable: vi.fn(async () => 'found'),
}));

vi.mock('../../src/launch-profiles.js', () => ({
  getLaunchProfileCatalog: vi.fn(async () => ({
    profiles: ['claude', 'codex', 'gemini'].map((provider) => ({
      id: `native:${provider}`, provider, label: `${provider} (原生)`, source: 'native', executable: provider, args: [],
    })),
    discoveredAt: '2026-09-23T00:00:00.000Z', janus: { available: false, error: { code: 'not_found', message: 'safe' } },
  })),
}));

vi.mock('../../src/registry.js', () => ({
  getSession: vi.fn(),
  getConversation: vi.fn(),
  listSessions: vi.fn(),
  listTrashedSessions: vi.fn(async () => []),
  restoreSession: vi.fn(),
  purgeSession: vi.fn(),
  updateSession: vi.fn(),
  updateConversation: vi.fn(),
  beginPendingLaunch: vi.fn(async (_id: string, attempt: ManagedSession['launchPending']) => makeSession({ status: 'launching', launchPending: attempt })),
  claimPendingLaunch: vi.fn(),
  commitConversationLaunch: vi.fn(),
  rollbackPendingLaunch: vi.fn(),
  releaseLaunchAttempt: vi.fn(),
  ownsLaunchAttemptLocally: vi.fn(() => false),
  beginPendingResume: vi.fn(async (_id: string, attempt: ManagedSession['resumePending']) => makeSession({ status: 'launching', resumePending: attempt })),
  commitPendingResume: vi.fn(),
  rollbackPendingResume: vi.fn(),
  ownsResumeAttemptLocally: vi.fn(() => false),
  releaseResumeAttempt: vi.fn(),
  beginConversationSwitch: vi.fn(async (_id: string, attempt: ManagedSession['clearPending']) => makeSession({ status: 'launching', clearPending: attempt })),
  setPendingExitPhase: vi.fn(),
  failPendingClear: vi.fn(),
  releaseClearAttempt: vi.fn(),
}));

// Which accounts are over their limit comes from the continuity state on
// disk; never this machine's own.
const accountLimitedUntil = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);
vi.mock('../../src/continuity/wiring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/continuity/wiring.js')>()),
  accountLimitedUntil: (...args: unknown[]) => accountLimitedUntil(...args),
}));

vi.mock('../../src/services/sessions.js', () => ({
  createSession: vi.fn(),
  removeSession: vi.fn(),
  reconcileWithTmux: vi.fn(async () => []),
  closeSession: vi.fn(),
  endIfTmuxGone: vi.fn(async () => false),
}));

vi.mock('../../src/project-store.js', () => ({
  resolveOrCreateProjectByName: vi.fn(),
  getProject: vi.fn(),
  INBOX_PROJECT_ID: 'inbox',
  listProjects: vi.fn(),
}));

const registry = await import('../../src/registry.js');
const sessionService = await import('../../src/services/sessions.js');
const projectStore = await import('../../src/project-store.js');
const tmuxCli = await import('../../src/tmux.js');
const launchProfiles = await import('../../src/launch-profiles.js');
const commandCheck = await import('../../src/runtimes/command-check.js');

function makeProject(overrides: Partial<{ id: string; name: string; createdAt: string; deletedAt: string | null }> = {}) {
  return {
    id: 'proj-1',
    name: 'my-project',
    createdAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    paths: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1',
    tmuxName: 'hestia-sess-1',
    cwd: PROJECT_DIR,
    projectId: 'proj-1',
    alias: null,
    createdAt: '2026-01-01T00:00:00Z',
    provider: null,
    providerSessionId: null,
    providerSessionFile: null,
    providerLaunchedAt: null,
    status: 'idle',
    lastUserMessageAt: null,
    lastUserMessageText: null,
    deliveryUnconfirmedText: null,
    lastError: null,
    pendingInteraction: null,
    turns: [],
    turnsSourceFile: null,
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

describe('POST /api/sessions/:id/recover-claude', () => {
  let transcriptRoot: string;
  let transcriptFile: string;

  beforeEach(async () => {
    transcriptRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-resume-route-'));
    const projectDir = path.join(transcriptRoot, 'project');
    await mkdir(projectDir);
    transcriptFile = path.join(projectDir, 'a13782f4-715f-4abc-9233-2207319a1234.jsonl');
    await writeFile(transcriptFile, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
  });

  afterEach(async () => { await rm(transcriptRoot, { recursive: true, force: true }); });

  function deadClaudeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
    const conversation = {
      id: 'conversation-1', sequence: 1, kind: 'cli' as const, provider: 'claude' as const, runtimeId: 'claude-code' as const,
      launchProfile: { id: 'native:claude', provider: 'claude' as const, source: 'native' as const, home: transcriptRoot, conversationRoot: transcriptRoot, delegate: { kind: 'native' as const, executable: TRUE_BIN } },
      providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234',
      startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'launch' as const, endReason: null,
      transcript: { state: 'resolved' as const, identity: 'pinned_id' as const, file: transcriptFile },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null,
      transcriptError: null, turns: [{ index: 1, user: { text: 'hi', at: null }, assistant: { text: 'hello', at: null } }],
    };
    return makeSession({
      provider: 'claude', providerSessionId: conversation.providerSessionId, status: 'dead',
      launchProfile: conversation.launchProfile, activeConversationId: conversation.id,
      conversations: [conversation], ...overrides,
    });
  }

  it('restores the exact conversation in the same tmux using its saved native profile and Claude session id', async () => {
    const old = deadClaudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('launching');
    expect(tmuxCli.newSession).toHaveBeenCalledWith(old.tmuxName, old.cwd, {});
    // Reopened on this install's own tmux server, recorded before it opens.
    expect(registry.updateSession).toHaveBeenCalledWith(old.id, { tmuxSocket: 'hestia' });
    expect(vi.mocked(registry.updateSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(tmuxCli.newSession).mock.invocationCallOrder[0]!);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(old.tmuxName, ['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', TRUE_BIN, '--resume', old.providerSessionId]);
    expect(registry.beginPendingResume).toHaveBeenCalledWith(old.id, expect.objectContaining({ conversationId: 'conversation-1' }));
    // Startup is confirmed by the poller under the shared rule, not here.
    expect(registry.commitPendingResume).not.toHaveBeenCalled();
    expect(registry.releaseResumeAttempt).toHaveBeenCalledWith(old.id, expect.any(String));
  });

  it('makes the tmux again with what the first one carried (a delegate\'s HESTIA_DELEGATION_ID)', async () => {
    const old = deadClaudeSession();
    const unregister = registerTmuxEnv(async (id): Promise<Record<string, string>> => (id === old.id ? { HESTIA_DELEGATION_ID: 'ab12cd34' } : {}));
    try {
      vi.mocked(registry.getSession).mockResolvedValueOnce(old);
      vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);
      vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');
      const response = await request(createApp()).post('/api/sessions/sess-1/recover').set('Authorization', auth);
      expect(response.status).toBe(202);
      expect(tmuxCli.newSession).toHaveBeenCalledWith(old.tmuxName, old.cwd, { HESTIA_DELEGATION_ID: 'ab12cd34' });
    } finally {
      unregister();
    }
  });

  it('serves the same recovery on the runtime-neutral /recover path', async () => {
    const old = deadClaudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(old.tmuxName, ['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', TRUE_BIN, '--resume', old.providerSessionId]);
  });

  it('refuses a dead session whose runtime cannot resume in place, before touching tmux', async () => {
    const old = deadClaudeSession();
    const codexProfile = { ...old.launchProfile!, id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const };
    vi.mocked(registry.getSession).mockResolvedValueOnce({
      ...old, provider: 'codex', runtimeId: 'codex-cli', launchProfile: codexProfile,
      conversations: [{ ...old.conversations![0]!, provider: 'codex', runtimeId: 'codex-cli', launchProfile: codexProfile }],
    });

    const response = await request(createApp()).post('/api/sessions/sess-1/recover').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(tmuxCli.sessionExists).not.toHaveBeenCalled();
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
  });

  it('refuses when the saved absolute executable is gone, even behind the launch env', async () => {
    const old = deadClaudeSession();
    const profile = { ...old.launchProfile!, delegate: { kind: 'native' as const, executable: '/nonexistent/claude' } };
    old.launchProfile = profile;
    old.conversations![0]!.launchProfile = profile;
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('lets the target tmux shell resolve a saved bare executable instead of checking the API service PATH', async () => {
    const old = deadClaudeSession();
    const profile = {
      ...old.launchProfile!,
      delegate: { kind: 'native' as const, executable: 'claude' },
    };
    old.launchProfile = profile;
    old.conversations![0]!.launchProfile = profile;
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

      expect(response.status).toBe(202);
      expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(old.tmuxName, ['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', 'claude', '--resume', old.providerSessionId]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it.each(['alive', 'unknown'] as const)('fails closed when the existing tmux pane is %s', async (liveness) => {
    const old = deadClaudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce(liveness);

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
  });

  it('fails closed when the existing tmux working directory conflicts with the saved cwd', async () => {
    const old = deadClaudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');
    vi.mocked(tmuxCli.getPaneCurrentPath).mockResolvedValueOnce('/other/project');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('never judges startup in the request: a pane still at its shell after dispatch is left pending', async () => {
    const old = deadClaudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValue('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(tmuxCli.getPaneLiveness).toHaveBeenCalledTimes(1); // the pre-dispatch safety check only
    expect(registry.rollbackPendingResume).not.toHaveBeenCalled();
    expect(registry.commitPendingResume).not.toHaveBeenCalled();
  });

  it('keeps the claim and never re-sends when dispatch cannot be confirmed', async () => {
    const old = deadClaudeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');
    vi.mocked(tmuxCli.sendCommandLine).mockRejectedValueOnce(new Error('tmux delivery unknown'));

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(503);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledTimes(1);
    expect(registry.rollbackPendingResume).not.toHaveBeenCalled();
    expect(registry.releaseResumeAttempt).toHaveBeenCalledWith(old.id, expect.any(String));
  });

  it('reuses the saved Janus profile wrapper and profile name', async () => {
    const old = deadClaudeSession();
    const janusProfile = {
      id: 'janus:claude-work', provider: 'claude' as const, source: 'janus' as const,
      profileName: 'claude-work', home: transcriptRoot, conversationRoot: transcriptRoot,
      delegate: { kind: 'janus' as const, executable: TRUE_BIN },
    };
    old.launchProfile = janusProfile;
    old.conversations![0]!.launchProfile = janusProfile;
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(old.tmuxName, [
      'env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', TRUE_BIN, 'run', 'claude-work', '--resume', old.providerSessionId,
    ]);
  });

  it('does not create a tmux or fall back to a fresh Claude session when the native transcript is unavailable', async () => {
    const old = deadClaudeSession({ conversations: deadClaudeSession().conversations?.map((item) => ({ ...item, transcript: { state: 'not_found', identity: null, file: null } })) });
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(tmuxCli.newSession).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('refuses with recovery_cwd_missing when the working directory is gone, before touching tmux', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(deadClaudeSession({ cwd: path.join(transcriptRoot, 'moved-away') }));

    const response = await request(createApp()).post('/api/sessions/sess-1/recover').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('recovery_cwd_missing');
    expect(tmuxCli.sessionExists).not.toHaveBeenCalled();
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
  });

  it('follows a transcript the CLI moved, by its session id, and records the new path before claiming', async () => {
    const old = deadClaudeSession();
    const movedDir = path.join(transcriptRoot, 'worktree-project');
    await mkdir(movedDir);
    const moved = path.join(movedDir, path.basename(transcriptFile));
    await rm(transcriptFile);
    await writeFile(moved, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(registry.updateConversation).toHaveBeenCalledTimes(1);
    expect(registry.updateConversation).toHaveBeenCalledWith('sess-1', 'conversation-1', {
      transcript: { state: 'resolved', identity: 'pinned_id', file: moved },
    });
    expect(vi.mocked(registry.updateConversation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(registry.beginPendingResume).mock.invocationCallOrder[0]!);
  });

  it('refuses caller-supplied provider session or profile values', async () => {
    const response = await request(createApp())
      .post('/api/sessions/sess-1/recover-claude').set('Authorization', auth)
      .send({ providerSessionId: 'attacker-id', profile: '/tmp/other-profile' });

    expect(response.status).toBe(400);
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('refuses non-Claude recovery', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(deadClaudeSession({ provider: 'codex' }));

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('rejects an unsafe or mismatched provider session id before any tmux side effect', async () => {
    const old = deadClaudeSession({ providerSessionId: '--help' });
    old.conversations![0]!.providerSessionId = '--help';
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(tmuxCli.sessionExists).not.toHaveBeenCalled();
    expect(registry.beginPendingResume).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions', () => {
  it('400s on a missing cwd', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions').set('Authorization', auth).send({ projectName: 'x' });
    expect(res.status).toBe(400);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('400s on a missing projectName', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions').set('Authorization', auth).send({ cwd: PROJECT_DIR });
    expect(res.status).toBe(400);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('opens a session straight into an existing project by id', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject({ id: 'proj-9' }));
    vi.mocked(sessionService.createSession).mockResolvedValueOnce(makeSession());
    const res = await request(createApp()).post('/api/sessions').set('Authorization', auth).send({ cwd: '/work', projectId: 'proj-9' });
    expect(res.status).toBe(201);
    expect(sessionService.createSession).toHaveBeenCalledWith('/work', 'proj-9');
    expect(projectStore.resolveOrCreateProjectByName).not.toHaveBeenCalled();
  });

  it('404s for an unknown project id, and the inbox never gets a tmux', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const unknown = await request(app).post('/api/sessions').set('Authorization', auth).send({ cwd: '/work', projectId: 'gone' });
    const inbox = await request(app).post('/api/sessions').set('Authorization', auth).send({ cwd: '/work', projectId: 'inbox' });
    expect(unknown.status).toBe(404);
    expect(inbox.status).toBe(404);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('creates a session and returns 201 with the session shape', async () => {
    const session = makeSession();
    vi.mocked(projectStore.resolveOrCreateProjectByName).mockResolvedValueOnce(makeProject());
    vi.mocked(sessionService.createSession).mockResolvedValueOnce(session);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', auth)
      .send({ cwd: PROJECT_DIR, projectName: 'my-project' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(toPublicManagedSession(session));
    expect(projectStore.resolveOrCreateProjectByName).toHaveBeenCalledWith('my-project');
    expect(sessionService.createSession).toHaveBeenCalledWith(PROJECT_DIR, 'proj-1');
  });

  it('joins an existing project by name (case/whitespace variations) without creating a second project', async () => {
    vi.mocked(projectStore.resolveOrCreateProjectByName).mockResolvedValueOnce(makeProject({ id: 'proj-existing' }));
    vi.mocked(sessionService.createSession).mockResolvedValueOnce(makeSession({ projectId: 'proj-existing' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', auth)
      .send({ cwd: PROJECT_DIR, projectName: '  My-Project  ' });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe('proj-existing');
    // zod's z.string().trim() trims before the handler ever sees it.
    expect(projectStore.resolveOrCreateProjectByName).toHaveBeenCalledWith('My-Project');
  });

  it('creates a new project when the name is brand new', async () => {
    vi.mocked(projectStore.resolveOrCreateProjectByName).mockResolvedValueOnce(makeProject({ id: 'proj-new', name: 'Brand New' }));
    vi.mocked(sessionService.createSession).mockResolvedValueOnce(makeSession({ projectId: 'proj-new' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', auth)
      .send({ cwd: PROJECT_DIR, projectName: 'Brand New' });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe('proj-new');
  });
});

describe('GET /api/sessions/:id/conversations/:conversationId', () => {
  it('returns only the conversation owned by the requested tmux session', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    vi.mocked(registry.getConversation).mockResolvedValueOnce({
      id: 'conversation-1', sequence: 1, kind: 'cli', provider: 'codex', launchProfile: {
        id: 'janus:codex', provider: 'codex', source: 'janus', profileName: 'work', home: '/private/home',
        conversationRoot: '/private/sessions', delegate: { kind: 'janus', executable: '/private/bin/janus' },
      }, providerSessionId: null, startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'launch', endReason: null,
      transcript: { state: 'resolved', file: '/private/sessions/rollout.jsonl', identity: 'verified_metadata' },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null,
      transcriptError: null, turns: [],
    });

    const response = await request(createApp()).get('/api/sessions/sess-1/conversations/conversation-1').set('Authorization', auth);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('conversation-1');
    expect(response.body.transcript).toEqual({ state: 'resolved', identity: 'verified_metadata' });
    expect(JSON.stringify(response.body)).not.toContain('/private');
    expect(registry.getConversation).toHaveBeenCalledWith('sess-1', 'conversation-1');
  });

  it('adds each turn\'s process read from its transcript, without exposing the transcript', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-route-process-'));
    try {
      const file = path.join(dir, 'transcript.jsonl');
      const records = [
        { type: 'user', timestamp: '2026-10-12T00:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '問' } },
        { type: 'assistant', timestamp: '2026-10-12T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '先查。' }] } },
        { type: 'assistant', timestamp: '2026-10-12T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', timestamp: '2026-10-12T00:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] } },
        { type: 'assistant', timestamp: '2026-10-12T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '答。' }] } },
      ];
      await writeFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
      vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
      vi.mocked(registry.getConversation).mockResolvedValueOnce({
        id: 'conversation-1', sequence: 1, kind: 'cli', provider: 'claude', launchProfile: null,
        providerSessionId: null, startedAt: '2026-10-12T00:00:00Z', endedAt: null, startReason: 'launch', endReason: null,
        transcript: { state: 'resolved', file, identity: 'pinned_id' },
        lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null,
        transcriptError: null,
        turns: [{ index: 1, user: { text: '問', at: '2026-10-12T00:00:00.000Z' }, assistant: { text: '先查。\n\n答。', at: '2026-10-12T00:00:01.000Z' } }],
      });

      const response = await request(createApp()).get('/api/sessions/sess-1/conversations/conversation-1').set('Authorization', auth);

      expect(response.status).toBe(200);
      expect(response.body.turns[0].assistant.text).toBe('先查。\n\n答。');
      expect(response.body.turns[0].process).toMatchObject({
        status: 'available', open: false,
        parts: [{ kind: 'progress', text: '先查。' }, { kind: 'reply', text: '答。' }],
        counts: { run: 1 },
      });
      expect(JSON.stringify(response.body)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns 404 rather than exposing a conversation that is not owned by this tmux', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    vi.mocked(registry.getConversation).mockResolvedValueOnce(undefined);

    const response = await request(createApp()).get('/api/sessions/sess-1/conversations/other-tmux-conversation').set('Authorization', auth);

    expect(response.status).toBe(404);
  });
});

describe('GET /api/sessions', () => {
  it('reconciles then returns the session list', async () => {
    const sessions = [makeSession(), makeSession({ id: 'sess-2' })];
    vi.mocked(registry.listSessions).mockResolvedValueOnce(sessions);
    const app = createApp();
    const res = await request(app).get('/api/sessions').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sessions.map(toPublicManagedSession));
    expect(sessionService.reconcileWithTmux).toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id', () => {
  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/sessions/nope').set('Authorization', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found', message: 'not found', error: 'not found' });
  });

  it('returns the session when found', async () => {
    const session = makeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    const app = createApp();
    const res = await request(app).get('/api/sessions/sess-1').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(toPublicManagedSession(session));
  });
});

describe('session event log', () => {
  const events = async () => {
    const { SESSION_EVENTS_PATH } = await import('../../src/config.js');
    const text = await import('node:fs/promises').then((fs) => fs.readFile(SESSION_EVENTS_PATH, 'utf8')).catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  // Every route test before this one logged its own events too.
  beforeEach(async () => {
    const { SESSION_EVENTS_PATH } = await import('../../src/config.js');
    await rm(SESSION_EVENTS_PATH, { force: true });
  });

  it('records who closed a session and how it went', async () => {
    vi.mocked(sessionService.closeSession).mockResolvedValueOnce({ status: 'exit_unverified' });
    await request(createApp()).post('/api/sessions/sess-1/close').set('Authorization', auth).send({});
    vi.mocked(sessionService.closeSession).mockResolvedValueOnce({ status: 'closed', session: makeSession({ status: 'dead' }) });
    await request(createApp()).post('/api/sessions/sess-1/close').set('Authorization', auth).send({ force: true });
    expect(await events()).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', action: 'close', result: 'exit_unverified', source: 'app' }),
      expect.objectContaining({ sessionId: 'sess-1', action: 'close_force', result: 'closed', source: 'app' }),
    ]);
  });

  it('tells the hestia command on this machine from the app', async () => {
    const { __setLocalToolTokenForTests, LOCAL_TOOL_HEADER } = await import('../../src/auth.js');
    __setLocalToolTokenForTests('local-tool-token');
    try {
      vi.mocked(sessionService.removeSession).mockResolvedValueOnce(true);
      await request(createApp()).delete('/api/sessions/sess-1').set(LOCAL_TOOL_HEADER, 'local-tool-token');
      expect((await events()).at(-1)).toMatchObject({ action: 'delete', result: 'ok', source: 'cli' });
      expect((await events()).at(-1)).not.toHaveProperty('actor');
    } finally {
      __setLocalToolTokenForTests(null);
    }
  });

  it('records nothing for deleting a session that was not there', async () => {
    vi.mocked(sessionService.removeSession).mockResolvedValueOnce(false);
    await request(createApp()).delete('/api/sessions/nope').set('Authorization', auth);
    expect(await events()).toEqual([]);
  });

  it('records a cancelled launch', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    await request(createApp()).post('/api/sessions/sess-1/launch/cancel').set('Authorization', auth).send({});
    expect((await events()).at(-1)).toMatchObject({ sessionId: 'sess-1', action: 'launch_cancel', result: 'no_launch_to_cancel', source: 'app' });
  });

  it("records a launch's refusal by its code", async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:claude' });
    expect((await events()).at(-1)).toMatchObject({ action: 'launch', result: 'session_dead', detail: { profileId: 'native:claude' } });
  });

  it('takes a permission mode only with the login, and records the mode a launch started in (ADR 0027)', async () => {
    const { __setLocalToolTokenForTests, LOCAL_TOOL_HEADER } = await import('../../src/auth.js');
    __setLocalToolTokenForTests('local-tool-token');
    try {
      const refused = await request(createApp()).post('/api/sessions/sess-1/launch').set(LOCAL_TOOL_HEADER, 'local-tool-token')
        .send({ profileId: 'native:claude', permissionMode: 'yolo' });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('login_required');
      expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
    } finally {
      __setLocalToolTokenForTests(null);
    }
    vi.mocked(registry.getSession).mockResolvedValue(makeSession());
    vi.mocked(registry.beginPendingLaunch).mockResolvedValueOnce(makeSession({ status: 'launching' }));
    const res = await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth)
      .send({ profileId: 'native:claude', permissionMode: 'yolo' });
    expect(res.status).toBe(202);
    expect(vi.mocked(tmuxCli.sendCommandLine).mock.calls[0]![1]).toContain('bypassPermissions');
    expect(vi.mocked(registry.beginPendingLaunch).mock.calls[0]![1].launchProfile.permissionMode).toBe('yolo');
    expect((await events()).at(-1)).toMatchObject({ action: 'launch', result: 'ok', detail: { profileId: 'native:claude', permissionMode: 'yolo' } });
  });

  it('starts a saved Codex auto as cli_default where Codex\'s sandbox can\'t start, and records the fallback', async () => {
    const { permissionModeStore } = await import('../../src/permission-modes/service.js');
    const { __setCodexSandboxForTests } = await import('../../src/runtimes/codex-sandbox-state.js');
    __setCodexSandboxForTests(false);
    await permissionModeStore.save({ version: 1, defaults: { 'codex-cli': 'auto' }, sessions: {} });
    try {
      vi.mocked(registry.getSession).mockResolvedValue(makeSession());
      vi.mocked(registry.beginPendingLaunch).mockResolvedValueOnce(makeSession({ status: 'launching' }));
      const res = await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:codex' });
      expect(res.status).toBe(202);
      expect(vi.mocked(tmuxCli.sendCommandLine).mock.calls[0]![1]).not.toContain('--approve-for-me');
      expect((await events()).at(-1)).toMatchObject({ action: 'launch', result: 'ok', detail: { permissionMode: 'cli_default', permissionFallbackFrom: 'auto' } });
      const refused = await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:codex', permissionMode: 'auto' });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('permission_mode_unavailable');
    } finally {
      await permissionModeStore.save({ version: 1, defaults: {}, sessions: {} });
      __setCodexSandboxForTests(null);
    }
  });
});

describe('DELETE /api/sessions/:id', () => {
  it('204s and calls removeSession (which moves it to the trash)', async () => {
    vi.mocked(sessionService.removeSession).mockResolvedValueOnce(true);
    const app = createApp();
    const res = await request(app).delete('/api/sessions/sess-1').set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(sessionService.removeSession).toHaveBeenCalledWith('sess-1');
  });
});

describe('the trash', () => {
  const trashed = (id: string, projectId: string, deletedAt: string, extra: Partial<ManagedSession> = {}) => makeSession({
    id, tmuxName: `hestia-${id}`, projectId, deletedAt, status: 'dead', ...extra,
  });

  it('lists one project\'s trashed sessions, newest deletion first, without private fields', async () => {
    const profile = { id: 'native:claude', provider: 'claude' as const, source: 'native' as const, home: '/private/home', conversationRoot: '/private/root', delegate: { kind: 'native' as const, executable: '/private/claude' } };
    vi.mocked(registry.listTrashedSessions).mockResolvedValueOnce([
      trashed('a', 'proj-1', '2026-10-01T00:00:00Z'),
      trashed('b', 'proj-2', '2026-10-03T00:00:00Z'),
      trashed('c', 'proj-1', '2026-10-02T00:00:00Z', {
        provider: null, launchProfile: profile, activeConversationId: null,
        conversations: [{
          id: 'conv', sequence: 1, kind: 'cli', provider: 'claude', runtimeId: 'claude-code', launchProfile: profile, providerSessionId: 'p',
          startedAt: 't', endedAt: 't', startReason: 'launch', endReason: 'cli_exit',
          transcript: { state: 'resolved', identity: 'pinned_id', file: '/private/root/x/p.jsonl' },
          lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null, transcriptError: null,
          turns: [{ index: 0, user: { text: 'question', at: '2026-01-01T00:00:00Z' }, assistant: { text: 'answer', at: '2026-01-01T00:01:00Z' } }],
        }],
      }),
    ]);

    const res = await request(createApp()).get('/api/sessions/trash?projectId=proj-1').set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual(['c', 'a']);
    expect(res.body.sessions[0]).toMatchObject({ deletedAt: '2026-10-02T00:00:00Z', lastMessage: { role: 'assistant', text: 'answer', at: '2026-01-01T00:01:00Z' } });
    expect(res.body.sessions[1].lastMessage).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('/private');
    expect(registry.getSession).not.toHaveBeenCalled();
  });

  it('lists every project\'s trash without a projectId, including a project that is gone', async () => {
    vi.mocked(registry.listTrashedSessions).mockResolvedValueOnce([
      trashed('a', 'proj-1', '2026-10-01T00:00:00Z'),
      trashed('b', 'deleted-project', '2026-10-03T00:00:00Z'),
    ]);
    const res = await request(createApp()).get('/api/sessions/trash').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { id: string; projectId: string }) => [s.id, s.projectId])).toEqual([['b', 'deleted-project'], ['a', 'proj-1']]);
  });

  it('400s on an empty projectId', async () => {
    const res = await request(createApp()).get('/api/sessions/trash?projectId=').set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('restores a trashed session as the public session', async () => {
    const session = makeSession({ status: 'dead', deletedAt: null });
    vi.mocked(registry.restoreSession).mockResolvedValueOnce(session);
    const res = await request(createApp()).post('/api/sessions/sess-1/restore').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(toPublicManagedSession(session));
    expect(res.body).not.toHaveProperty('deletedAt');
    expect(tmuxCli.newSession).not.toHaveBeenCalled();
  });

  it('answers 404 / 409 session_not_trashed when restoring or purging what isn\'t in the trash', async () => {
    vi.mocked(registry.restoreSession).mockResolvedValueOnce(undefined);
    expect((await request(createApp()).post('/api/sessions/x/restore').set('Authorization', auth)).status).toBe(404);
    vi.mocked(registry.restoreSession).mockResolvedValueOnce(null);
    const restore = await request(createApp()).post('/api/sessions/sess-1/restore').set('Authorization', auth);
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('session_not_trashed');
    vi.mocked(registry.purgeSession).mockResolvedValueOnce(undefined);
    expect((await request(createApp()).post('/api/sessions/x/purge').set('Authorization', auth)).status).toBe(404);
    vi.mocked(registry.purgeSession).mockResolvedValueOnce(null);
    const purge = await request(createApp()).post('/api/sessions/sess-1/purge').set('Authorization', auth);
    expect(purge.status).toBe(409);
    expect(purge.body.code).toBe('session_not_trashed');
  });

  it('purges a trashed session with 204', async () => {
    vi.mocked(registry.purgeSession).mockResolvedValueOnce(makeSession({ deletedAt: '2026-10-01T00:00:00Z' }));
    const res = await request(createApp()).post('/api/sessions/sess-1/purge').set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(registry.purgeSession).toHaveBeenCalledWith('sess-1');
  });
});

describe('POST /api/sessions/:id/launch', () => {
  it('400s on an invalid provider', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/launch')
      .set('Authorization', auth)
      .send({ profileId: 'native:not-a-real-provider' });
    expect(res.status).toBe(400);
  });

  it('404s when the session does not exist', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nope/launch')
      .set('Authorization', auth)
      .send({ profileId: 'native:claude' });
    expect(res.status).toBe(404);
  });

  it('409s when the session is dead', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'dead' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/launch')
      .set('Authorization', auth)
      .send({ profileId: 'native:claude' });
    expect(res.status).toBe(409);
  });

  it('409s, sending nothing, when the tmux is gone though the record says otherwise', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'idle' }));
    vi.mocked(sessionService.endIfTmuxGone).mockResolvedValueOnce(true);
    const res = await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:claude' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_dead');
    expect(registry.beginPendingLaunch).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('does not launch a second provider while this tmux already has an active provider', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ provider: 'claude', activeConversationId: 'active' }));

    const response = await request(createApp())
      .post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:codex' });

    expect(response.status).toBe(409);
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
    expect(registry.commitConversationLaunch).not.toHaveBeenCalled();
  });

  it('sends only one command when concurrent launch requests race for the same tmux', async () => {
    const session = makeSession();
    vi.mocked(registry.getSession).mockResolvedValue(session);
    vi.mocked(registry.beginPendingLaunch)
      .mockResolvedValueOnce(makeSession({ status: 'launching' }))
      .mockResolvedValueOnce(null);

    const app = createApp();
    const launch = () => request(app).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:claude' });
    const responses = await Promise.all([launch(), launch()]);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledTimes(1);
    expect(registry.beginPendingLaunch).toHaveBeenCalledTimes(2);
  });

  it('claims, dispatches once and leaves startup confirmation to the poller', async () => {
    const session = makeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);

    const res = await request(createApp())
      .post('/api/sessions/sess-1/launch')
      .set('Authorization', auth)
      .send({ profileId: 'native:claude' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('launching');
    expect(registry.beginPendingLaunch).toHaveBeenCalledWith(session.id, expect.objectContaining({ provider: 'claude', previousStatus: 'idle' }));
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledTimes(1);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(session.tmuxName, expect.arrayContaining(['claude', '--session-id']));
    // The request never judges startup: no liveness verdict.
    expect(tmuxCli.getPaneLiveness).not.toHaveBeenCalled();
    expect(registry.commitConversationLaunch).not.toHaveBeenCalled();
    expect(registry.rollbackPendingLaunch).not.toHaveBeenCalled();
    // Ownership is released only after dispatch, keyed by the claim.
    const claim = vi.mocked(registry.beginPendingLaunch).mock.calls[0]![1]!;
    expect(registry.releaseLaunchAttempt).toHaveBeenCalledWith(session.id, claim.providerLaunchedAt);
    expect(vi.mocked(registry.releaseLaunchAttempt).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(tmuxCli.sendCommandLine).mock.invocationCallOrder[0]!);
  });

  it('launches native Codex with its own CODEX_HOME and records its transcript context', async () => {
    const session = makeSession();
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);

    const response = await request(createApp())
      .post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:codex' });

    expect(response.status).toBe(202);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(session.tmuxName, [
      'env', expect.stringMatching(/^CODEX_HOME=/), 'codex', '-c', 'check_for_update_on_startup=false', '--no-daemon',
    ]);
    expect(vi.mocked(registry.beginPendingLaunch).mock.calls[0]![1]!.launchProfile).toMatchObject({
      id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: expect.any(String), conversationRoot: expect.stringMatching(/sessions$/),
    });
  });

  it('keeps the claim and never re-sends when dispatch cannot be confirmed', async () => {
    const session = makeSession({ status: 'ready', turnPhase: 'replying' });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);
    vi.mocked(tmuxCli.sendCommandLine).mockRejectedValueOnce(new Error('tmux went away mid-send'));

    const response = await request(createApp())
      .post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:codex' });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain('不會重送');
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledTimes(1);
    expect(registry.rollbackPendingLaunch).not.toHaveBeenCalled();
    expect(registry.commitConversationLaunch).not.toHaveBeenCalled();
    expect(registry.updateSession).toHaveBeenCalledWith(session.id, { lastError: expect.stringContaining('不會重送') });
    expect(registry.releaseLaunchAttempt).toHaveBeenCalledTimes(1);
  });

  it('refuses a profile whose saved launch settings cannot build a command', async () => {
    vi.mocked(launchProfiles.getLaunchProfileCatalog).mockResolvedValueOnce({
      profiles: [{
        id: 'janus:bad', provider: 'codex', label: 'codex · bad', source: 'janus',
        profileName: '--help', home: '/private/janus/bad', conversationRoot: '/private/janus/bad/sessions', janusExecutable: '/opt/janus/bin/janus',
      }],
      discoveredAt: '2026-09-23T00:00:00.000Z', janus: { available: true, error: null },
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());

    const response = await request(createApp())
      .post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'janus:bad' });

    expect(response.status).toBe(409);
    expect(registry.beginPendingLaunch).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('launches Janus through the discovered absolute executable and never exposes its paths', async () => {
    const session = makeSession();
    vi.mocked(launchProfiles.getLaunchProfileCatalog).mockResolvedValueOnce({
      profiles: [{
        id: 'janus:codex-work', provider: 'codex', label: 'codex · work', source: 'janus',
        profileName: 'work', home: '/private/janus/work/codex',
        conversationRoot: '/private/janus/work/codex/sessions', janusExecutable: '/opt/janus/bin/janus',
      }],
      discoveredAt: '2026-09-23T00:00:00.000Z', janus: { available: true, error: null },
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(session);

    const response = await request(createApp())
      .post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'janus:codex-work' });

    expect(response.status).toBe(202);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(session.tmuxName, [
      '/opt/janus/bin/janus', 'run', 'work', '-c', 'check_for_update_on_startup=false', '--no-daemon',
    ]);
    expect(JSON.stringify(response.body)).not.toContain('/private/janus');
    expect(JSON.stringify(response.body)).not.toContain('/opt/janus');
    const snapshot = vi.mocked(registry.beginPendingLaunch).mock.calls[0]![1]!.launchProfile;
    expect(snapshot?.conversationRoot).toBe('/private/janus/work/codex/sessions');
  });
});

describe('POST /api/sessions/:id/launch — a CLI that is not installed', () => {
  it('refuses at once, naming the command, and sends nothing', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValueOnce('missing');

    const res = await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:gemini' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'launch_cli_not_found', params: { command: 'gemini' } });
    expect(commandCheck.checkCommandAvailable).toHaveBeenCalledWith('gemini', { tmuxName: 'hestia-sess-1', cwd: PROJECT_DIR });
    expect(registry.beginPendingLaunch).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });

  it('launches as before when the check cannot tell', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession());
    vi.mocked(commandCheck.checkCommandAvailable).mockResolvedValueOnce('unknown');

    const res = await request(createApp()).post('/api/sessions/sess-1/launch').set('Authorization', auth).send({ profileId: 'native:gemini' });

    expect(res.status).toBe(202);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/sessions/:id/launch/cancel', () => {
  const LAUNCHED_AT = '2026-10-09T06:00:00.000Z';
  const launching = () => makeSession({
    status: 'launching',
    launchPending: {
      provider: 'gemini', providerSessionId: null, providerLaunchedAt: LAUNCHED_AT, previousStatus: 'idle',
      launchProfile: { id: 'native:gemini', provider: 'gemini', source: 'native', delegate: { kind: 'native', executable: 'gemini' } },
    },
  });
  const cancel = () => request(createApp()).post('/api/sessions/sess-1/launch/cancel').set('Authorization', auth).send({});

  it('resets the pane and puts the session back as it was before the launch', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(launching());
    vi.mocked(registry.claimPendingLaunch).mockResolvedValueOnce(launching());
    vi.mocked(registry.rollbackPendingLaunch).mockResolvedValueOnce(makeSession({ status: 'idle' }));

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    expect(tmuxCli.respawnPane).toHaveBeenCalledWith('hestia-sess-1', PROJECT_DIR);
    // No error left behind, and never a newer launch undone.
    expect(registry.rollbackPendingLaunch).toHaveBeenCalledWith('sess-1', null, LAUNCHED_AT);
    expect(vi.mocked(tmuxCli.respawnPane).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(registry.rollbackPendingLaunch).mock.invocationCallOrder[0]!);
  });

  it('has nothing to cancel when no launch is waiting', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'idle' }));
    const res = await cancel();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_launch_to_cancel');
    expect(tmuxCli.respawnPane).not.toHaveBeenCalled();
  });

  it('leaves a launch whose request is still being sent to that request', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(launching());
    vi.mocked(registry.ownsLaunchAttemptLocally).mockReturnValueOnce(true);
    const res = await cancel();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_launch_to_cancel');
    expect(registry.ownsLaunchAttemptLocally).toHaveBeenCalledWith('sess-1', LAUNCHED_AT);
    expect(tmuxCli.respawnPane).not.toHaveBeenCalled();
    expect(registry.rollbackPendingLaunch).not.toHaveBeenCalled();
  });

  it('keeps the launch waiting when the pane cannot be reset', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(launching());
    vi.mocked(registry.claimPendingLaunch).mockResolvedValueOnce(launching());
    vi.mocked(tmuxCli.respawnPane).mockRejectedValueOnce(new Error('tmux gone'));
    const res = await cancel();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('pane_reset_failed');
    expect(registry.rollbackPendingLaunch).not.toHaveBeenCalled();
  });

  it('404s for a session that is not there', async () => {
    vi.mocked(registry.getSession).mockResolvedValueOnce(undefined);
    expect((await cancel()).status).toBe(404);
  });
});

describe('auth gate', () => {
  it('401s every sessions route without a login token', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
  });
});

describe('switching to an earlier conversation in the same tmux', () => {
  let transcriptRoot: string;
  let transcriptFile: string;
  const TARGET_SID = 'a13782f4-715f-4abc-9233-2207319a1234';

  beforeEach(async () => {
    transcriptRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-switch-route-'));
    const projectDir = path.join(transcriptRoot, 'project');
    await mkdir(projectDir);
    transcriptFile = path.join(projectDir, TARGET_SID + '.jsonl');
    await writeFile(transcriptFile, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
  });

  afterEach(async () => { await rm(transcriptRoot, { recursive: true, force: true }); });

  // #1 = ended Claude conversation (the target); #2 = whatever runs now.
  function twoConversationSession(running: { provider: 'claude' | 'codex' | null; status: ManagedSession['status']; turnPhase?: ManagedSession['turnPhase'] }, targetOverrides = {}): ManagedSession {
    const claudeProfile = { id: 'native:claude', provider: 'claude' as const, source: 'native' as const, home: transcriptRoot, conversationRoot: transcriptRoot, delegate: { kind: 'native' as const, executable: TRUE_BIN } };
    const base = {
      kind: 'cli' as const, endReason: null, lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null,
      pendingInteraction: null, transcriptError: null, turns: [],
    };
    const target = {
      ...base, id: 'conversation-1', sequence: 1, provider: 'claude' as const, runtimeId: 'claude-code' as const, launchProfile: claudeProfile,
      providerSessionId: TARGET_SID, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z', startReason: 'launch' as const,
      endReason: 'relaunch' as const, transcript: { state: 'resolved' as const, identity: 'pinned_id' as const, file: transcriptFile },
      ...targetOverrides,
    };
    const current = running.provider ? [{
      ...base, id: 'conversation-2', sequence: 2, provider: running.provider,
      runtimeId: running.provider === 'codex' ? 'codex-cli' as const : 'claude-code' as const, launchProfile: null,
      providerSessionId: null, startedAt: '2026-01-02T00:00:00Z', endedAt: null, startReason: 'relaunch' as const,
      transcript: { state: 'pending' as const, identity: null, file: null },
    }] : [];
    return makeSession({
      provider: running.provider, status: running.status, turnPhase: running.turnPhase,
      activeConversationId: running.provider ? 'conversation-2' : null,
      conversations: [target, ...current],
    });
  }

  it('asks a running Claude to stop and /exit, then claims the switch for polling to launch', async () => {
    const session = twoConversationSession({ provider: 'claude', status: 'ready', turnPhase: 'replying' });
    vi.mocked(registry.getSession).mockResolvedValue(session);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('alive');

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(registry.beginConversationSwitch).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      conversationId: 'conversation-2', targetConversationId: 'conversation-1', phase: 'waiting_exit',
      launchArgv: ['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', TRUE_BIN, '--resume', TARGET_SID], exitProvider: 'claude',
    }));
    expect(vi.mocked(tmuxCli.sendKey).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(tmuxCli.sendText).mock.invocationCallOrder[0]!);
    expect(tmuxCli.sendKey).toHaveBeenCalledWith(session.tmuxName, 'Escape');
    expect(tmuxCli.sendText).toHaveBeenCalledWith(session.tmuxName, '/exit');
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
    expect(registry.releaseClearAttempt).toHaveBeenCalled();
  });

  it('exits a running Codex through its own verified exit key, interrupting a reply first', async () => {
    const session = twoConversationSession({ provider: 'codex', status: 'ready', turnPhase: 'replying' });
    vi.mocked(registry.getSession).mockResolvedValue(session);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('alive');

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(tmuxCli.getPaneLiveness).toHaveBeenCalledWith(session.tmuxName, { commands: ['codex'], wrappers: ['node'] });
    expect(registry.beginConversationSwitch).toHaveBeenCalledWith('sess-1', expect.objectContaining({ phase: 'waiting_exit', exitProvider: 'codex' }));
    expect(vi.mocked(tmuxCli.sendKey).mock.calls).toEqual([[session.tmuxName, 'Escape'], [session.tmuxName, 'C-c']]);
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('asks the user instead of exiting a replying runtime whose interrupt is not verified', async () => {
    const session = twoConversationSession({ provider: 'codex', status: 'ready', turnPhase: 'replying' });
    const agyRunning = {
      ...session, provider: 'gemini' as const, runtimeId: 'agy' as const,
      conversations: session.conversations!.map((conversation) => conversation.id === 'conversation-2'
        ? { ...conversation, provider: 'gemini' as const, runtimeId: 'agy' as const }
        : conversation),
    };
    vi.mocked(registry.getSession).mockResolvedValue(agyRunning);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('alive');

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(tmuxCli.getPaneLiveness).toHaveBeenCalledWith(session.tmuxName, { commands: ['agy'], wrappers: [] });
    expect(registry.beginConversationSwitch).toHaveBeenCalledWith('sess-1', expect.objectContaining({ phase: 'awaiting_force', exitProvider: 'gemini' }));
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('goes straight to asking the user when the running runtime has no verified exit', async () => {
    const session = twoConversationSession({ provider: 'codex', status: 'ready' });
    const unknownRuntime = {
      ...session,
      conversations: session.conversations!.map((conversation) => conversation.id === 'conversation-2'
        ? { ...conversation, runtimeId: 'legacy-unknown' as const }
        : conversation),
    };
    vi.mocked(registry.getSession).mockResolvedValue(unknownRuntime);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('unknown');

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(202);
    // Without a driver only a plain shell is recognizable.
    expect(tmuxCli.getPaneLiveness).toHaveBeenCalledWith(session.tmuxName, { commands: [], wrappers: [] });
    expect(registry.beginConversationSwitch).toHaveBeenCalledWith('sess-1', expect.objectContaining({ phase: 'awaiting_force', exitProvider: 'codex' }));
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
    expect(tmuxCli.sendKey).not.toHaveBeenCalled();
  });

  it('needs no exit at all when the pane is already a shell in the session cwd', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(twoConversationSession({ provider: null, status: 'idle' }));
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(registry.beginConversationSwitch).toHaveBeenCalledWith('sess-1', expect.objectContaining({ conversationId: null, phase: 'waiting_exit' }));
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('refuses with recovery_cwd_missing when the tmux has to be reopened in a folder that is gone', async () => {
    const session = twoConversationSession({ provider: null, status: 'dead' });
    vi.mocked(registry.getSession).mockResolvedValue({ ...session, cwd: path.join(transcriptRoot, 'gone') });
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('recovery_cwd_missing');
    expect(registry.beginConversationSwitch).not.toHaveBeenCalled();
    expect(tmuxCli.newSession).not.toHaveBeenCalled();
  });

  it('refuses a conversation that cannot be continued, with the reason, and claims nothing', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(twoConversationSession({ provider: 'claude', status: 'ready' }, { provider: 'codex' }));

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('codex');
    expect(registry.beginConversationSwitch).not.toHaveBeenCalled();
    expect(tmuxCli.sendText).not.toHaveBeenCalled();
  });

  it('force resets the pane only while a switch is awaiting that decision', async () => {
    const awaiting = makeSession({ status: 'launching', clearPending: {
      attemptId: 'a1', conversationId: null, targetConversationId: 'conversation-1', newProviderSessionId: TARGET_SID,
      launchArgv: [], startedAt: 'now', previousStatus: 'ready', phase: 'awaiting_force', launchStartedAt: null,
    } });
    vi.mocked(registry.getSession).mockResolvedValueOnce(awaiting);
    vi.mocked(registry.setPendingExitPhase).mockResolvedValueOnce(awaiting);
    const forced = await request(createApp()).post('/api/sessions/sess-1/conversation-switch/force').set('Authorization', auth);
    expect(forced.status).toBe(200);
    expect(tmuxCli.respawnPane).toHaveBeenCalledWith(awaiting.tmuxName, awaiting.cwd);
    expect(registry.setPendingExitPhase).toHaveBeenCalledWith('sess-1', 'a1', 'awaiting_force', 'waiting_exit');

    vi.mocked(registry.getSession).mockResolvedValueOnce(makeSession({ status: 'ready' }));
    const nothingPending = await request(createApp()).post('/api/sessions/sess-1/conversation-switch/force').set('Authorization', auth);
    expect(nothingPending.status).toBe(409);
    expect(tmuxCli.respawnPane).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the switch and restores the previous state, but not once the launch was sent', async () => {
    const pending = (phase: 'awaiting_force' | 'launching') => makeSession({ status: 'launching', clearPending: {
      attemptId: 'a1', conversationId: null, targetConversationId: 'conversation-1', newProviderSessionId: TARGET_SID,
      launchArgv: [], startedAt: 'now', previousStatus: 'ready', phase, launchStartedAt: null,
    } });
    vi.mocked(registry.getSession).mockResolvedValueOnce(pending('awaiting_force'));
    vi.mocked(registry.failPendingClear).mockResolvedValueOnce(makeSession({ status: 'ready' }));
    const cancelled = await request(createApp()).post('/api/sessions/sess-1/conversation-switch/cancel').set('Authorization', auth);
    expect(cancelled.status).toBe(200);
    expect(registry.failPendingClear).toHaveBeenCalledWith('sess-1', 'a1', null, { exited: false });

    vi.mocked(registry.getSession).mockResolvedValueOnce(pending('launching'));
    const tooLate = await request(createApp()).post('/api/sessions/sess-1/conversation-switch/cancel').set('Authorization', auth);
    expect(tooLate.status).toBe(409);
    expect(registry.failPendingClear).toHaveBeenCalledTimes(1);
  });

  describe('a /clear whose old CLI did not exit (建立新的對話)', () => {
    const clearPending = (phase: 'waiting_exit' | 'awaiting_force' | 'launching') => makeSession({ status: 'launching', clearPending: {
      attemptId: 'c1', conversationId: 'conversation-1', newProviderSessionId: null,
      launchArgv: [], startedAt: 'now', previousStatus: 'ready', previousTurnPhase: 'replying', phase, launchStartedAt: null,
    } });
    const post = (path: string) => request(createApp()).post(`/api/sessions/sess-1/${path}`).set('Authorization', auth);

    it('force resets the pane and lets the new conversation start, only while awaiting that decision', async () => {
      vi.mocked(registry.getSession).mockResolvedValueOnce(clearPending('awaiting_force'));
      vi.mocked(registry.setPendingExitPhase).mockResolvedValueOnce(clearPending('waiting_exit'));
      const forced = await post('clear/force');
      expect(forced.status).toBe(200);
      expect(tmuxCli.respawnPane).toHaveBeenCalledWith('hestia-sess-1', expect.any(String));
      expect(registry.setPendingExitPhase).toHaveBeenCalledWith('sess-1', 'c1', 'awaiting_force', 'waiting_exit');

      vi.mocked(registry.getSession).mockResolvedValueOnce(clearPending('waiting_exit'));
      const tooEarly = await post('clear/force');
      expect(tooEarly.body.code).toBe('no_clear_awaiting_force');
      expect(tmuxCli.respawnPane).toHaveBeenCalledTimes(1);
    });

    it('cancel drops the clear and leaves the CLI running, but not once the new one was sent', async () => {
      vi.mocked(registry.getSession).mockResolvedValueOnce(clearPending('awaiting_force'));
      vi.mocked(registry.failPendingClear).mockResolvedValueOnce(makeSession({ status: 'ready' }));
      expect((await post('clear/cancel')).status).toBe(200);
      expect(registry.failPendingClear).toHaveBeenCalledWith('sess-1', 'c1', null, { exited: false });

      vi.mocked(registry.getSession).mockResolvedValueOnce(clearPending('launching'));
      expect((await post('clear/cancel')).body.code).toBe('no_clear_to_cancel');
      expect(registry.failPendingClear).toHaveBeenCalledTimes(1);
    });

    it('never acts on the other kind: a switch is not a clear and vice versa', async () => {
      const switchPending = makeSession({ status: 'launching', clearPending: {
        attemptId: 'a1', conversationId: null, targetConversationId: 'conversation-1', newProviderSessionId: TARGET_SID,
        launchArgv: [], startedAt: 'now', previousStatus: 'ready', phase: 'awaiting_force', launchStartedAt: null,
      } });
      vi.mocked(registry.getSession).mockResolvedValueOnce(switchPending);
      expect((await post('clear/force')).body.code).toBe('no_clear_awaiting_force');
      vi.mocked(registry.getSession).mockResolvedValueOnce(switchPending);
      expect((await post('clear/cancel')).body.code).toBe('no_clear_to_cancel');
      vi.mocked(registry.getSession).mockResolvedValueOnce(clearPending('awaiting_force'));
      expect((await post('conversation-switch/force')).body.code).toBe('no_switch_awaiting_force');
      vi.mocked(registry.getSession).mockResolvedValueOnce(clearPending('awaiting_force'));
      expect((await post('conversation-switch/cancel')).body.code).toBe('no_switch_to_cancel');
      expect(tmuxCli.respawnPane).not.toHaveBeenCalled();
      expect(registry.failPendingClear).not.toHaveBeenCalled();
    });
  });
});

describe('reopening a Codex conversation', () => {
  // A UUIDv7 thread id: Codex files its rollout under the id's own date.
  const THREAD = '01a10a0a-577d-78f0-b390-d594bfdf9eac';
  let home: string;
  let rollout: string;

  beforeEach(async () => {
    accountLimitedUntil.mockResolvedValue(null);
    home = await mkdtemp(path.join(os.tmpdir(), 'codex-resume-route-'));
    const day = path.join(home, 'sessions', '2026', '10', '05');
    await mkdir(day, { recursive: true });
    rollout = path.join(day, `rollout-2026-10-05T11-10-12-${THREAD}.jsonl`);
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: THREAD, session_id: THREAD, cwd: PROJECT_DIR } }) + '\n');
  });

  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  function codexConversation(overrides = {}) {
    return {
      id: 'conversation-1', sequence: 1, kind: 'cli' as const, provider: 'codex' as const, runtimeId: 'codex-cli' as const,
      launchProfile: { id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, source: 'native' as const, home, conversationRoot: path.join(home, 'sessions'), args: [], delegate: { kind: 'native' as const, executable: TRUE_BIN } },
      providerSessionId: THREAD, startedAt: '2026-10-05T03:10:00Z', endedAt: null, startReason: 'launch' as const, endReason: null,
      transcript: { state: 'resolved' as const, identity: 'verified_metadata' as const, file: rollout },
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null,
      transcriptError: null, turns: [{ index: 1, user: { text: 'hi', at: null }, assistant: { text: 'hello', at: null } }],
      ...overrides,
    };
  }

  it('recovers a dead tmux with `codex resume --no-daemon -C <folder> <thread>` from the saved profile', async () => {
    const conversation = codexConversation();
    const old = makeSession({
      provider: 'codex', runtimeId: 'codex-cli', providerSessionId: THREAD, status: 'dead',
      launchProfile: conversation.launchProfile, activeConversationId: conversation.id, conversations: [conversation],
    });
    vi.mocked(registry.getSession).mockResolvedValueOnce(old);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(false);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/recover-claude').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(tmuxCli.sendCommandLine).toHaveBeenCalledWith(old.tmuxName, [
      'env', `CODEX_HOME=${home}`, TRUE_BIN, 'resume', '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', PROJECT_DIR, THREAD,
    ]);
    // The poller commits it, once the pane holds that thread.
    expect(registry.commitPendingResume).not.toHaveBeenCalled();
  });

  it('switches back to an ended Codex conversation in the same tmux', async () => {
    const session = makeSession({ status: 'idle', conversations: [codexConversation({ endedAt: '2026-10-05T04:00:00Z', endReason: 'provider_switch' })] });
    vi.mocked(registry.getSession).mockResolvedValue(session);
    vi.mocked(tmuxCli.sessionExists).mockResolvedValueOnce(true);
    vi.mocked(tmuxCli.getPaneLiveness).mockResolvedValueOnce('dead');

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(202);
    expect(registry.beginConversationSwitch).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      targetConversationId: 'conversation-1', newProviderSessionId: THREAD,
      launchArgv: ['env', `CODEX_HOME=${home}`, TRUE_BIN, 'resume', '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', PROJECT_DIR, THREAD],
    }));
  });

  it('refuses to reopen a conversation whose account is over its limit, saying when it resets', async () => {
    accountLimitedUntil.mockResolvedValue('2026-10-05T06:26:00.000Z');
    const session = makeSession({ status: 'idle', conversations: [codexConversation({ endedAt: '2026-10-05T04:00:00Z', endReason: 'provider_switch' })] });
    vi.mocked(registry.getSession).mockResolvedValue(session);

    const response = await request(createApp()).post('/api/sessions/sess-1/conversations/conversation-1/resume').set('Authorization', auth);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'resume_account_limited', params: { until: '2026-10-05T06:26:00.000Z' } });
    expect(accountLimitedUntil).toHaveBeenCalledWith(expect.objectContaining({ id: 'native:codex' }));
    expect(registry.beginConversationSwitch).not.toHaveBeenCalled();
    expect(tmuxCli.sendCommandLine).not.toHaveBeenCalled();
  });
});
