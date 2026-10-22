import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { attachmentById, attachmentForPath } from '../attachments.js';
import { announceNotesChanged } from '../notes-events.js';
import * as notesStore from '../notes-store.js';
import * as projectStore from '../project-store.js';
import * as tagIndex from '../tag-index.js';
import { sendError } from './errors.js';

// Project-scoped notes CRUD, mounted at /api/projects.
export const notesRouter = Router();

// Body validation runs first in each handler, so a bad body is a 400 even
// for a missing project; this is the lookup that follows it.
async function projectOr404(req: Request, res: Response): Promise<projectStore.Project | null> {
  const project = await projectStore.getProject(req.params.id as string);
  if (!project) sendError(res, 404, 'not_found', 'not found');
  return project ?? null;
}

const createSchema = z
  .object({
    text: z.string(),
    // An upload's attachment id (POST /notes/uploads).
    attachmentId: z.string().nullable().optional(),
    // Deprecated (contract v1): the upload's path, as PWAs cached
    // before attachments send it.
    imagePath: z.string().nullable().optional(),
    // 這則便箋是從哪個 session 打的字——純記錄用途；不在 session 裡記的（Home 的收件匣）沒有
    sessionId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => data.text.length > 0 || !!data.attachmentId || !!data.imagePath, {
    message: 'note must have text or an image',
  });

notesRouter.get('/:id/notes', async (req, res) => {
  const project = await projectOr404(req, res);
  if (!project) return;
  res.json({ notes: (await notesStore.listNotes(project.id)).map(notesStore.toNoteDto) });
});

// The project's trash (capability note_trash): the notes deleted, the
// latest first, each with when.
notesRouter.get('/:id/notes/trash', async (req, res) => {
  const project = await projectOr404(req, res);
  if (!project) return;
  res.json({ notes: (await notesStore.listTrashedNotes(project.id)).map(notesStore.toTrashedNoteDto) });
});

notesRouter.post('/:id/notes', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  // Only ever an upload of this API's own, named by id or (older clients)
  // by the path it handed out.
  const { attachmentId, imagePath } = parsed.data;
  const attachment = attachmentId ? attachmentById(attachmentId) : imagePath ? attachmentForPath(imagePath) : null;
  // A note's image only: a file the composer attached isn't one.
  if ((attachmentId || imagePath) && attachment?.kind !== 'image') {
    sendError(res, 400, 'invalid_request', 'attachment does not name an upload');
    return;
  }
  const project = await projectOr404(req, res);
  if (!project) return;
  const note = await notesStore.createNote(project.id, {
    text: parsed.data.text,
    attachmentId: attachment?.id ?? null,
    sessionId: parsed.data.sessionId ?? null,
  });
  announceNotesChanged(project.id);
  res.status(201).json(notesStore.toNoteDto(note));
});

const updateSchema = z.object({ text: z.string().min(1) });

notesRouter.patch('/:id/notes/:noteId', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectOr404(req, res);
  if (!project) return;
  const updated = await notesStore.updateNoteText(project.id, req.params.noteId as string, parsed.data.text);
  if (!updated) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  announceNotesChanged(project.id);
  res.json(notesStore.toNoteDto(updated));
});

notesRouter.delete('/:id/notes/:noteId', async (req, res) => {
  const project = await projectOr404(req, res);
  if (!project) return;
  // Into the trash (note_trash), not gone.
  const deleted = await notesStore.deleteNote(project.id, req.params.noteId as string);
  if (!deleted) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.status(204).end();
});

notesRouter.post('/:id/notes/:noteId/restore', async (req, res) => {
  const project = await projectOr404(req, res);
  if (!project) return;
  const restored = await notesStore.restoreNote(project.id, req.params.noteId as string);
  if (restored === 'not_found') {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (restored === 'not_trashed') {
    sendError(res, 409, 'note_not_trashed', 'the note is not in the trash');
    return;
  }
  // Nothing new to work on: it comes back as it was, so nothing is
  // announced (announceNotesChanged), as for a delete.
  res.json(notesStore.toNoteDto(restored));
});

const markSchema = z.object({ noteIds: z.array(z.string()).min(1) });

const moveSchema = z.object({ noteIds: z.array(z.string()).min(1), toProjectId: z.string().min(1) });

notesRouter.post('/:id/notes/move', async (req, res) => {
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectStore.getProject(req.params.id as string);
  const target = await projectStore.getProject(parsed.data.toProjectId);
  if (!project || !target) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const moved = await notesStore.moveNotes(project.id, parsed.data.noteIds, target.id);
  if (moved.length > 0) announceNotesChanged(target.id);
  res.json({ notes: moved.map(notesStore.toNoteDto) });
});

// Where the notes were put: recorded as a use of each.
const markUsedSchema = markSchema.extend({
  sessionId: z.string().min(1).optional(),
  conversationId: z.string().min(1).nullable().optional(),
});

notesRouter.post('/:id/notes/mark-used', async (req, res) => {
  const parsed = markUsedSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectOr404(req, res);
  if (!project) return;
  const { sessionId, conversationId } = parsed.data;
  const origin = sessionId ? { sessionId, conversationId: conversationId ?? null } : undefined;
  res.json({ notes: (await notesStore.markNotesUsed(project.id, parsed.data.noteIds, origin)).map(notesStore.toNoteDto) });
});

notesRouter.post('/:id/notes/mark-unused', async (req, res) => {
  const parsed = markSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectOr404(req, res);
  if (!project) return;
  res.json({ notes: (await notesStore.markNotesUnused(project.id, parsed.data.noteIds)).map(notesStore.toNoteDto) });
});

notesRouter.post('/:id/notes/mark-done', async (req, res) => {
  const parsed = markSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectOr404(req, res);
  if (!project) return;
  res.json({ notes: (await notesStore.markNotesDone(project.id, parsed.data.noteIds)).map(notesStore.toNoteDto) });
});

notesRouter.post('/:id/notes/mark-undone', async (req, res) => {
  const parsed = markSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectOr404(req, res);
  if (!project) return;
  const undone = await notesStore.markNotesUndone(project.id, parsed.data.noteIds);
  if (undone.length > 0) announceNotesChanged(project.id);
  res.json({ notes: undone.map(notesStore.toNoteDto) });
});

// Not project-scoped — every tag ever used across all projects. Separate
// router so it can be mounted at /api/tags instead of /api/projects.
export const tagsRouter = Router();

tagsRouter.get('/', async (_req, res) => {
  res.json({ tags: await tagIndex.listAllTags() });
});
