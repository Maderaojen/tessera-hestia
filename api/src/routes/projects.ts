import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import * as projectStore from '../project-store.js';
import * as registry from '../registry.js';
import { sendError } from './errors.js';
import type { ProjectDto } from '../contract/projects.js';

export const projectsRouter = Router();

function toProjectDto(project: projectStore.Project): ProjectDto {
  return { id: project.id, name: project.name, createdAt: project.createdAt, deletedAt: project.deletedAt, paths: project.paths };
}

projectsRouter.get('/', async (_req, res) => {
  res.json({ projects: (await projectStore.listProjects()).map(toProjectDto) });
});

const createSchema = z.object({ name: z.string().trim().min(1) });

projectsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const project = await projectStore.createProject(parsed.data.name);
  res.status(201).json(toProjectDto(project));
});

const renameSchema = z.object({ name: z.string().trim().min(1) });

projectsRouter.patch('/:id', async (req, res) => {
  if (req.params.id === projectStore.INBOX_PROJECT_ID) {
    sendError(res, 409, 'inbox_rename_forbidden', 'the inbox can\'t be renamed');
    return;
  }
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const updated = await projectStore.renameProject(req.params.id as string, parsed.data.name);
  if (!updated) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.json(toProjectDto(updated));
});

projectsRouter.delete('/:id', async (req, res) => {
  const id = req.params.id as string;
  if (id === projectStore.INBOX_PROJECT_ID) {
    sendError(res, 409, 'inbox_delete_forbidden', 'the inbox can\'t be deleted');
    return;
  }
  const project = await projectStore.getProject(id);
  if (!project) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  // Judged via registry.listSessions() + filter, not a count project-store
  // maintains itself — project-store doesn't know sessions exist at all,
  // keeping the module boundary clean.
  const sessions = await registry.listSessions();
  const stillHasSessions = sessions.some((s) => s.projectId === id); // dead sessions count too
  if (stillHasSessions) {
    sendError(res, 409, 'project_has_sessions', 'project still has sessions');
    return;
  }
  await projectStore.softDeleteProject(id);
  res.status(204).end();
});

const pathSchema = z.object({ path: z.string().min(1) });

// Adds a directory by hand (they're also learnt from the tmux opened in the
// project). It has to exist on this host.
projectsRouter.post('/:id/paths', async (req, res) => {
  const parsed = pathSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  if (req.params.id === projectStore.INBOX_PROJECT_ID) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const directory = path.resolve(parsed.data.path);
  const isDirectory = await stat(directory).then((info) => info.isDirectory(), () => false);
  if (!isDirectory) {
    sendError(res, 400, 'folder_not_found', 'no such folder');
    return;
  }
  const updated = await projectStore.addProjectPath(req.params.id as string, directory);
  if (!updated) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.json(updated);
});

// The primary path is where a new tmux in the project starts by default.
projectsRouter.post('/:id/paths/primary', async (req, res) => {
  const parsed = pathSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const updated = await projectStore.setPrimaryProjectPath(req.params.id as string, parsed.data.path);
  if (!updated) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.json(updated);
});

// Forgets a path; tmux sessions already opened there are left alone.
projectsRouter.post('/:id/paths/remove', async (req, res) => {
  const parsed = pathSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const updated = await projectStore.removeProjectPath(req.params.id as string, parsed.data.path);
  if (!updated) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  res.json(updated);
});
