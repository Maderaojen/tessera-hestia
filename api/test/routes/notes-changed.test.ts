import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteRecord } from '../../src/notes-store.js';

// Which note changes are announced (notes-events.ts) to whoever reacts to them.

vi.mock('../../src/project-store.js', () => ({ getProject: vi.fn(async (id: string) => (id === 'gone' ? undefined : { id })) }));
vi.mock('../../src/notes-store.js', () => ({
  toNoteDto: (note: NoteRecord) => note,
  createNote: vi.fn(async () => ({ id: 'n1', text: 'a' })),
  updateNoteText: vi.fn(async (_p: string, id: string) => (id === 'missing' ? undefined : { id, text: 'b' })),
  deleteNote: vi.fn(async () => true),
  moveNotes: vi.fn(async (_from: string, ids: string[]) => ids.map((id) => ({ id }))),
  markNotesDone: vi.fn(async (_p: string, ids: string[]) => ids.map((id) => ({ id }))),
  markNotesUndone: vi.fn(async (_p: string, ids: string[]) => ids.filter((id) => id !== 'none').map((id) => ({ id }))),
}));
vi.mock('../../src/tag-index.js', () => ({ listAllTags: vi.fn(async () => []) }));

const { notesRouter } = await import('../../src/routes/notes.js');
const { onNotesChanged } = await import('../../src/notes-events.js');

const app = () => express().use(express.json()).use('/projects', notesRouter);

describe('notes changed', () => {
  const heard: string[] = [];
  const stop = onNotesChanged((projectId) => heard.push(projectId));
  afterEach(() => {
    heard.length = 0;
    vi.clearAllMocks();
  });

  it('is told when a note is created or edited, moved in, or marked not done again', async () => {
    await request(app()).post('/projects/p1/notes').send({ text: 'a' }).expect(201);
    await request(app()).patch('/projects/p1/notes/n1').send({ text: 'b' }).expect(200);
    await request(app()).post('/projects/p1/notes/move').send({ noteIds: ['n1'], toProjectId: 'p2' }).expect(200);
    await request(app()).post('/projects/p2/notes/mark-undone').send({ noteIds: ['n1'] }).expect(200);
    expect(heard).toEqual(['p1', 'p1', 'p2', 'p2']);
  });

  it('is not told for a change that gives nothing new to work on, or that didn\'t happen', async () => {
    await request(app()).delete('/projects/p1/notes/n1').expect(204);
    await request(app()).post('/projects/p1/notes/mark-done').send({ noteIds: ['n1'] }).expect(200);
    await request(app()).patch('/projects/p1/notes/missing').send({ text: 'b' }).expect(404);
    await request(app()).post('/projects/p1/notes/mark-undone').send({ noteIds: ['none'] }).expect(200);
    await request(app()).post('/projects/gone/notes').send({ text: 'a' }).expect(404);
    expect(heard).toEqual([]);
    stop();
  });
});
