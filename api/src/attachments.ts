import path from 'node:path';
import { UPLOADS_DIR } from './config.js';
import type { Attachment, TextAttachment, UploadedAttachment } from './contract/attachments.js';

// Uploads as attachments (contract/attachments.ts). An upload lives at
// <UPLOADS_DIR>/<id>: the id's first folder is the session it was sent in,
// or 'notes' for a note's image. The id is all a client ever gets: the
// folder picks the route it's served from, and the path on this machine is
// rebuilt here, never taken from a client.

/** The image types uploads accept: the one table MIME types and file extensions are read from. */
export const IMAGE_TYPES = [
  { mime: 'image/png', ext: '.png' },
  { mime: 'image/jpeg', ext: '.jpg' },
  { mime: 'image/webp', ext: '.webp' },
  { mime: 'image/heic', ext: '.heic' },
  { mime: 'image/heif', ext: '.heif' },
] as const;

export const NOTES_UPLOAD_FOLDER = 'notes';

export function extensionFor(mime: string): string | undefined {
  return IMAGE_TYPES.find((type) => type.mime === mime)?.ext;
}

export function mimeFor(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_TYPES.find((type) => type.ext === ext)?.mime;
}

// An image is `<folder>/<file>`: a folder is a session id (a uuid) or
// 'notes', a file a name with one of the extensions above. Any other file
// (capability composer_attachments) is `<session>/<uuid>/<name>`: its own
// folder, so its name can stay what it was uploaded as (made safe by
// safeUploadName). Nothing that could climb out of UPLOADS_DIR.
const FOLDER = /^[A-Za-z0-9-]+$/;
const FILE = /^[A-Za-z0-9-]+\.[a-z]+$/;
const UPLOAD_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Letters and digits of any script, dot, dash, underscore; no leading dot.
const FILE_NAME_CHARS = '[\\p{L}\\p{N}._-]';
const FILE_NAME = new RegExp(`^(?!\\.)${FILE_NAME_CHARS}{1,120}$`, 'u');

type Parsed = { folder: string; file: string } | { folder: string; dir: string; name: string };

function parse(id: string): Parsed | null {
  const [folder, second, third, ...rest] = id.split('/');
  if (rest.length > 0 || !folder || !second || !FOLDER.test(folder)) return null;
  if (third === undefined) return FILE.test(second) && mimeFor(second) ? { folder, file: second } : null;
  if (folder === NOTES_UPLOAD_FOLDER || !UPLOAD_DIR_NAME.test(second) || !FILE_NAME.test(third)) return null;
  return { folder, dir: second, name: third };
}

function toAttachment(parsed: Parsed): Attachment {
  const { folder } = parsed;
  const base = folder === NOTES_UPLOAD_FOLDER ? '/notes/uploads' : `/sessions/${encodeURIComponent(folder)}/uploads`;
  if ('file' in parsed) return { id: `${folder}/${parsed.file}`, kind: 'image', url: `${base}/${encodeURIComponent(parsed.file)}` };
  return {
    id: `${folder}/${parsed.dir}/${parsed.name}`,
    kind: 'file',
    url: `${base}/${parsed.dir}/${encodeURIComponent(parsed.name)}`,
    name: parsed.name,
  };
}

/** The attachment an id names, or null if it can't name an upload. */
export function attachmentById(id: string): Attachment | null {
  const parsed = parse(id);
  return parsed ? toAttachment(parsed) : null;
}

/**
 * A file's name as it is kept and shown: letters and digits (any script),
 * dots, dashes and underscores, everything else an underscore — so the
 * path a message carries has no spaces or quotes and reads as one word.
 * Long names keep their extension.
 */
export function safeUploadName(original: string): string {
  const cleaned = path.basename(original).normalize('NFC')
    .replace(new RegExp(`(?!${FILE_NAME_CHARS}).`, 'gu'), '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '');
  const name = cleaned || 'file';
  if ([...name].length <= 120) return name;
  const ext = path.extname(name).slice(0, 16);
  return [...name.slice(0, name.length - ext.length)].slice(0, 120 - [...ext].length).join('') + ext;
}

/**
 * The attachment an upload's path on this machine stands for — a path the
 * API itself once handed out (a legacy note's imagePath, a reference in a
 * message). An image is read by its last two segments, as clients used
 * to: that stays right for paths written before UPLOADS_DIR moved.
 */
export function attachmentForPath(filePath: string): Attachment | null {
  const segments = filePath.split('/');
  const last = segments.pop();
  const before = segments.pop();
  if (!last || !before) return null;
  // A file's own folder first: its name may end like an image's.
  const folder = segments.pop();
  if (folder && UPLOAD_DIR_NAME.test(before)) return attachmentById(`${folder}/${before}/${last}`);
  return attachmentById(`${before}/${last}`);
}

/** Where an attachment's file is on this machine. */
export function attachmentPath(attachment: Pick<Attachment, 'id'>): string {
  return path.join(UPLOADS_DIR, attachment.id);
}

// How a message tells the CLI to read an upload: its path on this machine,
// nothing else (the CLI reads it from there). Before, an image came with a
// sentence asking to look at it; attachmentsInText still recognizes that.
const LEGACY_PROMPT_PREFIX = '請看這張圖片：';

export function withPromptText(attachment: Attachment): UploadedAttachment {
  return { ...attachment, promptText: attachmentPath(attachment) };
}

const IMAGE_EXTENSIONS = IMAGE_TYPES.map((type) => `\\${type.ext}`).join('|');
// The old wording: the path stops at a known image extension rather than
// the next whitespace, since text was often typed right after it.
const LEGACY_REFERENCE = new RegExp(`${LEGACY_PROMPT_PREFIX}(\\S+?(?:${IMAGE_EXTENSIONS}))`, 'g');

// A bare path into this machine's UPLOADS_DIR: an image's, or a file's.
function uploadPathPattern(): RegExp {
  const dir = UPLOADS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${dir}/[A-Za-z0-9-]+/(?:[0-9a-f-]{36}/${FILE_NAME_CHARS}+|[A-Za-z0-9-]+(?:${IMAGE_EXTENSIONS}))`, 'gu');
}
const UPLOAD_PATH = uploadPathPattern();

/**
 * The uploads a message refers to, each with where its path sits in the
 * text (the part a client can show as a thumbnail or a file's name; the
 * words around it stay text): bare paths into UPLOADS_DIR, and paths after
 * the old wording, wherever UPLOADS_DIR was then.
 */
export function attachmentsInText(text: string): TextAttachment[] {
  const found: TextAttachment[] = [];
  const legacy = new Set<number>();
  for (const match of text.matchAll(LEGACY_REFERENCE)) {
    const reference = match[1]!;
    const attachment = attachmentForPath(reference);
    if (!attachment) continue;
    const start = match.index + LEGACY_PROMPT_PREFIX.length;
    legacy.add(start);
    found.push({ ...attachment, start, end: start + reference.length });
  }
  for (const match of text.matchAll(UPLOAD_PATH)) {
    if (legacy.has(match.index)) continue;
    const attachment = attachmentForPath(match[0]);
    if (attachment) found.push({ ...attachment, start: match.index, end: match.index + match[0].length });
  }
  return found.sort((a, b) => a.start - b.start);
}
