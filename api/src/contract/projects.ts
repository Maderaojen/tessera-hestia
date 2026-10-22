import type { UploadedAttachment } from './attachments.js';

// Projects and their notes, as the API sends them.

/**
 * The inbox: notes not filed under any project yet. Always exists, isn't in
 * GET /projects, and can't be renamed or deleted; every notes route takes
 * its id as a project id. It has no name here: the app names it in its
 * own language by this id.
 */
export const INBOX_PROJECT_ID = 'inbox';

// Where a project's tmux sessions have been opened; the primary one is where
// a new tmux in it starts by default. A project can have none.
export type ProjectPath = { path: string; primary: boolean; addedAt: string };
export type ProjectDto = { id: string; name: string; createdAt: string; deletedAt: string | null; paths: ProjectPath[] };

// One time a note was put into a chat: which tmux, which conversation in it
// (null when that isn't known), when.
export type NoteUse = { sessionId: string; conversationId: string | null; at: string };

export type NoteDto = {
  id: string;
  // Which tmux it was written in; null when written outside one (the inbox).
  sessionId: string | null;
  text: string; // #tag tokens embedded as typed
  // The image attached to it, if any (contract v1; absent from older APIs).
  attachment?: UploadedAttachment | null;
  /**
   * @deprecated Contract v1: the image's path on the API's
   * machine, for PWAs cached before attachments. Read `attachment`.
   */
  imagePath: string | null;
  createdAt: string;
  updatedAt: string;
  used: boolean;
  usedAt: string | null;
  done: boolean;
  doneAt: string | null;
  // Every time it was put into a chat, oldest first. Having been sent isn't
  // the same as done.
  uses: NoteUse[];
};

/** A note in its project's trash (GET /projects/:id/notes/trash; capability note_trash). */
export type TrashedNoteDto = NoteDto & { deletedAt: string };

/** POST /projects/:id/notes. */
export type CreateNoteRequest = {
  text: string;
  // An uploaded image's attachment id (POST /notes/uploads).
  attachmentId?: string | null;
  /** @deprecated Contract v1: what PWAs cached before attachments send. */
  imagePath?: string | null;
  sessionId?: string | null;
};
