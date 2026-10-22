import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HestiaModule, ModuleHost } from './types.js';

// Finds the optional modules (types.ts) at startup. Each folder under
// api/modules/ is one: its index.js when built (dist/modules/<name>/), its
// index.ts when run from source (tsx, vitest). No folder, no modules — a
// build without them is a whole Hestia. A module that fails to load is
// logged and left out; Hestia starts either way.

/** api/modules from source (src/module-host), api/dist/modules once built (dist/src/module-host). */
export const MODULES_DIR = fileURLToPath(new URL('../../modules/', import.meta.url));

function entryOf(folder: string): string | null {
  for (const name of ['index.js', 'index.ts']) {
    const file = path.join(folder, name);
    if (existsSync(file)) return file;
  }
  return null;
}

function checkModule(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'the factory returned no module';
  const candidate = value as Partial<HestiaModule>;
  if (typeof candidate.id !== 'string' || !candidate.id) return 'the module has no id';
  if (!Array.isArray(candidate.capabilities) || !candidate.capabilities.every((c) => typeof c === 'string')) return 'capabilities is not a list of strings';
  if (!Array.isArray(candidate.routes)) return 'routes is not a list';
  return null;
}

export async function loadModules(host: ModuleHost, dir: string = MODULES_DIR): Promise<HestiaModule[]> {
  let folders: string[];
  try {
    folders = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    folders = [];
  }
  const loaded: HestiaModule[] = [];
  for (const name of folders) {
    const folder = path.join(dir, name);
    const entry = entryOf(folder);
    if (!entry) continue;
    try {
      const imported = (await import(pathToFileURL(entry).href)) as { default?: unknown };
      if (typeof imported.default !== 'function') throw new Error('its default export is not a function');
      const made: unknown = await (imported.default as (host: ModuleHost) => unknown)(host);
      const problem = checkModule(made);
      if (problem) throw new Error(problem);
      const module = made as HestiaModule;
      if (loaded.some((other) => other.id === module.id)) throw new Error(`another module already has the id "${module.id}"`);
      loaded.push(module);
    } catch (err) {
      console.error(`[modules] not loaded: ${folder}`, err);
    }
  }
  if (loaded.length) console.log(`[modules] loaded: ${loaded.map((module) => module.id).join(', ')}`);
  else console.log(`[modules] none (${dir})`);
  return loaded;
}

/** Starts each module's background work; one failing doesn't stop the others. */
export function startModules(modules: readonly HestiaModule[]): void {
  for (const module of modules) {
    try {
      module.start?.();
    } catch (err) {
      console.error(`[modules] ${module.id} failed to start`, err);
    }
  }
}
