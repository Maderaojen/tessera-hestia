import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModules, startModules } from '../../src/module-host/load.js';
import { MODULE_HOST_VERSION, type HestiaModule, type ModuleHost } from '../../src/module-host/types.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/modules/', import.meta.url));

const host: ModuleHost = {
  version: MODULE_HOST_VERSION,
  stateDir: '/state',
  locale: () => 'zh-TW',
  projects: { exists: async () => true },
  notes: { list: async () => [], onChanged: () => () => {} },
  processors: { cli: async () => ({ unavailable: 'no_profile' }) },
  http: { sendError: () => {} },
};

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'hestia-modules-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

async function writeModule(name: string, source: string): Promise<void> {
  await mkdir(path.join(scratch, name), { recursive: true });
  await writeFile(path.join(scratch, name, 'index.js'), source);
}

describe('loadModules', () => {
  it('finds none when the folder is missing, and says so', async () => {
    expect(await loadModules(host, path.join(scratch, 'missing'))).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(`[modules] none (${path.join(scratch, 'missing')})`);
  });

  it('loads a module from source, handing it the host', async () => {
    const modules = await loadModules(host, FIXTURES);
    expect(modules.map((module) => module.id)).toEqual(['example']);
    expect(modules[0]!.capabilities).toEqual(['example_feature']);
    expect(modules[0]!.routes.map((route) => route.path)).toEqual(['/example']);
    expect(console.log).toHaveBeenCalledWith('[modules] loaded: example');
  });

  it('skips a folder with no index', async () => {
    await mkdir(path.join(scratch, 'empty'));
    expect(await loadModules(host, scratch)).toEqual([]);
  });

  it('leaves out a module whose factory throws, logs it, and loads the rest', async () => {
    await writeModule('a-broken', "export default () => { throw new Error('boom'); };");
    await writeModule('b-fine', "export default () => ({ id: 'fine', capabilities: [], routes: [] });");
    const modules = await loadModules(host, scratch);
    expect(modules.map((module) => module.id)).toEqual(['fine']);
    expect(console.error).toHaveBeenCalledWith(`[modules] not loaded: ${path.join(scratch, 'a-broken')}`, expect.objectContaining({ message: 'boom' }));
  });

  it('leaves out a module whose default export is not a factory, or whose shape is wrong', async () => {
    await writeModule('a', 'export default 42;');
    await writeModule('b', "export default () => ({ id: 'b', capabilities: [1], routes: [] });");
    await writeModule('c', 'export default async () => null;');
    expect(await loadModules(host, scratch)).toEqual([]);
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it('keeps the first of two modules with the same id', async () => {
    await writeModule('a', "export default () => ({ id: 'same', capabilities: ['first'], routes: [] });");
    await writeModule('b', "export default () => ({ id: 'same', capabilities: ['second'], routes: [] });");
    const modules = await loadModules(host, scratch);
    expect(modules.map((module) => module.capabilities)).toEqual([['first']]);
    expect(console.error).toHaveBeenCalledWith(`[modules] not loaded: ${path.join(scratch, 'b')}`, expect.objectContaining({ message: 'another module already has the id "same"' }));
  });
});

describe('startModules', () => {
  it('starts each module, one failing not stopping the next', () => {
    const started: string[] = [];
    const modules: HestiaModule[] = [
      { id: 'a', capabilities: [], routes: [], start: () => { throw new Error('no'); } },
      { id: 'b', capabilities: [], routes: [] },
      { id: 'c', capabilities: [], routes: [], start: () => { started.push('c'); } },
    ];
    startModules(modules);
    expect(started).toEqual(['c']);
    expect(console.error).toHaveBeenCalledWith('[modules] a failed to start', expect.any(Error));
  });
});
