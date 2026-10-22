import { randomUUID } from 'node:crypto';
import { PROJECTS_PATH } from './config.js';
import { INBOX_PROJECT_ID } from './contract/projects.js';
import { jsonFileStore } from '@maderaojen/json-file-store';

// Where a project's tmux sessions have been opened. A project is not a
// path — it can have none (only notes so far) or several — but the primary
// one is where a new tmux in the project starts by default.
export type ProjectPath = {
  path: string;
  primary: boolean; // at most one per project
  addedAt: string; // ISO
};

export type Project = {
  id: string; // uuid (randomUUID())
  name: string; // 使用者可見名稱，儲存時已 trim；不強制唯一（見下方「名稱不是唯一鍵」）
  createdAt: string; // ISO
  deletedAt: string | null; // 軟刪除時間戳，null = 存活
  paths: ProjectPath[];
  nextSessionNumber?: number;
};

// The inbox: notes that don't belong to any project yet. Not stored with the
// others — it always exists, has no tmux or paths, and can't be renamed or
// deleted — but it answers to getProject() like any project, so every notes
// route works on it unchanged. Its name is never sent (it isn't in
// GET /projects): the app names it in the person's language by its id.
export { INBOX_PROJECT_ID };
const INBOX: Project = {
  id: INBOX_PROJECT_ID,
  name: INBOX_PROJECT_ID,
  createdAt: new Date(0).toISOString(),
  deletedAt: null,
  paths: [],
  nextSessionNumber: 1,
};

// Same pattern as registry.ts: a single Map, loaded once, written through
// one serialized queue.
let projects = new Map<string, Project>();
// Projects stored before paths existed; filled once from their sessions
// (backfillPathsFromSessions) the first time registry.ts loads.
let needsPathBackfill = new Set<string>();
let needsSessionNumberBackfill = new Set<string>();

const file = jsonFileStore<Map<string, Project>>({
  path: PROJECTS_PATH,
  empty: () => new Map(),
  decode: (raw) => {
    const parsed = raw as Array<Omit<Project, 'paths'> & { paths?: ProjectPath[] }>;
    needsPathBackfill = new Set(parsed.filter((p) => p.paths === undefined).map((p) => p.id));
    needsSessionNumberBackfill = new Set(parsed.filter((p) => p.nextSessionNumber === undefined).map((p) => p.id));
    return new Map(parsed.map((p) => [p.id, { ...p, paths: p.paths ?? [], nextSessionNumber: p.nextSessionNumber ?? 1 }]));
  },
  encode: (map) => [...map.values()],
});

async function ensureLoaded(): Promise<void> {
  projects = await file.load();
}

async function persist(): Promise<void> {
  await file.save(projects);
}

export async function createProject(name: string): Promise<Project> {
  await ensureLoaded();
  const project: Project = {
    id: randomUUID(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
    paths: [],
    nextSessionNumber: 1,
  };
  projects.set(project.id, project);
  await persist();
  return project;
}

/** Reserves a stable project-local display number, cycling from 100 to 1. */
export async function reserveSessionNumber(id: string): Promise<number | undefined> {
  await ensureLoaded();
  const current = projects.get(id);
  if (!current || current.deletedAt !== null) return undefined;
  const next = current.nextSessionNumber ?? 1;
  const number = next >= 1 && next <= 100 ? next : 1;
  projects.set(id, { ...current, nextSessionNumber: number === 100 ? 1 : number + 1 });
  await persist();
  return number;
}

/** Seeds counters for projects upgraded from records without session numbers. */
export async function seedSessionNumbers(counts: Map<string, number>): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const id of needsSessionNumberBackfill) {
    const current = projects.get(id);
    if (!current) continue;
    const count = counts.get(id) ?? 0;
    projects.set(id, { ...current, nextSessionNumber: (count % 100) + 1 });
    changed = true;
  }
  needsSessionNumberBackfill = new Set();
  if (changed) await persist();
}

// 找不到「或」已軟刪除都回傳 undefined —— 呼叫端不需要再自己檢查 deletedAt
export async function getProject(id: string): Promise<Project | undefined> {
  if (id === INBOX_PROJECT_ID) return INBOX;
  await ensureLoaded();
  const project = projects.get(id);
  if (!project || project.deletedAt !== null) return undefined;
  return project;
}

// 只回傳 deletedAt === null 的專案（不含收件匣）
export async function listProjects(): Promise<Project[]> {
  await ensureLoaded();
  return [...projects.values()].filter((p) => p.deletedAt === null);
}

// trim + 大小寫不敏感比對，只在「存活」專案裡找
export async function findActiveProjectByName(name: string): Promise<Project | undefined> {
  await ensureLoaded();
  const normalized = name.trim().toLowerCase();
  return [...projects.values()].find((p) => p.deletedAt === null && p.name.trim().toLowerCase() === normalized);
}

// 找到就回傳既有的，找不到就 createProject(trimmedName) 後回傳
export async function resolveOrCreateProjectByName(name: string): Promise<Project> {
  const existing = await findActiveProjectByName(name);
  if (existing) return existing;
  return createProject(name.trim());
}

// 找不到/已刪除回傳 undefined；只改 name，不動 createdAt/deletedAt
export async function renameProject(id: string, name: string): Promise<Project | undefined> {
  await ensureLoaded();
  const current = projects.get(id);
  if (!current || current.deletedAt !== null) return undefined;
  const updated: Project = { ...current, name: name.trim() };
  projects.set(id, updated);
  await persist();
  return updated;
}

// 只設定 deletedAt = new Date().toISOString()；找不到或已經是刪除狀態回傳 undefined
export async function softDeleteProject(id: string): Promise<Project | undefined> {
  await ensureLoaded();
  const current = projects.get(id);
  if (!current || current.deletedAt !== null) return undefined;
  const updated: Project = { ...current, deletedAt: new Date().toISOString() };
  projects.set(id, updated);
  await persist();
  return updated;
}

// The paths below all go through here: a live, non-inbox project, updated
// and persisted, or undefined when there is no such project.
async function updatePaths(id: string, change: (paths: ProjectPath[]) => ProjectPath[]): Promise<Project | undefined> {
  await ensureLoaded();
  const current = projects.get(id);
  if (!current || current.deletedAt !== null) return undefined;
  const updated: Project = { ...current, paths: change(current.paths) };
  projects.set(id, updated);
  await persist();
  return updated;
}

// Adds a path; the project's first path becomes primary. Adding one already
// listed changes nothing.
export async function addProjectPath(id: string, projectPath: string): Promise<Project | undefined> {
  const project = await getProject(id);
  if (project && project.paths.some((entry) => entry.path === projectPath)) return project;
  return updatePaths(id, (paths) => [
    ...paths,
    { path: projectPath, primary: !paths.some((entry) => entry.primary), addedAt: new Date().toISOString() },
  ]);
}

// Removing the primary path hands that role to the earliest one left. The
// tmux sessions already on it stay where they are.
export async function removeProjectPath(id: string, projectPath: string): Promise<Project | undefined> {
  return updatePaths(id, (paths) => {
    const rest = paths.filter((entry) => entry.path !== projectPath);
    if (rest.length === 0 || rest.some((entry) => entry.primary)) return rest;
    const earliest = rest.reduce((a, b) => (b.addedAt < a.addedAt ? b : a));
    return rest.map((entry) => ({ ...entry, primary: entry === earliest }));
  });
}

// undefined also when the path isn't one of the project's.
export async function setPrimaryProjectPath(id: string, projectPath: string): Promise<Project | undefined> {
  const project = await getProject(id);
  if (!project || !project.paths.some((entry) => entry.path === projectPath)) return undefined;
  return updatePaths(id, (paths) => paths.map((entry) => ({ ...entry, primary: entry.path === projectPath })));
}

// One-time fill for projects stored before paths existed, from the tmux
// sessions already in them (in the order they were opened, the first one
// primary). Takes plain records so this module still knows nothing about
// sessions.
export async function backfillPathsFromSessions(sessions: { projectId: string; cwd: string; createdAt: string }[]): Promise<void> {
  await ensureLoaded();
  if (needsPathBackfill.size === 0) return;
  const pending = needsPathBackfill;
  needsPathBackfill = new Set();
  const opened = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const id of pending) {
    const current = projects.get(id);
    if (!current) continue;
    const paths: ProjectPath[] = [];
    for (const session of opened) {
      if (session.projectId !== id || paths.some((entry) => entry.path === session.cwd)) continue;
      paths.push({ path: session.cwd, primary: paths.length === 0, addedAt: session.createdAt });
    }
    projects.set(id, { ...current, paths });
  }
  await persist();
}

export function __resetForTests(): void {
  projects = new Map();
  needsPathBackfill = new Set();
  needsSessionNumberBackfill = new Set();
  file.reset();
}
