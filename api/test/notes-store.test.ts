import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let stateDir: string;
let notesStore: typeof import('../src/notes-store.js');

beforeEach(async () => {
  vi.resetModules();
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-notes-store-test-'));
  process.env.HESTIA_STATE_DIR = stateDir;
  notesStore = await import('../src/notes-store.js');
});

afterEach(async () => {
  delete process.env.HESTIA_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('notes-store', () => {
  it('keeps stored notes when the first calls for a project arrive together', async () => {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const { NOTES_DIR } = await import('../src/config.js');
    const stored = {
      id: 'old', sessionId: null, text: 'kept', imagePath: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      used: false, usedAt: null, done: false, doneAt: null, uses: [],
    };
    await mkdir(NOTES_DIR, { recursive: true });
    await writeFile(path.join(NOTES_DIR, 'proj-1.json'), JSON.stringify([stored]));

    const [created, listed] = await Promise.all([
      notesStore.createNote('proj-1', { text: 'new', attachmentId: null, sessionId: null }),
      notesStore.listNotes('proj-1'),
    ]);

    // Upgraded on load: no image path, an (empty) attachment id instead.
    expect(listed).toContainEqual({ ...stored, imagePath: undefined, attachmentId: null });
    const onDisk = JSON.parse(await readFile(path.join(NOTES_DIR, 'proj-1.json'), 'utf-8')) as { id: string }[];
    expect(onDisk.map((note) => note.id)).toEqual(['old', created.id]);
  });

  it('creates a note and lists it back', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'buy milk #errand', attachmentId: null, sessionId: 'sess-1' });
    expect(note.sessionId).toBe('sess-1');
    expect(note.used).toBe(false);
    expect(note.usedAt).toBeNull();

    const notes = await notesStore.listNotes('proj-1');
    expect(notes).toEqual([note]);
  });

  it('keeps notes for different projects separate', async () => {
    await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-1' });
    await notesStore.createNote('proj-2', { text: 'b', attachmentId: null, sessionId: 'sess-2' });
    expect(await notesStore.listNotes('proj-1')).toHaveLength(1);
    expect(await notesStore.listNotes('proj-2')).toHaveLength(1);
  });

  it('stores an image as its attachment id, and sends it as an attachment (plus the path for cached PWAs)', async () => {
    const { UPLOADS_DIR } = await import('../src/config.js');
    const note = await notesStore.createNote('proj-1', { text: 'see attached', attachmentId: 'notes/abc.png', sessionId: 'sess-1' });
    expect(note.attachmentId).toBe('notes/abc.png');
    expect(note).not.toHaveProperty('imagePath');
    const dto = notesStore.toNoteDto(note);
    expect(dto.attachment).toEqual({
      id: 'notes/abc.png', kind: 'image', url: '/notes/uploads/abc.png', promptText: path.join(UPLOADS_DIR, 'notes/abc.png'),
    });
    expect(dto.imagePath).toBe(path.join(UPLOADS_DIR, 'notes/abc.png'));
    expect(dto).not.toHaveProperty('attachmentId');
  });

  it('reads a note stored with an image path as that upload\'s attachment', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { NOTES_DIR } = await import('../src/config.js');
    const base = { sessionId: null, text: '', createdAt: 't', updatedAt: 't', used: false, usedAt: null, done: false, doneAt: null, uses: [] };
    await mkdir(NOTES_DIR, { recursive: true });
    await writeFile(path.join(NOTES_DIR, 'proj-1.json'), JSON.stringify([
      { ...base, id: 'a', imagePath: '/old/state/uploads/sess-9/abc.jpg' },
      { ...base, id: 'b', imagePath: '/somewhere/odd' },
    ]));
    const [a, b] = await notesStore.listNotes('proj-1');
    expect(a).toMatchObject({ attachmentId: 'sess-9/abc.jpg' });
    expect(notesStore.toNoteDto(a!).attachment?.url).toBe('/sessions/sess-9/uploads/abc.jpg');
    // Not an upload: kept as it was, never dropped.
    expect(b).toMatchObject({ attachmentId: null, imagePath: '/somewhere/odd' });
    expect(notesStore.toNoteDto(b!)).toMatchObject({ attachment: null, imagePath: '/somewhere/odd' });
  });

  it('createNote keeps projectId (storage key) and sessionId (recorded origin) independent', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-9' });
    expect(note.sessionId).toBe('sess-9');
    const notes = await notesStore.listNotes('proj-1');
    expect(notes).toEqual([note]);
    // A different projectId's file must not have picked this note up.
    expect(await notesStore.listNotes('sess-9')).toEqual([]);
  });

  it('two different sessions creating notes in the same project both show up in one listNotes', async () => {
    await notesStore.createNote('proj-1', { text: 'from session a', attachmentId: null, sessionId: 'sess-a' });
    await notesStore.createNote('proj-1', { text: 'from session b', attachmentId: null, sessionId: 'sess-b' });
    const notes = await notesStore.listNotes('proj-1');
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('updateNoteText bumps updatedAt but leaves createdAt untouched', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'first draft', attachmentId: null, sessionId: 'sess-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await notesStore.updateNoteText('proj-1', note.id, 'revised draft');
    expect(updated?.text).toBe('revised draft');
    expect(updated?.createdAt).toBe(note.createdAt);
    expect(updated?.updatedAt).not.toBe(note.updatedAt);
  });

  it('updateNoteText returns undefined for an unknown note id', async () => {
    await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-1' });
    expect(await notesStore.updateNoteText('proj-1', 'nope', 'x')).toBeUndefined();
  });

  it('markNotesUsed sets used/usedAt but does NOT change updatedAt', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a note', attachmentId: null, sessionId: 'sess-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [used] = await notesStore.markNotesUsed('proj-1', [note.id]);
    expect(used?.used).toBe(true);
    expect(used?.usedAt).not.toBeNull();
    expect(used?.updatedAt).toBe(note.updatedAt); // marking used is not an edit
  });

  it('markNotesUnused clears used/usedAt but does NOT change updatedAt', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a note', attachmentId: null, sessionId: 'sess-1' });
    await notesStore.markNotesUsed('proj-1', [note.id]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeUnuse = (await notesStore.listNotes('proj-1'))[0] as { updatedAt: string };
    const [unused] = await notesStore.markNotesUnused('proj-1', [note.id]);
    expect(unused?.used).toBe(false);
    expect(unused?.usedAt).toBeNull();
    expect(unused?.updatedAt).toBe(beforeUnuse.updatedAt);
  });

  it('deleteNote puts the note in the trash: listNotes no longer includes it, listTrashedNotes does, with when', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'gone soon', attachmentId: null, sessionId: 'sess-1' });
    const other = await notesStore.createNote('proj-1', { text: 'stays', attachmentId: null, sessionId: 'sess-1' });
    const deleted = await notesStore.deleteNote('proj-1', note.id);
    expect(deleted).toBe(true);
    expect(await notesStore.listNotes('proj-1')).toEqual([other]);
    const trashed = await notesStore.listTrashedNotes('proj-1');
    expect(trashed.map((n) => n.id)).toEqual([note.id]);
    expect(trashed[0]?.deletedAt).toEqual(expect.any(String));
    // Deleting it again, or editing or marking it, finds nothing.
    expect(await notesStore.deleteNote('proj-1', note.id)).toBe(false);
    expect(await notesStore.updateNoteText('proj-1', note.id, 'x')).toBeUndefined();
    expect(await notesStore.markNotesDone('proj-1', [note.id])).toEqual([]);
  });

  it('restoreNote takes it out of the trash as it was; an unknown or live note says so', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'back #later', attachmentId: null, sessionId: 'sess-1' });
    await notesStore.deleteNote('proj-1', note.id);
    const restored = await notesStore.restoreNote('proj-1', note.id);
    expect(restored).toEqual(note);
    expect(await notesStore.listNotes('proj-1')).toEqual([note]);
    expect(await notesStore.listTrashedNotes('proj-1')).toEqual([]);
    expect(await notesStore.restoreNote('proj-1', note.id)).toBe('not_trashed');
    expect(await notesStore.restoreNote('proj-1', 'nope')).toBe('not_found');
  });

  it('deleteNote returns false for an unknown note id', async () => {
    await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-1' });
    expect(await notesStore.deleteNote('proj-1', 'nope')).toBe(false);
  });

  it('markNotesDone sets done/doneAt but does NOT change updatedAt', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a note', attachmentId: null, sessionId: 'sess-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [done] = await notesStore.markNotesDone('proj-1', [note.id]);
    expect(done?.done).toBe(true);
    expect(done?.doneAt).not.toBeNull();
    expect(done?.updatedAt).toBe(note.updatedAt);
  });

  it('markNotesUndone clears done/doneAt but does NOT change updatedAt', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a note', attachmentId: null, sessionId: 'sess-1' });
    await notesStore.markNotesDone('proj-1', [note.id]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeUndone = (await notesStore.listNotes('proj-1'))[0] as { updatedAt: string };
    const [undone] = await notesStore.markNotesUndone('proj-1', [note.id]);
    expect(undone?.done).toBe(false);
    expect(undone?.doneAt).toBeNull();
    expect(undone?.updatedAt).toBe(beforeUndone.updatedAt);
  });

  it('used and done are independent flags', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a note', attachmentId: null, sessionId: 'sess-1' });
    await notesStore.markNotesUsed('proj-1', [note.id]);
    const [afterDone] = await notesStore.markNotesDone('proj-1', [note.id]);
    expect(afterDone?.used).toBe(true);
    expect(afterDone?.done).toBe(true);
  });

  it('markNotesUsed silently skips ids not found in the project', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-1' });
    const touched = await notesStore.markNotesUsed('proj-1', [note.id, 'unknown-id']);
    expect(touched).toHaveLength(1);
    expect(touched[0]?.id).toBe(note.id);
  });

  describe('migrateLegacySessionNotes', () => {
    it('merges legacy session notes into the target project file and renames the legacy file to .migrated', async () => {
      await notesStore.createNote('sess-1', { text: 'legacy note', attachmentId: null, sessionId: 'sess-1' });

      const fs = await import('node:fs/promises');
      const legacyPath = path.join(stateDir, 'notes', 'sess-1.json');
      expect(await fs.readFile(legacyPath, 'utf-8')).toBeTruthy();

      await notesStore.migrateLegacySessionNotes('sess-1', 'proj-1');

      const projectNotes = await notesStore.listNotes('proj-1');
      expect(projectNotes).toHaveLength(1);
      expect(projectNotes[0]?.text).toBe('legacy note');

      await expect(fs.readFile(legacyPath, 'utf-8')).rejects.toThrow();
      expect(await fs.readFile(`${legacyPath}.migrated`, 'utf-8')).toBeTruthy();
    });

    it('is a no-op, not an error, when there is no legacy notes file', async () => {
      await expect(notesStore.migrateLegacySessionNotes('never-existed', 'proj-1')).resolves.toBeUndefined();
    });

    it('is idempotent: calling twice does not duplicate notes in the target project file', async () => {
      await notesStore.createNote('sess-1', { text: 'legacy note', attachmentId: null, sessionId: 'sess-1' });
      await notesStore.migrateLegacySessionNotes('sess-1', 'proj-1');
      // Second call: legacy file is already renamed to .migrated, so this is
      // effectively the ENOENT no-op path — but nothing should have changed.
      await notesStore.migrateLegacySessionNotes('sess-1', 'proj-1');
      expect(await notesStore.listNotes('proj-1')).toHaveLength(1);
    });

    it('merges multiple legacy sessions into the same project file', async () => {
      await notesStore.createNote('sess-1', { text: 'from sess-1', attachmentId: null, sessionId: 'sess-1' });
      await notesStore.createNote('sess-2', { text: 'from sess-2', attachmentId: null, sessionId: 'sess-2' });

      await notesStore.migrateLegacySessionNotes('sess-1', 'proj-1');
      await notesStore.migrateLegacySessionNotes('sess-2', 'proj-1');

      const projectNotes = await notesStore.listNotes('proj-1');
      expect(projectNotes.map((n) => n.text).sort()).toEqual(['from sess-1', 'from sess-2']);
    });
  });

  it('never starts a second persist() write for the same project before the first has finished', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-1' });

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

    const first = notesStore.updateNoteText('proj-1', note.id, 'edit one');
    await vi.waitFor(() => {
      if (!order.includes('first-start')) throw new Error('first write not reached yet');
    });
    const second = notesStore.updateNoteText('proj-1', note.id, 'edit two');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-start']);

    releaseFirstWrite();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);

    const raw = await fs.readFile(path.join(stateDir, 'notes', 'proj-1.json'), 'utf-8');
    const onDisk = JSON.parse(raw) as Array<{ text: string }>;
    expect(onDisk[0]?.text).toBe('edit two');
  });

  it('writes to different projects concurrently without one waiting on the other', async () => {
    await notesStore.createNote('proj-1', { text: 'a', attachmentId: null, sessionId: 'sess-1' });
    await notesStore.createNote('proj-2', { text: 'b', attachmentId: null, sessionId: 'sess-2' });

    const fs = await import('node:fs/promises');
    const writeSpy = vi.mocked(fs.writeFile);
    const actualWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    const order: string[] = [];
    let releaseProj1Write: () => void = () => {};
    const proj1Gate = new Promise<void>((resolve) => {
      releaseProj1Write = resolve;
    });
    writeSpy.mockImplementation(async (...args: Parameters<typeof actualWriteFile>) => {
      // Written to a temp file beside proj-1.json, then renamed over it.
      const isProj1 = path.basename(String(args[0])).startsWith('proj-1.json');
      if (isProj1) {
        order.push('proj1-start');
        await proj1Gate;
        order.push('proj1-end');
      } else {
        order.push('proj2-start');
      }
      return actualWriteFile(...args);
    });

    const notes1 = await notesStore.listNotes('proj-1');
    const notes2 = await notesStore.listNotes('proj-2');
    const p1 = notesStore.updateNoteText('proj-1', notes1[0]!.id, 'edit proj1');
    await vi.waitFor(() => {
      if (!order.includes('proj1-start')) throw new Error('not reached yet');
    });
    const p2 = notesStore.updateNoteText('proj-2', notes2[0]!.id, 'edit proj2');
    await vi.waitFor(() => {
      if (!order.includes('proj2-start')) throw new Error('proj2 write should not wait on proj1');
    });
    expect(order).toEqual(['proj1-start', 'proj2-start']); // proj2's write started while proj1's was still in flight

    releaseProj1Write();
    await Promise.all([p1, p2]);
  });

  it('keeps a note taken outside any session, with no session recorded', async () => {
    const note = await notesStore.createNote('inbox', { text: 'someday', attachmentId: null, sessionId: null });
    expect(note.sessionId).toBeNull();
    expect(await notesStore.listNotes('inbox')).toEqual([note]);
  });

  it('moves notes to another project unchanged, and keeps the tag index right on both sides', async () => {
    const keep = await notesStore.createNote('inbox', { text: 'stays #idea', attachmentId: null, sessionId: null });
    const move = await notesStore.createNote('inbox', { text: 'goes #deploy', attachmentId: null, sessionId: null });

    const moved = await notesStore.moveNotes('inbox', [move.id, 'missing'], 'proj-1');
    expect(moved).toEqual([move]);
    expect(await notesStore.listNotes('inbox')).toEqual([keep]);
    expect(await notesStore.listNotes('proj-1')).toEqual([move]);

    const { readFile } = await import('node:fs/promises');
    const { TAG_INDEX_PATH } = await import('../src/config.js');
    const tags = JSON.parse(await readFile(TAG_INDEX_PATH, 'utf-8')) as Record<string, { projectIds: string[] }>;
    expect(tags.deploy?.projectIds).toEqual(['proj-1']);
    expect(tags.idea?.projectIds).toEqual(['inbox']);
    expect(await notesStore.moveNotes('proj-1', [move.id], 'proj-1')).toEqual([]);
  });

  it('records each time a note goes into a chat, and an undone insert takes its record back', async () => {
    const note = await notesStore.createNote('proj-1', { text: 'x', attachmentId: null, sessionId: 'sess-1' });
    expect(note.uses).toEqual([]);

    await notesStore.markNotesUsed('proj-1', [note.id], { sessionId: 'sess-1', conversationId: 'conv-1' });
    const [twice] = await notesStore.markNotesUsed('proj-1', [note.id], { sessionId: 'sess-2', conversationId: null });
    expect(twice?.uses.map(({ sessionId, conversationId }) => [sessionId, conversationId])).toEqual([['sess-1', 'conv-1'], ['sess-2', null]]);
    expect(twice?.used).toBe(true);

    const [undone] = await notesStore.markNotesUnused('proj-1', [note.id]);
    expect(undone?.uses.map((use) => use.sessionId)).toEqual(['sess-1']);
    expect(undone?.used).toBe(false);
  });

  it('reads notes stored before uses existed as having none', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const config = await import('../src/config.js');
    await mkdir(config.NOTES_DIR, { recursive: true });
    await writeFile(path.join(config.NOTES_DIR, 'old.json'), JSON.stringify([{
      id: 'n', sessionId: 's', text: 't', imagePath: null, createdAt: '', updatedAt: '', used: true, usedAt: '', done: false, doneAt: null,
    }]));
    expect((await notesStore.listNotes('old'))[0]?.uses).toEqual([]);
  });
});
