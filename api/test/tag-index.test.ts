import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let stateDir: string;
let tagIndex: typeof import('../src/tag-index.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-tag-index-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  tagIndex = await import('../src/tag-index.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const alwaysFalse = () => false;
const alwaysTrue = () => true;

describe('tag-index', () => {
  it('keeps stored tags when the first calls after start arrive together', async () => {
    const { TAG_INDEX_PATH } = await import('../src/config.js');
    await mkdir(path.dirname(TAG_INDEX_PATH), { recursive: true });
    await writeFile(TAG_INDEX_PATH, JSON.stringify({ old: { displayText: 'old', projectIds: ['p1'] } }));

    const [, listed] = await Promise.all([
      tagIndex.syncNoteTags('p2', '', 'note #new', alwaysFalse),
      tagIndex.listAllTags(),
    ]);

    expect(listed).toContainEqual({ tag: 'old', count: 1 });
    expect((await tagIndex.listAllTags()).sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([{ tag: 'new', count: 1 }, { tag: 'old', count: 1 }]);
  });

  it('adds a tag with the session when a new tag appears', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note text #login', alwaysFalse);
    expect(await tagIndex.listAllTags()).toEqual([{ tag: 'login', count: 1 }]);
  });

  it('drops the session from a tag when its last note using it is edited away, and the callback says no other note uses it', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note #login', alwaysFalse);
    await tagIndex.syncNoteTags('sess-1', 'note #login', 'note, no tag anymore', alwaysFalse);
    expect(await tagIndex.listAllTags()).toEqual([]);
  });

  it('keeps the session on a tag when another note in the same session still uses it', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'first note #login', alwaysFalse);
    // Editing away the tag from THIS note, but the callback (standing in for
    // notes-store's own in-memory scan of the session's other notes) says
    // another note in the same session still has #login.
    await tagIndex.syncNoteTags('sess-1', 'first note #login', 'first note, edited', alwaysTrue);
    expect(await tagIndex.listAllTags()).toEqual([{ tag: 'login', count: 1 }]);
  });

  it('dedups projectIds when the same project adds the same tag twice (two notes)', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note one #login', alwaysFalse);
    await tagIndex.syncNoteTags('sess-1', '', 'note two #login', alwaysFalse);
    expect(await tagIndex.listAllTags()).toEqual([{ tag: 'login', count: 1 }]);
  });

  it('counts distinct sessions using a tag', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note #shared', alwaysFalse);
    await tagIndex.syncNoteTags('sess-2', '', 'note #shared', alwaysFalse);
    expect(await tagIndex.listAllTags()).toEqual([{ tag: 'shared', count: 2 }]);
  });

  it('updates displayText to the newest literal casing typed on each fresh add', async () => {
    // First add: casing "UI".
    await tagIndex.syncNoteTags('sess-1', '', 'note #UI', alwaysFalse);
    expect((await tagIndex.listAllTags())[0]?.tag).toBe('UI');
    // Tag removed entirely (no other note in the session uses it)...
    await tagIndex.syncNoteTags('sess-1', 'note #UI', 'note, no tag', alwaysFalse);
    expect(await tagIndex.listAllTags()).toEqual([]);
    // ...then freshly re-added with different casing: "ui" should now win.
    await tagIndex.syncNoteTags('sess-1', 'note, no tag', 'note #ui again', alwaysFalse);
    const tags = await tagIndex.listAllTags();
    expect(tags).toEqual([{ tag: 'ui', count: 1 }]);
  });

  it('removeProjectFromAllTags fully retracts a project from every tag it touched', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note #a #b', alwaysFalse);
    await tagIndex.syncNoteTags('sess-2', '', 'note #a', alwaysFalse);
    await tagIndex.removeProjectFromAllTags('sess-1');
    const tags = await tagIndex.listAllTags();
    expect(tags.sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([{ tag: 'a', count: 1 }]);
  });

  it('loads a pre-existing tag-index.json still using the old sessionIds field name without crashing', async () => {
    // Regression test: this is the exact shape production data had before
    // the sessionIds -> projectIds rename, and remapSessionToProject used
    // to throw "Cannot read properties of undefined (reading 'includes')"
    // the first time it touched such an entry, because `projectIds` was
    // genuinely absent on disk, not an empty array.
    const notesDir = path.join(stateDir, 'notes');
    await mkdir(notesDir, { recursive: true });
    await writeFile(
      path.join(notesDir, 'tag-index.json'),
      JSON.stringify({ ui: { displayText: 'ui', sessionIds: ['legacy-sess-1'] } }),
      'utf-8',
    );
    await expect(tagIndex.remapSessionToProject('legacy-sess-1', 'proj-1')).resolves.toBeUndefined();
    expect(await tagIndex.listAllTags()).toEqual([{ tag: 'ui', count: 1 }]);
  });

  it('remapSessionToProject replaces a legacy sessionId with the projectId it migrated to', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note #a', alwaysFalse);
    await tagIndex.remapSessionToProject('sess-1', 'proj-1');
    const raw = await (await import('node:fs/promises')).readFile(path.join(stateDir, 'notes', 'tag-index.json'), 'utf-8');
    const onDisk = JSON.parse(raw) as Record<string, { projectIds: string[] }>;
    expect(onDisk['a']?.projectIds).toEqual(['proj-1']);
  });

  it('remapSessionToProject de-dupes when the project already used the same tag via another session', async () => {
    await tagIndex.syncNoteTags('sess-1', '', 'note #a', alwaysFalse);
    await tagIndex.syncNoteTags('proj-1', '', 'note #a', alwaysFalse); // pretend proj-1 already has this tag
    await tagIndex.remapSessionToProject('sess-1', 'proj-1');
    const tags = await tagIndex.listAllTags();
    expect(tags).toEqual([{ tag: 'a', count: 1 }]);
  });

  it('never starts a second persist() write before the first one has finished', async () => {
    const fs = await import('node:fs/promises');
    const writeSpy = vi.mocked(fs.writeFile);
    const actualWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    const order: string[] = [];
    let releaseFirstWrite: () => void = () => {};
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    writeSpy.mockImplementationOnce(async (...args: Parameters<typeof actualWriteFile>) => {
      order.push('first-start');
      await firstWriteGate;
      order.push('first-end');
      return actualWriteFile(...args);
    });
    writeSpy.mockImplementationOnce(async (...args: Parameters<typeof actualWriteFile>) => {
      order.push('second-start');
      return actualWriteFile(...args);
    });

    const first = tagIndex.syncNoteTags('sess-1', '', 'note #a', alwaysFalse);
    await vi.waitFor(() => {
      if (!order.includes('first-start')) throw new Error('first write not reached yet');
    });
    const second = tagIndex.syncNoteTags('sess-2', '', 'note #b', alwaysFalse);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-start']);

    releaseFirstWrite();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);

    const raw = await fs.readFile(path.join(stateDir, 'notes', 'tag-index.json'), 'utf-8');
    const onDisk = JSON.parse(raw) as Record<string, { projectIds: string[] }>;
    expect(onDisk['a']?.projectIds).toEqual(['sess-1']);
    expect(onDisk['b']?.projectIds).toEqual(['sess-2']);
  });
});
