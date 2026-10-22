// Files the user attached — images and other files uploaded from the
// composer, or a note's image. The API stores and serves them; a client
// only ever holds an attachment, never a path on the API's machine.

export type Attachment = {
  // Opaque to clients: what a note refers to its image by.
  id: string;
  // 'file' (capability composer_attachments): any other file, served as a
  // download. A client that doesn't know a kind shows it as a file.
  kind: 'image' | 'file';
  // Where it loads from, relative to the API root (`…/api`). A client puts
  // its own base in front, and whatever credential its images need (a
  // bearer host's media token).
  url: string;
  // A file's name as uploaded (made safe for a path). Absent on an image.
  name?: string;
};

/** An attachment as uploaded, with how to refer to it in a message. */
export type UploadedAttachment = Attachment & {
  // The text to put into a message so the CLI reads the file (it reads it
  // from the API's machine). Worded by the API, since what a CLI
  // understands is the API's business. With composer_attachments, the
  // file's path alone; before, a sentence asking to look at the image.
  promptText: string;
};

/** POST /sessions/:id/uploads and POST /notes/uploads. */
export type UploadResponse = {
  attachment: UploadedAttachment;
  /**
   * @deprecated Contract v1: the file's path on the API's
   * machine, for PWAs cached before attachments. Read `attachment`.
   */
  path: string;
};

/**
 * The largest upload the API takes (composer_attachments): a client lets
 * its user choose a smaller limit. Kept under the 100 MB request body a
 * Cloudflare tunnel passes, multipart overhead included.
 */
export const UPLOAD_MAX_BYTES = 90 * 1024 * 1024;

/**
 * An attachment a message's text refers to. `start`/`end` (UTF-16 offsets
 * into that text, end exclusive) are the part a client may show as the
 * attachment itself — a thumbnail, a file's name — instead of text.
 */
export type TextAttachment = Attachment & { start: number; end: number };

/** A part of a message's text, by UTF-16 offsets (end exclusive). */
export type TextRange = { start: number; end: number };
