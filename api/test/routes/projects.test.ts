import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { ManagedSession } from '../../src/types.js';
import type { Project } from '../../src/project-store.js';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  capturePane: vi.fn(async () => ''),
  getPaneSize: vi.fn(async () => null),
  sendText: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendCommandLine: vi.fn(async () => {}),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab'],
}));

vi.mock('../../src/registry.js', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  listAllSessions: vi.fn(),
  listTrashedSessions: vi.fn(),
  updateSession: vi.fn(),
  removeSession: vi.fn(),
  reconcile: vi.fn(async () => {}),
}));

vi.mock('../../src/project-store.js', () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  softDeleteProject: vi.fn(),
  resolveOrCreateProjectByName: vi.fn(),
  setPrimaryProjectPath: vi.fn(),
  addProjectPath: vi.fn(),
  removeProjectPath: vi.fn(),
  INBOX_PROJECT_ID: 'inbox',
}));

vi.mock('../../src/notes-store.js', () => ({
  listNotes: vi.fn(),
  createNote: vi.fn(),
  updateNoteText: vi.fn(),
  deleteNote: vi.fn(),
  markNotesUsed: vi.fn(),
  markNotesUnused: vi.fn(),
  markNotesDone: vi.fn(),
  markNotesUndone: vi.fn(),
}));

vi.mock('../../src/tag-index.js', () => ({
  listAllTags: vi.fn(),
  syncNoteTags: vi.fn(async () => {}),
  removeProjectFromAllTags: vi.fn(async () => {}),
  remapSessionToProject: vi.fn(async () => {}),
}));

const registry = await import('../../src/registry.js');
const projectStore = await import('../../src/project-store.js');

function makeProject(overrides: Partial<Project> = {}): Project {
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
    cwd: '/some/project',
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
  vi.clearAllMocks();
});

describe('GET /api/projects', () => {
  it('only returns active projects (as project-store.listProjects already filters)', async () => {
    vi.mocked(projectStore.listProjects).mockResolvedValueOnce([makeProject()]);
    const app = createApp();
    const res = await request(app).get('/api/projects').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([makeProject()]);
  });
});

describe('POST /api/projects', () => {
  it('creates a project', async () => {
    vi.mocked(projectStore.createProject).mockResolvedValueOnce(makeProject());
    const app = createApp();
    const res = await request(app).post('/api/projects').set('Authorization', auth).send({ name: 'my-project' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(makeProject());
    expect(projectStore.createProject).toHaveBeenCalledWith('my-project');
  });

  it('400s on an empty name', async () => {
    const app = createApp();
    const res = await request(app).post('/api/projects').set('Authorization', auth).send({ name: '' });
    expect(res.status).toBe(400);
    expect(projectStore.createProject).not.toHaveBeenCalled();
  });

  it('400s on a whitespace-only name', async () => {
    const app = createApp();
    const res = await request(app).post('/api/projects').set('Authorization', auth).send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('renames a project', async () => {
    vi.mocked(projectStore.renameProject).mockResolvedValueOnce(makeProject({ name: 'renamed' }));
    const app = createApp();
    const res = await request(app).patch('/api/projects/proj-1').set('Authorization', auth).send({ name: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('renamed');
  });

  it('404s for an unknown id', async () => {
    vi.mocked(projectStore.renameProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).patch('/api/projects/nope').set('Authorization', auth).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('404s when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).delete('/api/projects/nope').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('409s when the project still has sessions (including dead ones), and does not delete it', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(registry.listSessions).mockResolvedValueOnce([makeSession({ status: 'dead' })]);
    const app = createApp();
    const res = await request(app).delete('/api/projects/proj-1').set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(projectStore.softDeleteProject).not.toHaveBeenCalled();
  });

  // The trash isn't a reason to keep a project: only live sessions (what
  // registry.listSessions returns) hold it. Its trashed sessions stay in
  // the registry, unreachable from the app until purged.
  it('counts only live sessions: one whose sessions are all in the trash can be deleted', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(registry.listSessions).mockResolvedValueOnce([]);
    vi.mocked(registry.listAllSessions).mockResolvedValue([makeSession({ status: 'dead', deletedAt: '2026-10-01T00:00:00Z' })]);
    vi.mocked(projectStore.softDeleteProject).mockResolvedValueOnce(makeProject({ deletedAt: '2026-10-02T00:00:00Z' }));
    const res = await request(createApp()).delete('/api/projects/proj-1').set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(registry.listAllSessions).not.toHaveBeenCalled();
  });

  it('204s and soft-deletes when the project has no sessions', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(registry.listSessions).mockResolvedValueOnce([makeSession({ projectId: 'other-proj' })]);
    vi.mocked(projectStore.softDeleteProject).mockResolvedValueOnce(makeProject({ deletedAt: '2026-01-02T00:00:00Z' }));
    const app = createApp();
    const res = await request(app).delete('/api/projects/proj-1').set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(projectStore.softDeleteProject).toHaveBeenCalledWith('proj-1');
  });
});

describe('the inbox', () => {
  it('cannot be renamed or deleted', async () => {
    const app = createApp();
    const rename = await request(app).patch('/api/projects/inbox').set('Authorization', auth).send({ name: 'x' });
    const remove = await request(app).delete('/api/projects/inbox').set('Authorization', auth);

    expect(rename.status).toBe(409);
    expect(remove.status).toBe(409);
    expect(projectStore.renameProject).not.toHaveBeenCalled();
    expect(projectStore.softDeleteProject).not.toHaveBeenCalled();
  });
});

describe('project paths', () => {
  it('sets the primary path', async () => {
    vi.mocked(projectStore.setPrimaryProjectPath).mockResolvedValueOnce(makeProject());
    const res = await request(createApp()).post('/api/projects/proj-1/paths/primary').set('Authorization', auth).send({ path: '/work/b' });
    expect(res.status).toBe(200);
    expect(projectStore.setPrimaryProjectPath).toHaveBeenCalledWith('proj-1', '/work/b');
  });

  it('removes a path', async () => {
    vi.mocked(projectStore.removeProjectPath).mockResolvedValueOnce(makeProject());
    const res = await request(createApp()).post('/api/projects/proj-1/paths/remove').set('Authorization', auth).send({ path: '/work/b' });
    expect(res.status).toBe(200);
    expect(projectStore.removeProjectPath).toHaveBeenCalledWith('proj-1', '/work/b');
  });

  it('404s for an unknown project or path, 400s without a path', async () => {
    vi.mocked(projectStore.setPrimaryProjectPath).mockResolvedValueOnce(undefined);
    const app = createApp();
    const unknown = await request(app).post('/api/projects/nope/paths/primary').set('Authorization', auth).send({ path: '/x' });
    const missing = await request(app).post('/api/projects/proj-1/paths/remove').set('Authorization', auth).send({});
    expect(unknown.status).toBe(404);
    expect(missing.status).toBe(400);
  });
});

describe('POST /api/projects/:id/paths', () => {
  it('adds an existing directory', async () => {
    vi.mocked(projectStore.addProjectPath).mockResolvedValueOnce(makeProject());
    const res = await request(createApp()).post('/api/projects/proj-1/paths').set('Authorization', auth).send({ path: os.tmpdir() });
    expect(res.status).toBe(200);
    expect(projectStore.addProjectPath).toHaveBeenCalledWith('proj-1', path.resolve(os.tmpdir()));
  });

  it('400s for a directory that doesn\'t exist, 404s for the inbox', async () => {
    const app = createApp();
    const missing = await request(app).post('/api/projects/proj-1/paths').set('Authorization', auth).send({ path: '/definitely/not/here' });
    const inbox = await request(app).post('/api/projects/inbox/paths').set('Authorization', auth).send({ path: os.tmpdir() });
    expect(missing.status).toBe(400);
    expect(inbox.status).toBe(404);
    expect(projectStore.addProjectPath).not.toHaveBeenCalled();
  });
});
