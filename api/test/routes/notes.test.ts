import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import type { NoteRecord } from '../../src/notes-store.js';
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
}));

vi.mock('../../src/notes-store.js', async (importOriginal) => ({
  toNoteDto: (await importOriginal<typeof import('../../src/notes-store.js')>()).toNoteDto,
  toTrashedNoteDto: (await importOriginal<typeof import('../../src/notes-store.js')>()).toTrashedNoteDto,
  listNotes: vi.fn(),
  listTrashedNotes: vi.fn(),
  restoreNote: vi.fn(),
  createNote: vi.fn(),
  updateNoteText: vi.fn(),
  deleteNote: vi.fn(),
  markNotesUsed: vi.fn(),
  markNotesUnused: vi.fn(),
  markNotesDone: vi.fn(),
  markNotesUndone: vi.fn(),
  moveNotes: vi.fn(),
}));

vi.mock('../../src/tag-index.js', () => ({
  listAllTags: vi.fn(),
  syncNoteTags: vi.fn(async () => {}),
  removeProjectFromAllTags: vi.fn(async () => {}),
  remapSessionToProject: vi.fn(async () => {}),
}));

const projectStore = await import('../../src/project-store.js');
const notesStore = await import('../../src/notes-store.js');
const tagIndex = await import('../../src/tag-index.js');

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

function makeNote(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'note-1',
    sessionId: 'sess-1',
    text: 'hello #tag',
    attachmentId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    used: false,
    usedAt: null,
    done: false,
    doneAt: null,
    uses: [],
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

describe('GET /api/projects/:id/notes', () => {
  it('404s when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/projects/nope/notes').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('404s for a soft-deleted project', async () => {
    // getProject() already treats deleted projects as "not found" per spec.
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).get('/api/projects/deleted-proj/notes').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('returns the project notes', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.listNotes).mockResolvedValueOnce([makeNote()]);
    const app = createApp();
    const res = await request(app).get('/api/projects/proj-1/notes').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].id).toBe('note-1');
  });

  it('two sessions creating notes in the same project both show up in one GET', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.listNotes).mockResolvedValueOnce([
      makeNote({ id: 'note-1', sessionId: 'sess-a' }),
      makeNote({ id: 'note-2', sessionId: 'sess-b' }),
    ]);
    const app = createApp();
    const res = await request(app).get('/api/projects/proj-1/notes').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: NoteRecord) => n.id)).toEqual(['note-1', 'note-2']);
  });
});

describe('POST /api/projects/:id/notes', () => {
  it('400s on invalid body', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes')
      .set('Authorization', auth)
      .send({ text: '', sessionId: 'sess-1' });
    expect(res.status).toBe(400);
  });

  it('takes a note with no session (one written outside any tmux, e.g. into the inbox)', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject({ id: 'inbox', name: '收件匣' }));
    vi.mocked(notesStore.createNote).mockResolvedValueOnce({ id: 'n1' } as never);
    const app = createApp();
    const res = await request(app).post('/api/projects/inbox/notes').set('Authorization', auth).send({ text: 'hello' });
    expect(res.status).toBe(201);
    expect(notesStore.createNote).toHaveBeenCalledWith('inbox', { text: 'hello', attachmentId: null, sessionId: null });
  });

  it('404s when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/nope/notes')
      .set('Authorization', auth)
      .send({ text: 'hello', sessionId: 'sess-1' });
    expect(res.status).toBe(404);
  });

  it('creates a note', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.createNote).mockResolvedValueOnce(makeNote());
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes')
      .set('Authorization', auth)
      .send({ text: 'hello #tag', attachmentId: 'notes/x.png', sessionId: 'sess-1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('note-1');
    expect(notesStore.createNote).toHaveBeenCalledWith('proj-1', {
      text: 'hello #tag',
      attachmentId: 'notes/x.png',
      sessionId: 'sess-1',
    });
  });

  it('takes an upload\'s path from PWAs cached before attachments, stored as its attachment', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.createNote).mockResolvedValueOnce(makeNote({ attachmentId: 'notes/x.png' }));
    const res = await request(createApp())
      .post('/api/projects/proj-1/notes')
      .set('Authorization', auth)
      .send({ text: 'hi', imagePath: '/state/uploads/notes/x.png', sessionId: 'sess-1' });
    expect(res.status).toBe(201);
    expect(notesStore.createNote).toHaveBeenCalledWith('proj-1', { text: 'hi', attachmentId: 'notes/x.png', sessionId: 'sess-1' });
    expect(res.body.attachment).toMatchObject({ id: 'notes/x.png', url: '/notes/uploads/x.png' });
    expect(res.body.imagePath).toMatch(/\/notes\/x\.png$/);
  });

  it('refuses an image that isn\'t one of its uploads', async () => {
    for (const body of [{ imagePath: '/etc/passwd' }, { attachmentId: '../../etc/x.png' }, { attachmentId: 'notes/x.exe' }]) {
      const res = await request(createApp()).post('/api/projects/proj-1/notes').set('Authorization', auth).send({ text: 'x', ...body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }
    expect(notesStore.createNote).not.toHaveBeenCalled();
  });

  it('creates an image-only note (empty text, imagePath set)', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.createNote).mockResolvedValueOnce(makeNote({ text: '', attachmentId: 'notes/path.png' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes')
      .set('Authorization', auth)
      .send({ text: '', attachmentId: 'notes/path.png', sessionId: 'sess-1' });
    expect(res.status).toBe(201);
    expect(notesStore.createNote).toHaveBeenCalledWith('proj-1', {
      text: '',
      attachmentId: 'notes/path.png',
      sessionId: 'sess-1',
    });
  });

  it('400s when both text and imagePath are empty/absent', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes')
      .set('Authorization', auth)
      .send({ text: '', imagePath: null, sessionId: 'sess-1' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/projects/:id/notes/:noteId', () => {
  it('400s on invalid body', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/projects/proj-1/notes/note-1')
      .set('Authorization', auth)
      .send({ text: '' });
    expect(res.status).toBe(400);
  });

  it('404s when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .patch('/api/projects/nope/notes/note-1')
      .set('Authorization', auth)
      .send({ text: 'edit' });
    expect(res.status).toBe(404);
  });

  it('404s when the note does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.updateNoteText).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .patch('/api/projects/proj-1/notes/nope')
      .set('Authorization', auth)
      .send({ text: 'edit' });
    expect(res.status).toBe(404);
  });

  it('updates a note', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.updateNoteText).mockResolvedValueOnce(makeNote({ text: 'edited' }));
    const app = createApp();
    const res = await request(app)
      .patch('/api/projects/proj-1/notes/note-1')
      .set('Authorization', auth)
      .send({ text: 'edited' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('edited');
  });
});

describe('DELETE /api/projects/:id/notes/:noteId', () => {
  it('404s when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app).delete('/api/projects/nope/notes/note-1').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('404s when the note does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.deleteNote).mockResolvedValueOnce(false);
    const app = createApp();
    const res = await request(app).delete('/api/projects/proj-1/notes/nope').set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('deletes a note', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.deleteNote).mockResolvedValueOnce(true);
    const app = createApp();
    const res = await request(app).delete('/api/projects/proj-1/notes/note-1').set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(notesStore.deleteNote).toHaveBeenCalledWith('proj-1', 'note-1');
  });
});

describe('the notes trash (note_trash)', () => {
  it('GET /notes/trash lists the deleted notes with when', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.listTrashedNotes).mockResolvedValueOnce([makeNote({ deletedAt: '2026-10-08T00:00:00.000Z' })]);
    const app = createApp();
    const res = await request(app).get('/api/projects/proj-1/notes/trash').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([expect.objectContaining({ id: 'note-1', text: 'hello #tag', deletedAt: '2026-10-08T00:00:00.000Z' })]);
    expect(notesStore.listTrashedNotes).toHaveBeenCalledWith('proj-1');
  });

  it('POST /notes/:noteId/restore brings it back, without deletedAt; 404 unknown, 409 not in the trash', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValue(makeProject());
    vi.mocked(notesStore.restoreNote).mockResolvedValueOnce(makeNote());
    const app = createApp();
    const res = await request(app).post('/api/projects/proj-1/notes/note-1/restore').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'note-1' }));
    expect(res.body).not.toHaveProperty('deletedAt');

    vi.mocked(notesStore.restoreNote).mockResolvedValueOnce('not_found');
    expect((await request(app).post('/api/projects/proj-1/notes/nope/restore').set('Authorization', auth)).status).toBe(404);
    vi.mocked(notesStore.restoreNote).mockResolvedValueOnce('not_trashed');
    const live = await request(app).post('/api/projects/proj-1/notes/note-1/restore').set('Authorization', auth);
    expect(live.status).toBe(409);
    expect(live.body.error.code ?? live.body.code).toBe('note_not_trashed');
  });
});

describe('POST /api/projects/:id/notes/mark-used', () => {
  it('400s on invalid body', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes/mark-used')
      .set('Authorization', auth)
      .send({ noteIds: [] });
    expect(res.status).toBe(400);
  });

  it('404s when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(undefined);
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/nope/notes/mark-used')
      .set('Authorization', auth)
      .send({ noteIds: ['note-1'] });
    expect(res.status).toBe(404);
  });

  it('marks notes used', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.markNotesUsed).mockResolvedValueOnce([makeNote({ used: true, usedAt: '2026-01-02T00:00:00Z' })]);
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes/mark-used')
      .set('Authorization', auth)
      .send({ noteIds: ['note-1'] });
    expect(res.status).toBe(200);
    expect(res.body.notes[0].used).toBe(true);
  });
});

describe('POST /api/projects/:id/notes/mark-unused', () => {
  it('marks notes unused', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.markNotesUnused).mockResolvedValueOnce([makeNote({ used: false, usedAt: null })]);
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes/mark-unused')
      .set('Authorization', auth)
      .send({ noteIds: ['note-1'] });
    expect(res.status).toBe(200);
    expect(res.body.notes[0].used).toBe(false);
  });
});

describe('POST /api/projects/:id/notes/mark-done', () => {
  it('marks notes done', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.markNotesDone).mockResolvedValueOnce([makeNote({ done: true, doneAt: '2026-01-02T00:00:00Z' })]);
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes/mark-done')
      .set('Authorization', auth)
      .send({ noteIds: ['note-1'] });
    expect(res.status).toBe(200);
    expect(res.body.notes[0].done).toBe(true);
  });
});

describe('POST /api/projects/:id/notes/mark-undone', () => {
  it('marks notes undone', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.markNotesUndone).mockResolvedValueOnce([makeNote({ done: false, doneAt: null })]);
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/proj-1/notes/mark-undone')
      .set('Authorization', auth)
      .send({ noteIds: ['note-1'] });
    expect(res.status).toBe(200);
    expect(res.body.notes[0].done).toBe(false);
  });
});

describe('GET /api/tags', () => {
  it('returns all tags', async () => {
    vi.mocked(tagIndex.listAllTags).mockResolvedValueOnce([{ tag: 'login', count: 3 }]);
    const app = createApp();
    const res = await request(app).get('/api/tags').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([{ tag: 'login', count: 3 }]);
  });
});

describe('POST /api/projects/:id/notes/move', () => {
  it('moves notes into another existing project', async () => {
    vi.mocked(projectStore.getProject)
      .mockResolvedValueOnce(makeProject({ id: 'inbox', name: '收件匣' }))
      .mockResolvedValueOnce(makeProject({ id: 'proj-2' }));
    vi.mocked(notesStore.moveNotes).mockResolvedValueOnce([{ id: 'n1' }] as never);
    const res = await request(createApp())
      .post('/api/projects/inbox/notes/move')
      .set('Authorization', auth)
      .send({ noteIds: ['n1'], toProjectId: 'proj-2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: [{ id: 'n1', attachment: null, imagePath: null }] });
    expect(notesStore.moveNotes).toHaveBeenCalledWith('inbox', ['n1'], 'proj-2');
  });

  it('404s when the target project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject()).mockResolvedValueOnce(undefined);
    const res = await request(createApp())
      .post('/api/projects/proj-1/notes/move')
      .set('Authorization', auth)
      .send({ noteIds: ['n1'], toProjectId: 'gone' });
    expect(res.status).toBe(404);
    expect(notesStore.moveNotes).not.toHaveBeenCalled();
  });

  it('400s without notes to move', async () => {
    const res = await request(createApp())
      .post('/api/projects/proj-1/notes/move')
      .set('Authorization', auth)
      .send({ noteIds: [], toProjectId: 'proj-2' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:id/notes/mark-used', () => {
  it('records where the notes went when told', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.markNotesUsed).mockResolvedValueOnce([]);
    const res = await request(createApp())
      .post('/api/projects/proj-1/notes/mark-used')
      .set('Authorization', auth)
      .send({ noteIds: ['n1'], sessionId: 'sess-1', conversationId: 'conv-1' });

    expect(res.status).toBe(200);
    expect(notesStore.markNotesUsed).toHaveBeenCalledWith('proj-1', ['n1'], { sessionId: 'sess-1', conversationId: 'conv-1' });
  });

  it('still marks them used without an origin', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValueOnce(makeProject());
    vi.mocked(notesStore.markNotesUsed).mockResolvedValueOnce([]);
    await request(createApp()).post('/api/projects/proj-1/notes/mark-used').set('Authorization', auth).send({ noteIds: ['n1'] });
    expect(notesStore.markNotesUsed).toHaveBeenCalledWith('proj-1', ['n1'], undefined);
  });
});
