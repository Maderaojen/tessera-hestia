import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSensitivePath } from '@maderaojen/fs-guard';
import { PROCESS_IMAGE_MAX_BYTES, type ProcessImage } from '../contract/process.js';
import { isDeniedPath } from '../files/denied-paths.js';

// A process item's images (capability process_images): what the CLI saw,
// shown in the item's detail. A result's own image (Claude: a tool_result's
// base64 image block) or the file a tool looked at (Codex view_image). The
// file is the one the transcript names, never a path a client sends, and
// may be outside the project: a login can already read anything on the
// host through the CLI. What is served is checked by its bytes, not its
// name or the transcript's word: only PNG, JPEG, GIF and WebP — never SVG,
// a document that can carry script — so a secret named like an image
// isn't sent.

export type RawProcessImage = { source: 'result'; data: string } | { source: 'file'; path: string };

export class ProcessImageError extends Error {
  constructor(public readonly code: 'missing' | 'blocked' | 'not_file' | 'unsupported_media' | 'too_large', message: string) {
    super(message);
  }
}

/** The images as a detail lists them. */
export function listProcessImages(raw: readonly RawProcessImage[]): ProcessImage[] | undefined {
  if (raw.length === 0) return undefined;
  return raw.map((image, index) => ({ index, source: image.source, name: image.source === 'file' ? path.basename(image.path) : null }));
}

/** The image type its bytes say, or null for anything else (SVG included). */
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function checked(bytes: Buffer): { type: string; bytes: Buffer } {
  if (bytes.length > PROCESS_IMAGE_MAX_BYTES) throw new ProcessImageError('too_large', 'image over 15 MB');
  const type = sniffImage(bytes);
  if (!type) throw new ProcessImageError('unsupported_media', 'not a PNG, JPEG, GIF or WebP image');
  return { type, bytes };
}

function blocked(target: string): boolean {
  return isSensitivePath(target) || isDeniedPath(target);
}

/** One image's bytes and type, or why not. */
export async function loadProcessImage(image: RawProcessImage): Promise<{ type: string; bytes: Buffer }> {
  if (image.source === 'result') {
    // Base64 is 4/3 of the bytes: refuse a block too large before decoding it.
    if (image.data.length > Math.ceil(PROCESS_IMAGE_MAX_BYTES / 3) * 4 + 4) throw new ProcessImageError('too_large', 'image over 15 MB');
    return checked(Buffer.from(image.data, 'base64'));
  }
  const file = image.path;
  if (!path.isAbsolute(file)) throw new ProcessImageError('missing', 'the transcript names no absolute path');
  if (blocked(file)) throw new ProcessImageError('blocked', 'path may hold secrets');
  const real = await realpath(file).catch(() => {
    throw new ProcessImageError('missing', 'the file is gone');
  });
  if (blocked(real)) throw new ProcessImageError('blocked', 'path may hold secrets');
  const handle = await open(real, 'r').catch(() => {
    throw new ProcessImageError('missing', 'the file is gone');
  });
  try {
    // Opened, then checked: a regular file (not a device, FIFO or folder)
    // and still the one realpath named.
    const opened = await handle.stat();
    if (!opened.isFile()) throw new ProcessImageError('not_file', 'not a regular file');
    if (opened.size > PROCESS_IMAGE_MAX_BYTES) throw new ProcessImageError('too_large', 'image over 15 MB');
    if (await realpath(file).catch(() => null) !== real) throw new ProcessImageError('missing', 'the file changed while it was opened');
    return checked(await handle.readFile());
  } finally {
    await handle.close();
  }
}
