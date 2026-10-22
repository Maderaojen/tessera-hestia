import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HANDOFF_BRIEF_MAX_BYTES } from '../contract/continuity.js';

// Reading a handoff brief for the app to show: only a regular file directly in <cwd>/.hestia/handoffs, never by a
// path a client gave. Which handoff (and so which file) belongs to which
// session is brief-lookup.ts's; this is only the file system.

const BRIEF_DIR = ['.hestia', 'handoffs'] as const;
// A plain file name: no separators, not hidden, nothing to climb with.
const PLAIN_NAME = /^[^/\\.][^/\\]*\.md$/;

export type BriefFileResult =
  | { ok: true; file: string; content: string; truncated: boolean; size: number; modifiedAt: string }
  | { ok: false; reason: 'missing' | 'unsafe' };

/**
 * The brief named `briefFile` (relative to cwd, as stored with a handoff),
 * or, without one, the one file whose name ends in `-<shortId>.md`.
 */
export async function readHandoffBrief(cwd: string, target: { briefFile: string | null; shortId: string }): Promise<BriefFileResult> {
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const dir = path.join(root, ...BRIEF_DIR);
  // Neither .hestia nor handoffs may lead anywhere else.
  try {
    if (await realpath(dir) !== dir) return { ok: false, reason: 'unsafe' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  let name: string;
  if (target.briefFile !== null) {
    const parts = target.briefFile.split(/[/\\]/);
    const stored = parts.at(-1) ?? '';
    if (parts.length !== 3 || parts[0] !== BRIEF_DIR[0] || parts[1] !== BRIEF_DIR[1] || !PLAIN_NAME.test(stored)) {
      return { ok: false, reason: 'unsafe' };
    }
    name = stored;
  } else {
    if (!/^[0-9a-f]{8}$/.test(target.shortId)) return { ok: false, reason: 'unsafe' };
    const suffix = `-${target.shortId}.md`;
    const found = (await readdir(dir).catch(() => [] as string[]))
      .filter((entry) => entry.endsWith(suffix) && PLAIN_NAME.test(entry));
    if (found.length === 0) return { ok: false, reason: 'missing' };
    if (found.length > 1) return { ok: false, reason: 'unsafe' };
    name = found[0]!;
  }
  return readRegularFile(dir, name);
}

async function readRegularFile(dir: string, name: string): Promise<BriefFileResult> {
  let handle;
  try {
    handle = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'unsafe' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'unsafe' };
    const length = Math.min(info.size, HANDOFF_BRIEF_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const truncated = info.size > HANDOFF_BRIEF_MAX_BYTES;
    const bytes = truncated ? buffer.subarray(0, wholeCharacters(buffer.subarray(0, bytesRead))) : buffer.subarray(0, bytesRead);
    return {
      ok: true,
      file: path.posix.join(...BRIEF_DIR, name),
      content: bytes.toString('utf-8'),
      truncated,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

/** How many of `bytes` end on a whole UTF-8 character (a cut one is left off). */
export function wholeCharacters(bytes: Uint8Array): number {
  const end = bytes.length;
  // The last character's first byte is within the last four.
  for (let start = end - 1; start >= Math.max(0, end - 4); start -= 1) {
    const byte = bytes[start]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte
    const length = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return start + length <= end ? end : start;
  }
  return end;
}
