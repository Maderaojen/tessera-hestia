import { NOTES_DIR } from './config.js';
import { attachmentById, attachmentForPath, attachmentPath, withPromptText } from './attachments.js';
import type { NoteDto, TrashedNoteDto } from './contract/projects.js';
import { createNotesStore, type NoteRecord } from './notes/store.js';
import * as tagIndex from './tag-index.js';

export type { NoteRecord, NoteUse } from './notes/store.js';

// Hestia's notes: the store (notes/store.ts) in NOTES_DIR, with Hestia's
// attachments and tag index. Kept at this path so its callers and the
// tests that mock it don't change.
const notes = createNotesStore({
  dir: NOTES_DIR,
  tags: tagIndex,
  attachmentForPath,
});

export const {
  listNotes, listTrashedNotes, createNote, updateNoteText, deleteNote, restoreNote, markNotesUsed, markNotesUnused, markNotesDone, markNotesUndone,
  migrateLegacySessionNotes, moveNotes,
} = notes;

/**
 * A note as the API sends it (contract/projects.ts): its image as an
 * attachment, plus that image's path for PWAs cached before attachments.
 */
export function toNoteDto(note: NoteRecord): NoteDto {
  const { attachmentId, imagePath, ...rest } = note;
  delete rest.deletedAt;
  const found = attachmentId ? attachmentById(attachmentId) : null;
  const attachment = found?.kind === 'image' ? found : null;
  return {
    ...rest,
    attachment: attachment ? withPromptText(attachment) : null,
    imagePath: attachment ? attachmentPath(attachment) : imagePath ?? null,
  };
}

/** A note in the trash: the same, and when it was deleted. */
export function toTrashedNoteDto(note: NoteRecord): TrashedNoteDto {
  return { ...toNoteDto(note), deletedAt: note.deletedAt ?? '' };
}

export async function __resetForTests(): Promise<void> {
  notes.reset();
}
