import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stateDir: string;
let projectStore: typeof import('../src/project-store.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-project-store-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  projectStore = await import('../src/project-store.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('project-store', () => {
  it('keeps stored projects when the first calls after start arrive together', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { PROJECTS_PATH } = await import('../src/config.js');
    const stored = { id: 'old', name: 'old', createdAt: '2026-01-01T00:00:00Z', deletedAt: null, paths: [] };
    await writeFile(PROJECTS_PATH, JSON.stringify([stored]));

    // Neither caller may see an empty store and write it back.
    const [created, listed] = await Promise.all([projectStore.createProject('new'), projectStore.listProjects()]);

    // Stored before session numbers: loaded with the counter at its start
    // (the registry's first load seeds it from the project's sessions).
    expect(listed).toContainEqual({ ...stored, nextSessionNumber: 1 });
    const onDisk = JSON.parse(await (await import('node:fs/promises')).readFile(PROJECTS_PATH, 'utf-8')) as { id: string }[];
    expect(onDisk.map((p) => p.id)).toEqual(['old', created.id]);
  });

  it('creates a project and lists it back', async () => {
    const project = await projectStore.createProject('  My Project  ');
    expect(project.name).toBe('My Project'); // trimmed
    expect(project.deletedAt).toBeNull();

    expect(await projectStore.getProject(project.id)).toEqual(project);
    expect(await projectStore.listProjects()).toEqual([project]);
  });

  it('renameProject updates only name', async () => {
    const project = await projectStore.createProject('old name');
    const renamed = await projectStore.renameProject(project.id, 'new name');
    expect(renamed?.name).toBe('new name');
    expect(renamed?.createdAt).toBe(project.createdAt);
    expect(renamed?.deletedAt).toBe(project.deletedAt);
  });

  it('renameProject returns undefined for an unknown id', async () => {
    expect(await projectStore.renameProject('nope', 'x')).toBeUndefined();
  });

  it('softDeleteProject sets deletedAt and hides the project from getProject/listProjects', async () => {
    const project = await projectStore.createProject('to delete');
    const deleted = await projectStore.softDeleteProject(project.id);
    expect(deleted?.deletedAt).not.toBeNull();

    expect(await projectStore.getProject(project.id)).toBeUndefined();
    expect(await projectStore.listProjects()).toEqual([]);
  });

  it('softDeleteProject returns undefined for an unknown id', async () => {
    expect(await projectStore.softDeleteProject('nope')).toBeUndefined();
  });

  it('softDeleteProject returns undefined when the project is already deleted', async () => {
    const project = await projectStore.createProject('to delete');
    await projectStore.softDeleteProject(project.id);
    expect(await projectStore.softDeleteProject(project.id)).toBeUndefined();
  });

  it('findActiveProjectByName is case-insensitive and trims whitespace', async () => {
    const project = await projectStore.createProject('My Project');
    expect(await projectStore.findActiveProjectByName('my project')).toEqual(project);
    expect(await projectStore.findActiveProjectByName('  MY PROJECT  ')).toEqual(project);
    expect(await projectStore.findActiveProjectByName('other')).toBeUndefined();
  });

  it('resolveOrCreateProjectByName joins an existing active project by normalized name', async () => {
    const project = await projectStore.createProject('My Project');
    const resolved = await projectStore.resolveOrCreateProjectByName('  my project  ');
    expect(resolved.id).toBe(project.id);
    expect(await projectStore.listProjects()).toHaveLength(1);
  });

  it('resolveOrCreateProjectByName creates a new project when none matches', async () => {
    const resolved = await projectStore.resolveOrCreateProjectByName('Brand New');
    expect(resolved.name).toBe('Brand New');
    expect(await projectStore.listProjects()).toEqual([resolved]);
  });

  it('resolveOrCreateProjectByName does not resurrect a soft-deleted project with the same name', async () => {
    const original = await projectStore.createProject('My Project');
    await projectStore.softDeleteProject(original.id);
    const resolved = await projectStore.resolveOrCreateProjectByName('My Project');
    expect(resolved.id).not.toBe(original.id);
    expect(resolved.deletedAt).toBeNull();
  });

  it('the inbox always exists, answers to getProject, and is not listed with the others', async () => {
    const inbox = await projectStore.getProject(projectStore.INBOX_PROJECT_ID);
    expect(inbox).toMatchObject({ id: 'inbox', deletedAt: null, paths: [] });
    expect(await projectStore.listProjects()).toEqual([]);
  });

  it('a new project has no paths; its first path becomes primary, and adding one twice changes nothing', async () => {
    const project = await projectStore.createProject('p');
    expect(project.paths).toEqual([]);

    await projectStore.addProjectPath(project.id, '/work/a');
    await projectStore.addProjectPath(project.id, '/work/b');
    const updated = await projectStore.addProjectPath(project.id, '/work/a');
    expect(updated?.paths.map(({ path: p, primary }) => [p, primary])).toEqual([['/work/a', true], ['/work/b', false]]);
  });

  it('sets the primary path, and removing it hands the role to the earliest one left', async () => {
    const project = await projectStore.createProject('p');
    await projectStore.addProjectPath(project.id, '/work/a');
    await projectStore.addProjectPath(project.id, '/work/b');
    await projectStore.addProjectPath(project.id, '/work/c');

    const moved = await projectStore.setPrimaryProjectPath(project.id, '/work/c');
    expect(moved?.paths.filter((entry) => entry.primary).map((entry) => entry.path)).toEqual(['/work/c']);
    expect(await projectStore.setPrimaryProjectPath(project.id, '/elsewhere')).toBeUndefined();

    const removed = await projectStore.removeProjectPath(project.id, '/work/c');
    expect(removed?.paths.map(({ path: p, primary }) => [p, primary])).toEqual([['/work/a', true], ['/work/b', false]]);
  });

  it('fills paths once, from the sessions, for projects stored before paths existed', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { PROJECTS_PATH } = await import('../src/config.js');
    await writeFile(PROJECTS_PATH, JSON.stringify([
      { id: 'old', name: 'old', createdAt: '2026-01-01T00:00:00Z', deletedAt: null },
      { id: 'new', name: 'new', createdAt: '2026-01-01T00:00:00Z', deletedAt: null, paths: [] },
    ]));
    const sessions = [
      { projectId: 'old', cwd: '/work/b', createdAt: '2026-02-02T00:00:00Z' },
      { projectId: 'old', cwd: '/work/a', createdAt: '2026-02-01T00:00:00Z' },
      { projectId: 'old', cwd: '/work/a', createdAt: '2026-02-03T00:00:00Z' },
      { projectId: 'new', cwd: '/work/x', createdAt: '2026-02-01T00:00:00Z' },
    ];

    await projectStore.backfillPathsFromSessions(sessions);
    expect((await projectStore.getProject('old'))?.paths).toEqual([
      { path: '/work/a', primary: true, addedAt: '2026-02-01T00:00:00Z' },
      { path: '/work/b', primary: false, addedAt: '2026-02-02T00:00:00Z' },
    ]);
    // Already had paths (even none): left alone.
    expect((await projectStore.getProject('new'))?.paths).toEqual([]);

    await projectStore.removeProjectPath('old', '/work/b');
    await projectStore.backfillPathsFromSessions(sessions);
    expect((await projectStore.getProject('old'))?.paths.map((entry) => entry.path)).toEqual(['/work/a']);
  });
});
