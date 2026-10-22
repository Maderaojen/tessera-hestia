import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { jsonFileStore, type JsonFileStore } from '@maderaojen/json-file-store';
import { extractTags, normalizeTag } from '../contract/tags.js';
import type { TagIndexStore } from './tag-index.js';

// One time a note was put into a chat: which tmux, which conversation in it
// (null when that isn't known), when.
export type NoteUse = { sessionId: string; conversationId: string | null; at: string };

export type NoteRecord = {
  id: string;
  sessionId: string | null; // 純粹記錄這則便箋是從哪個 session 打的字，不影響儲存位置/查詢鍵；不在任何 session 裡記的（例如 Home 的收件匣）是 null
  text: string; // raw text, #tag tokens embedded as typed
  // The attached image's attachment id (attachments.ts), never a path.
  attachmentId: string | null;
  // Only on a note stored with an image path that doesn't name an upload
  // (none should exist): kept as it was rather than dropped.
  imagePath?: string | null;
  createdAt: string;
  updatedAt: string;
  used: boolean;
  usedAt: string | null;
  // Separate from `used`: `used` is system-driven (the insert flow sets it
  // the moment a note actually lands in the composer), `done` is a
  // user-driven judgment call ("I've reviewed this and it's handled") —
  // two different stages of the same note's life, not one recoded as two
  // booleans.
  done: boolean;
  doneAt: string | null;
  // Every time it was put into a chat, oldest first. `used` says whether it
  // has been at all; this says where and when, since having been sent isn't
  // the same as being done.
  uses: NoteUse[];
  // In the trash since then (deleteNote): kept, restorable (restoreNote),
  // and to everything else as if it weren't there. Absent on a live note.
  deletedAt?: string;
};

const isLive = (note: NoteRecord) => !note.deletedAt;

// A note as any build wrote it: before uses were recorded (none), or with
// its image as a path on this machine rather than an attachment id.
type StoredNote = Omit<NoteRecord, 'uses' | 'attachmentId'> & { uses?: NoteUse[]; attachmentId?: string | null; imagePath?: string | null };

export type NotesStoreOptions = {
  // Where each project's notes file lives: <dir>/<projectId>.json.
  dir: string;
  tags: Pick<TagIndexStore, 'syncNoteTags' | 'remapSessionToProject'>;
  // An old note's image path, as the attachment it names (null when it
  // names none). The host owns attachments.
  attachmentForPath: (imagePath: string) => { id: string } | null;
};

export type NotesStore = ReturnType<typeof createNotesStore>;

export function createNotesStore(options: NotesStoreOptions) {
  // Unlike registry.ts (one global file), there's no single file to eagerly
  // load here — projects are loaded lazily, one file each, on first touch.
  // Each file has its own store, so writes to different projects' files don't
  // wait on each other while writes to the same file stay in order.
  const files = new Map<string, JsonFileStore<NoteRecord[]>>();
  // What each loaded project's store holds, for the synchronous tag checks.
  const notesByProject = new Map<string, NoteRecord[]>();

  function fileFor(projectId: string): JsonFileStore<NoteRecord[]> {
    let file = files.get(projectId);
    if (!file) {
      file = jsonFileStore<NoteRecord[]>({
        path: path.join(options.dir, `${projectId}.json`),
        empty: () => [],
        decode: (raw) => (raw as StoredNote[]).map(upgradeNote),
      });
      files.set(projectId, file);
    }
    return file;
  }

  function upgradeNote(stored: StoredNote): NoteRecord {
    const { imagePath, attachmentId, ...note } = stored;
    const fromPath = attachmentId === undefined && imagePath ? options.attachmentForPath(imagePath) : null;
    return {
      ...note,
      uses: note.uses ?? [],
      attachmentId: attachmentId ?? fromPath?.id ?? null,
      ...(imagePath && !fromPath && attachmentId === undefined ? { imagePath } : {}),
    };
  }

  async function ensureLoaded(projectId: string): Promise<NoteRecord[]> {
    const notes = await fileFor(projectId).load();
    notesByProject.set(projectId, notes);
    return notes;
  }

  // Saves the store's own array (the one every function here mutates), so a
  // project that somehow wasn't loaded yet can never be written back empty.
  async function persist(projectId: string): Promise<void> {
    const file = fileFor(projectId);
    await file.save(await file.load());
  }

  async function listNotes(projectId: string): Promise<NoteRecord[]> {
    return (await ensureLoaded(projectId)).filter(isLive);
  }

  /** The project's notes in the trash, the latest deleted first. */
  async function listTrashedNotes(projectId: string): Promise<NoteRecord[]> {
    return (await ensureLoaded(projectId))
      .filter((note) => !isLive(note))
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  async function createNote(
    projectId: string,
    input: { text: string; attachmentId: string | null; sessionId: string | null }, // sessionId 由呼叫端明確傳入，不再等於 projectId
  ): Promise<NoteRecord> {
    const notes = await ensureLoaded(projectId);
    const now = new Date().toISOString();
    const note: NoteRecord = {
      id: randomUUID(),
      sessionId: input.sessionId, // 純記錄用途，不影響儲存位置
      text: input.text,
      attachmentId: input.attachmentId,
      createdAt: now,
      updatedAt: now,
      used: false,
      usedAt: null,
      done: false,
      doneAt: null,
      uses: [],
    };
    notes.push(note);
    await options.tags.syncNoteTags(projectId, '', note.text, (tag) => projectStillUsesTag(projectId, tag, note.id));
    await persist(projectId);
    return note;
  }

  async function updateNoteText(
    projectId: string,
    noteId: string,
    text: string,
  ): Promise<NoteRecord | undefined> {
    const notes = await ensureLoaded(projectId);
    const index = notes.findIndex((n) => n.id === noteId && isLive(n));
    if (index === -1) return undefined;
    const current = notes[index] as NoteRecord;
    const oldText = current.text;
    // A new object, not a mutation of `current` — a caller holding onto an
    // earlier NoteRecord (e.g. the one createNote just handed back) must not
    // see it silently change out from under it.
    const updated: NoteRecord = { ...current, text, updatedAt: new Date().toISOString() }; // createdAt untouched — this is an edit, not a new note
    notes[index] = updated;
    await options.tags.syncNoteTags(projectId, oldText, text, (tag) => projectStillUsesTag(projectId, tag, noteId));
    await persist(projectId);
    return updated;
  }

  // Into the trash, not gone: the note stays in its file with deletedAt,
  // and its tags leave the project's index as if it were (restoreNote
  // brings both back). False for an unknown or already deleted note.
  async function deleteNote(projectId: string, noteId: string): Promise<boolean> {
    const notes = await ensureLoaded(projectId);
    const index = notes.findIndex((n) => n.id === noteId && isLive(n));
    if (index === -1) return false;
    const note = notes[index] as NoteRecord;
    notes[index] = { ...note, deletedAt: new Date().toISOString() };
    await options.tags.syncNoteTags(projectId, note.text, '', (tag) => projectStillUsesTag(projectId, tag, noteId));
    await persist(projectId);
    return true;
  }

  // Out of the trash, as it was. 'not_found': no such note; 'not_trashed':
  // it isn't in the trash.
  async function restoreNote(projectId: string, noteId: string): Promise<NoteRecord | 'not_found' | 'not_trashed'> {
    const notes = await ensureLoaded(projectId);
    const index = notes.findIndex((n) => n.id === noteId);
    if (index === -1) return 'not_found';
    const { deletedAt, ...note } = notes[index] as NoteRecord;
    if (!deletedAt) return 'not_trashed';
    notes[index] = note;
    await options.tags.syncNoteTags(projectId, '', note.text, (tag) => projectStillUsesTag(projectId, tag, noteId));
    await persist(projectId);
    return note;
  }


  // Checked against the OTHER notes already loaded for this project (the one
  // currently being edited is excluded by id) — a plain in-memory scan, since
  // the whole project's notes are already loaded by the time this runs.
  function projectStillUsesTag(projectId: string, normalizedTag: string, excludeNoteId: string): boolean {
    const notes = notesByProject.get(projectId) ?? [];
    return notes.some((n) => n.id !== excludeNoteId && isLive(n) && extractTags(n.text).some((t) => normalizeTag(t) === normalizedTag));
  }

  // Shared by both the used/unused and done/undone pairs below — same
  // shape (a boolean + its timestamp, updatedAt left untouched since neither
  // is an edit to the note's own content), just a different field name.
  async function setFlag(
    projectId: string,
    noteIds: string[],
    field: 'used' | 'done',
    value: boolean,
  ): Promise<NoteRecord[]> {
    const notes = await ensureLoaded(projectId);
    const idSet = new Set(noteIds);
    const atField = field === 'used' ? 'usedAt' : 'doneAt';
    const touched: NoteRecord[] = [];
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i] as NoteRecord;
      if (!idSet.has(note.id) || !isLive(note)) continue;
      const updated: NoteRecord = { ...note, [field]: value, [atField]: value ? new Date().toISOString() : null };
      notes[i] = updated;
      touched.push(updated);
    }
    if (touched.length > 0) await persist(projectId);
    return touched;
  }

  // `origin` is where the notes went; recorded as one more use of each.
  async function markNotesUsed(
    projectId: string,
    noteIds: string[],
    origin?: { sessionId: string; conversationId: string | null },
  ): Promise<NoteRecord[]> {
    if (origin) {
      const at = new Date().toISOString();
      await changeUses(projectId, noteIds, (uses) => [...uses, { ...origin, at }]);
    }
    return setFlag(projectId, noteIds, 'used', true);
  }

  // Undoing an insert: that use didn't happen after all, so the latest one
  // goes too.
  async function markNotesUnused(projectId: string, noteIds: string[]): Promise<NoteRecord[]> {
    await changeUses(projectId, noteIds, (uses) => uses.slice(0, -1));
    return setFlag(projectId, noteIds, 'used', false);
  }

  // In memory only; the setFlag call that always follows persists it.
  async function changeUses(projectId: string, noteIds: string[], change: (uses: NoteUse[]) => NoteUse[]): Promise<void> {
    const notes = await ensureLoaded(projectId);
    const idSet = new Set(noteIds);
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i] as NoteRecord;
      if (idSet.has(note.id) && isLive(note)) notes[i] = { ...note, uses: change(note.uses) };
    }
  }

  async function markNotesDone(projectId: string, noteIds: string[]): Promise<NoteRecord[]> {
    return setFlag(projectId, noteIds, 'done', true);
  }

  async function markNotesUndone(projectId: string, noteIds: string[]): Promise<NoteRecord[]> {
    return setFlag(projectId, noteIds, 'done', false);
  }

  // 把舊的、以 sessionId 命名的便箋檔案（<dir>/${sessionId}.json）併入這個
  // session 現在所屬 project 的檔案（<dir>/${projectId}.json）。冪等 —— 可以
  // 安全地被呼叫多次而不會重複合併（用 note.id 去重）。舊檔案合併成功後改名為
  // `${sessionId}.json.migrated`（不是刪除）：保留一份改名後的備份檔案，換取
  // 「萬一合併邏輯有 bug，原始資料還在磁碟上」的可回復性。只在啟動時的 migration
  // 路徑呼叫（see registry.ts's ensureLoaded()），一般 CRUD 流程永遠不會呼叫它。
  async function migrateLegacySessionNotes(sessionId: string, projectId: string): Promise<void> {
    const legacyPath = path.join(options.dir, `${sessionId}.json`);
    let legacyNotes: StoredNote[];
    try {
      legacyNotes = JSON.parse(await readFile(legacyPath, 'utf-8')) as StoredNote[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // 這個 session 本來就沒有便箋，或已經遷移過
      throw err;
    }
    if (legacyNotes.length > 0) {
      const projectNotes = await ensureLoaded(projectId);
      const existingIds = new Set(projectNotes.map((n) => n.id));
      for (const note of legacyNotes) {
        if (existingIds.has(note.id)) continue; // 冪等：已經合併過的便箋不重複加入
        projectNotes.push(upgradeNote(note));
      }
      await persist(projectId);
      await options.tags.remapSessionToProject(sessionId, projectId);
    }
    await rename(legacyPath, `${legacyPath}.migrated`);
  }

  // Moves notes to another project (the inbox's notes, sorted into a real
  // one; or one filed in the wrong project). Everything else about each note
  // stays as it was. Returns the notes moved; ids not in `fromProjectId` are
  // ignored.
  async function moveNotes(fromProjectId: string, noteIds: string[], toProjectId: string): Promise<NoteRecord[]> {
    if (fromProjectId === toProjectId) return [];
    const source = await ensureLoaded(fromProjectId);
    const target = await ensureLoaded(toProjectId);
    const ids = new Set(noteIds);
    const moving = source.filter((note) => ids.has(note.id) && isLive(note));
    const movingIds = new Set(moving.map((note) => note.id));
    if (moving.length === 0) return [];
    // In place: this array is the one notesByProject holds.
    for (let i = source.length - 1; i >= 0; i--) {
      if (movingIds.has((source[i] as NoteRecord).id)) source.splice(i, 1);
    }
    target.push(...moving);
    for (const note of moving) {
      await options.tags.syncNoteTags(fromProjectId, note.text, '', (tag) => projectStillUsesTag(fromProjectId, tag, note.id));
      await options.tags.syncNoteTags(toProjectId, '', note.text, (tag) => projectStillUsesTag(toProjectId, tag, note.id));
    }
    await persist(fromProjectId);
    await persist(toProjectId);
    return moving;
  }

  function reset(): void {
    for (const file of files.values()) file.reset();
    files.clear();
    notesByProject.clear();
  }

  return {
    listNotes, listTrashedNotes, createNote, updateNoteText, deleteNote, restoreNote, markNotesUsed, markNotesUnused, markNotesDone, markNotesUndone,
    migrateLegacySessionNotes, moveNotes, reset,
  };
}
