// Reading and changing ~/.ssh/authorized_keys for `hestia ssh-authorize`. This file can lock the user out of their
// own server, so the rules are narrow:
//
// - Every line this run doesn't mean to touch stays byte for byte: comments,
//   blank lines, CRLF endings, a last line without a newline. Each change is
//   planned as whole-line edits, applied, and then checked against the old
//   content independently of how it was applied; a mismatch writes nothing.
// - Permissions and owners are never changed. A ~/.ssh or authorized_keys
//   that isn't the user's own, or that group or others can write, stops the
//   run with the chmod to type (sshd's StrictModes ignores such files
//   anyway); a symbolic link stops it too. Only a missing ~/.ssh (0700) or
//   file (0600) is created.
// - Writes go to a temporary file in the same directory with the original's
//   mode, are fsynced and renamed over the original: a reader sees the old
//   file or the new one, never half of one.
// - One writer at a time: a lock file made with O_CREAT|O_EXCL (Node has no
//   flock, and macOS has no flock command), re-reading the file inside it.
//   Two runs of the command, or a run and another's cleanup, take turns.
//
// The pure parts (parsing, planning, checking) take strings; the file parts
// take a directory, so the tests run on a temporary one and never on the
// real ~/.ssh.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

// MARK: - keys

/** A public key the command accepts: ed25519, or RSA of 2048 bits or more. */
export type PublicKey = { type: 'ssh-ed25519' | 'ssh-rsa'; base64: string; bits: number; fingerprint: string };

/** `SHA256:` and the unpadded base64 of the blob's SHA-256, as `ssh-keygen -lf` prints it. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function readString(blob: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset + 4 > blob.length) return null;
  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  if (length > blob.length - start) return null;
  return { value: blob.subarray(start, start + length), next: start + length };
}

function mpintBits(value: Buffer): number {
  let i = 0;
  while (i < value.length && value[i] === 0) i++;
  if (i === value.length) return 0;
  return (value.length - i - 1) * 8 + (32 - Math.clz32(value[i]!));
}

/**
 * `<type> <base64> [comment]` as a key this command will authorize; null for
 * anything else (another type, a short RSA key, a blob that doesn't parse
 * or whose inner type doesn't match the outer one).
 */
export function parsePublicKey(text: string): PublicKey | null {
  const [type, base64] = text.trim().split(/\s+/);
  if ((type !== 'ssh-ed25519' && type !== 'ssh-rsa') || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const blob = Buffer.from(base64, 'base64');
  // Only the canonical encoding: what goes in the file is what was checked.
  if (blob.toString('base64') !== base64) return null;
  const name = readString(blob, 0);
  if (!name || name.value.toString('latin1') !== type) return null;
  if (type === 'ssh-ed25519') {
    const key = readString(blob, name.next);
    if (!key || key.value.length !== 32 || key.next !== blob.length) return null;
    return { type, base64, bits: 256, fingerprint: fingerprintOf(blob) };
  }
  const e = readString(blob, name.next);
  const n = e && readString(blob, e.next);
  if (!e || !n || n.next !== blob.length || mpintBits(e.value) === 0) return null;
  const bits = mpintBits(n.value);
  if (bits < 2048) return null;
  return { type, base64, bits, fingerprint: fingerprintOf(blob) };
}

/**
 * The comment written after a key: letters, digits and `._@:+-` only, spaces
 * as dashes, at most 64 characters. It goes into a file sshd reads line by
 * line, so nothing that could end the line or start options gets through.
 */
export function safeComment(label: string): string {
  const cleaned = label.normalize('NFC').trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._@:+-]/gu, '').slice(0, 64);
  return cleaned || 'hestia';
}

// MARK: - lines

/** One line of the file: its text and its ending ('\n', '\r\n' or '' for a last line without one). */
export type RawLine = { text: string; eol: string };

export function splitLines(content: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf('\n', start);
    if (nl === -1) {
      lines.push({ text: content.slice(start), eol: '' });
      break;
    }
    const crlf = nl > start && content[nl - 1] === '\r';
    lines.push({ text: content.slice(start, crlf ? nl - 1 : nl), eol: crlf ? '\r\n' : '\n' });
    start = nl + 1;
  }
  return lines;
}

export const joinLines = (lines: RawLine[]): string => lines.map((line) => line.text + line.eol).join('');

/** A key line, split where sshd splits it. `rest` is everything after the options, untouched. */
export type KeyLine = { options: string | null; type: string; base64: string; comment: string; rest: string };

const KEY_TYPE = /^(?:ssh-|ecdsa-|sk-)/;

/** A line's parts; null for a blank line, a comment, or one that can't be read. */
export function parseKeyLine(text: string): KeyLine | null {
  const leading = /^[ \t]*/.exec(text)![0].length;
  const body = text.slice(leading);
  if (!body || body.startsWith('#')) return null;
  let options: string | null = null;
  let rest = body;
  if (!KEY_TYPE.test(body)) {
    // Options run to the first space or tab outside double quotes (\" escapes one).
    let i = 0;
    let quoted = false;
    for (; i < body.length; i++) {
      const c = body[i]!;
      if (c === '\\' && quoted && i + 1 < body.length) { i++; continue; }
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === ' ' || c === '\t')) break;
    }
    if (quoted || i === body.length) return null;
    options = body.slice(0, i);
    rest = body.slice(i);
  }
  const match = /^[ \t]*(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(rest);
  if (!match) return null;
  return { options, type: match[1]!, base64: match[2]!, comment: match[3] ?? '', rest };
}

/** The options split at commas outside quotes. */
export function splitOptions(options: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < options.length; i++) {
    const c = options[i]!;
    if (c === '\\' && quoted && i + 1 < options.length) { current += c + options[++i]; continue; }
    if (c === '"') quoted = !quoted;
    if (c === ',' && !quoted) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  return parts;
}

/**
 * The permitopen targets of a line Hestia would have written —
 * `restrict,port-forwarding` and permitopen="…" entries, nothing else — or
 * null when the options are anything else.
 */
export function hestiaPermitOpens(options: string): string[] | null {
  const parts = splitOptions(options);
  const names = parts.map((part) => part.toLowerCase());
  if (names.filter((p) => p === 'restrict').length !== 1 || names.filter((p) => p === 'port-forwarding').length !== 1) return null;
  const targets: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'restrict' || lower === 'port-forwarding') continue;
    const match = /^permitopen="([^"\\]*)"$/i.exec(part);
    if (!match) return null;
    targets.push(match[1]!);
  }
  return targets;
}

export function restrictedLine(key: { type: string; base64: string }, port: number, comment: string): string {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${port}" ${key.type} ${key.base64} ${safeComment(comment)}`;
}

// MARK: - one-time lines

/** The comment that marks a one-time line: `hestia-authorize-` and a random value. */
export const ONE_TIME_PREFIX = 'hestia-authorize-';

export function oneTimeComment(): string {
  return ONE_TIME_PREFIX + randomBytes(9).toString('base64url');
}

/** sshd's expiry-time format, in UTC, to the minute: YYYYMMDDHHMMZ. */
export function expiryTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}Z`;
}

/** The time an expiry-time names; null when it doesn't read as one (YYYYMMDD[HHMM[SS]], Z for UTC). */
export function parseExpiryTime(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(Z?)$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = match;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  // Without Z sshd reads it in the server's own time zone, as Date does.
  const date = z ? new Date(Date.UTC(...parts)) : new Date(...parts);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The one-time line: an ed25519 key that can only forward to the command's
 * own listener, until `expires` (rounded up to the minute).
 */
export function oneTimeLine(publicKeyBase64: string, listenerPort: number, expires: Date, comment: string): string {
  const rounded = new Date(Math.ceil(expires.getTime() / 60_000) * 60_000);
  return `restrict,port-forwarding,permitopen="127.0.0.1:${listenerPort}",expiry-time="${expiryTime(rounded)}" ssh-ed25519 ${publicKeyBase64} ${comment}`;
}

/** A one-time line (by its comment) whose expiry-time has passed: left by a run that didn't get to clean up. */
export function isExpiredOneTimeLine(text: string, now: Date): boolean {
  const line = parseKeyLine(text);
  if (!line?.options || !line.comment.startsWith(ONE_TIME_PREFIX)) return false;
  const expiry = splitOptions(line.options).map((part) => /^expiry-time="([^"]*)"$/i.exec(part)?.[1]).find((v) => v !== undefined);
  const at = expiry === undefined ? null : parseExpiryTime(expiry);
  return at !== null && at.getTime() <= now.getTime();
}

// MARK: - planning

/** What to do to the file: lines to drop or replace (by index), lines to add at the end. */
export type Edit = { remove: number[]; replace: Map<number, string>; append: string[] };

export type AuthorizeOutcome =
  | { result: 'added'; edit: Edit; line: string }
  | { result: 'merged'; edit: Edit; line: string }
  | { result: 'present_unrestricted' | 'present_other'; edit: Edit; suggested: string };

const emptyEdit = (): Edit => ({ remove: [], replace: new Map(), append: [] });

/** Expired one-time lines, to drop with whatever else this write does. */
export function expiredOneTimeLines(lines: RawLine[], now: Date): number[] {
  return lines.flatMap((line, index) => (isExpiredOneTimeLine(line.text, now) ? [index] : []));
}

/**
 * How to authorize `key` for 127.0.0.1:`port` (§3.3): add a line, add the
 * port to the one Hestia wrote before, or leave a line it didn't write alone.
 */
export function planAuthorize(lines: RawLine[], key: PublicKey, port: number, comment: string): AuthorizeOutcome {
  const target = `127.0.0.1:${port}`;
  const suggested = restrictedLine(key, port, comment);
  const matches = lines.flatMap((line, index) => {
    const parsed = parseKeyLine(line.text);
    return parsed && parsed.type === key.type && parsed.base64 === key.base64 ? [{ index, parsed }] : [];
  });
  if (matches.length === 0) return { result: 'added', edit: { ...emptyEdit(), append: [suggested] }, line: suggested };
  if (matches.length > 1) return { result: 'present_other', edit: emptyEdit(), suggested };
  const { index, parsed } = matches[0]!;
  if (parsed.options === null) return { result: 'present_unrestricted', edit: emptyEdit(), suggested };
  const targets = hestiaPermitOpens(parsed.options);
  if (targets === null) return { result: 'present_other', edit: emptyEdit(), suggested };
  if (targets.includes(target)) return { result: 'merged', edit: emptyEdit(), line: lines[index]!.text };
  // Only the options change: the leading space, key and comment stay as they were.
  const text = lines[index]!.text;
  const leading = /^[ \t]*/.exec(text)![0];
  const merged = `${leading}${parsed.options},permitopen="${target}"${parsed.rest}`;
  return { result: 'merged', edit: { ...emptyEdit(), replace: new Map([[index, merged]]) }, line: merged };
}

/** The lines whose comment is exactly `comment` (a one-time line to remove). */
export function linesWithComment(lines: RawLine[], comment: string): number[] {
  return lines.flatMap((line, index) => (parseKeyLine(line.text)?.comment === comment ? [index] : []));
}

/** The line ending new lines get: the file's own (CRLF if its first line has one), else \n. */
function lineEnding(lines: RawLine[]): string {
  return lines.find((line) => line.eol)?.eol ?? '\n';
}

export function applyEdit(lines: RawLine[], edit: Edit): RawLine[] {
  const removed = new Set(edit.remove);
  const out: RawLine[] = [];
  lines.forEach((line, index) => {
    if (removed.has(index)) return;
    const replacement = edit.replace.get(index);
    out.push(replacement === undefined ? line : { text: replacement, eol: line.eol });
  });
  if (edit.append.length > 0) {
    const eol = lineEnding(lines);
    // A last line without a newline gets one, so the new line starts on its own.
    const last = out[out.length - 1];
    if (last && last.eol === '') out[out.length - 1] = { ...last, eol };
    for (const text of edit.append) out.push({ text, eol });
  }
  return out;
}

/**
 * Checks, from the two contents alone, that `after` is `before` with exactly
 * the edit's lines dropped, replaced or added and every other line the same
 * bytes, in the same order. (A last line that had no newline may have gained
 * one, if lines were added after it.) Independent of applyEdit on purpose.
 */
export function onlyEdited(before: string, after: string, edit: Edit): boolean {
  const old = splitLines(before);
  const now = splitLines(after);
  if (edit.remove.some((i) => edit.replace.has(i))) return false;
  if (edit.remove.some((i) => i < 0 || i >= old.length) || [...edit.replace.keys()].some((i) => i < 0 || i >= old.length)) return false;
  if (now.length !== old.length - edit.remove.length + edit.append.length) return false;
  // Walk the old lines; each kept one must be the next new line, byte for byte.
  let j = 0;
  for (let i = 0; i < old.length; i++) {
    if (edit.remove.includes(i)) continue;
    const line = now[j++];
    if (!line) return false;
    const replacement = edit.replace.get(i);
    if (replacement !== undefined) {
      if (line.text !== replacement || line.eol !== old[i]!.eol) return false;
      continue;
    }
    if (line.text !== old[i]!.text) return false;
    const lastOld = i === old.length - 1;
    if (line.eol !== old[i]!.eol && !(lastOld && old[i]!.eol === '' && edit.append.length > 0 && line.eol !== '')) return false;
  }
  // Then the added lines, in order, each ending in a newline.
  for (const text of edit.append) {
    const line = now[j++];
    if (!line || line.text !== text || line.eol === '') return false;
  }
  return j === now.length;
}

// MARK: - the file

export type KeyFileErrorCode =
  | 'ssh_dir_symlink' | 'ssh_dir_not_dir' | 'ssh_dir_owner' | 'ssh_dir_mode'
  | 'file_symlink' | 'file_not_regular' | 'file_owner' | 'file_mode'
  | 'not_utf8' | 'locked' | 'changed_while_writing' | 'verify_failed';

/** Why the file was left alone; `chmod`, when the fix is a chmod the user runs. */
export class KeyFileError extends Error {
  constructor(readonly code: KeyFileErrorCode, readonly path: string, readonly chmod?: string) {
    super(`${code}: ${path}`);
  }
}

/** Where the files are, and who the user is. */
export type KeyFiles = { sshDir: string; uid: number };

export const authorizedKeysPath = (files: KeyFiles) => path.join(files.sshDir, 'authorized_keys');
export const lockPath = (files: KeyFiles) => path.join(files.sshDir, '.hestia-authorized_keys.lock');

/** File operations a test can make fail (an interrupted write); the real ones otherwise. */
export type KeyFileOps = {
  rename: (from: string, to: string) => Promise<void>;
  beforeRename?: (tempPath: string) => Promise<void>;
};
const REAL_OPS: KeyFileOps = { rename: (from, to) => fsp.rename(from, to) };

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** ~/.ssh as sshd's StrictModes wants it, made (0700) when missing. Never changed when present. */
export async function checkSshDir(files: KeyFiles): Promise<void> {
  const dir = files.sshDir;
  let stat;
  try {
    stat = await fsp.lstat(dir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await fsp.mkdir(dir, { mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink()) throw new KeyFileError('ssh_dir_symlink', dir);
  if (!stat.isDirectory()) throw new KeyFileError('ssh_dir_not_dir', dir);
  if (stat.uid !== files.uid) throw new KeyFileError('ssh_dir_owner', dir);
  if (stat.mode & 0o022) throw new KeyFileError('ssh_dir_mode', dir, `chmod go-w ${dir}`);
}

/** The file's content and mode, or null when it doesn't exist; stops on a link, another owner or a loose mode. */
export async function readKeyFile(files: KeyFiles): Promise<{ content: string; mode: number } | null> {
  const file = authorizedKeysPath(files);
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new KeyFileError('file_symlink', file);
  if (!stat.isFile()) throw new KeyFileError('file_not_regular', file);
  if (stat.uid !== files.uid) throw new KeyFileError('file_owner', file);
  if (stat.mode & 0o022) throw new KeyFileError('file_mode', file, `chmod go-w ${file}`);
  // O_NOFOLLOW: a link swapped in after the lstat isn't followed either.
  const handle = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  // Bytes that aren't UTF-8 wouldn't come back the same once decoded and
  // written again, and every check here compares decoded text: left alone.
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new KeyFileError('not_utf8', file);
  return { content, mode: stat.mode & 0o777 };
}

export type LockOptions = { waitMs?: number; staleMs?: number; pollMs?: number; now?: () => number };

function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Holds the write lock while `fn` runs. The lock is a file made with
 * O_CREAT|O_EXCL holding the pid and time; one whose holder is gone, or older
 * than `staleMs` (30 s: a write takes milliseconds), is left over from a run
 * that died and is cleared. Waits up to `waitMs` for a live holder.
 */
export async function withKeyFileLock<T>(files: KeyFiles, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { waitMs = 10_000, staleMs = 30_000, pollMs = 50, now = Date.now } = options;
  const lock = lockPath(files);
  const deadline = now() + waitMs;
  for (;;) {
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (handle) {
      try {
        await handle.writeFile(`${process.pid}\n${now()}\n`);
      } finally {
        await handle.close();
      }
      try {
        return await fn();
      } finally {
        await fsp.unlink(lock).catch(() => {});
      }
    }
    const held = await fsp.readFile(lock, 'utf8').catch(() => null);
    if (held !== null) {
      const [pid, at] = held.split('\n').map(Number);
      // A lock still being written (empty) is judged by its file's age: a run
      // that died between making it and writing it doesn't hold it forever.
      const madeAt = held === '' ? (await fsp.stat(lock).catch(() => null))?.mtimeMs : undefined;
      const stale = held === ''
        ? madeAt !== undefined && now() - madeAt > staleMs
        : !holderAlive(pid!) || !Number.isFinite(at) || now() - at! > staleMs;
      if (stale) {
        // Clear it only if it is still the same one (another waiter may have just done so and taken it).
        const again = await fsp.readFile(lock, 'utf8').catch(() => null);
        if (again === held) await fsp.unlink(lock).catch(() => {});
        continue;
      }
    }
    if (now() >= deadline) throw new KeyFileError('locked', lock);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Changes the file by `plan` (given its current lines), under the lock and
 * on what the file holds once the lock is held. Returns what the plan
 * returned; writes only when its edit changes something.
 */
export async function editKeyFile<T extends { edit: Edit }>(
  files: KeyFiles,
  plan: (lines: RawLine[]) => T,
  options: { lock?: LockOptions; ops?: KeyFileOps } = {},
): Promise<T> {
  await checkSshDir(files);
  return withKeyFileLock(files, async () => {
    const current = await readKeyFile(files);
    const before = current?.content ?? '';
    const planned = plan(splitLines(before));
    const { edit } = planned;
    if (edit.remove.length === 0 && edit.replace.size === 0 && edit.append.length === 0) return planned;
    const after = joinLines(applyEdit(splitLines(before), edit));
    if (!onlyEdited(before, after, edit)) throw new KeyFileError('verify_failed', authorizedKeysPath(files));
    await writeAtomically(files, current !== null, before, after, current?.mode ?? 0o600, options.ops ?? REAL_OPS, edit);
    return planned;
  }, options.lock);
}

async function writeAtomically(files: KeyFiles, existed: boolean, before: string, after: string, mode: number, ops: KeyFileOps, edit: Edit): Promise<void> {
  const file = authorizedKeysPath(files);
  const temp = path.join(files.sshDir, `.authorized_keys.hestia-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fsp.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try {
    try {
      // The umask may have taken bits off the mode open was given.
      await handle.chmod(mode);
      await handle.writeFile(after, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // What reached the disk, checked again against the old content.
    const written = await fsp.readFile(temp, 'utf8');
    if (written !== after || !onlyEdited(before, written, edit)) throw new KeyFileError('verify_failed', file);
    await ops.beforeRename?.(temp);
    // Someone else's editor (no lock) may have saved meanwhile: don't overwrite it.
    const still = await readKeyFile(files);
    if (existed ? still?.content !== before : still !== null) {
      throw new KeyFileError('changed_while_writing', file);
    }
    await ops.rename(temp, file);
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
  // The rename itself made durable; not every file system lets a directory be fsynced.
  const dir = await fsp.open(files.sshDir, constants.O_RDONLY).catch(() => null);
  if (dir) {
    await dir.sync().catch(() => {});
    await dir.close();
  }
}

/** Authorizes a key (§3.3), dropping expired one-time lines in the same write. */
export function authorizeKey(files: KeyFiles, key: PublicKey, port: number, comment: string, now: Date, options?: { lock?: LockOptions; ops?: KeyFileOps }): Promise<AuthorizeOutcome> {
  return editKeyFile(files, (lines) => {
    const outcome = planAuthorize(lines, key, port, comment);
    const expired = expiredOneTimeLines(lines, now).filter((index) => !outcome.edit.replace.has(index));
    return { ...outcome, edit: { ...outcome.edit, remove: [...new Set([...outcome.edit.remove, ...expired])] } };
  }, options);
}

/** Adds the one-time line, dropping expired ones left by earlier runs. */
export function addOneTimeLine(files: KeyFiles, line: string, now: Date, options?: { lock?: LockOptions; ops?: KeyFileOps }): Promise<{ edit: Edit; cleaned: number }> {
  return editKeyFile(files, (lines) => {
    const expired = expiredOneTimeLines(lines, now);
    return { edit: { remove: expired, replace: new Map(), append: [line] }, cleaned: expired.length };
  }, options);
}

/** Removes this run's one-time line (by its comment), and any expired ones. */
export function removeOneTimeLine(files: KeyFiles, comment: string, now: Date, options?: { lock?: LockOptions; ops?: KeyFileOps }): Promise<{ edit: Edit; removed: number }> {
  return editKeyFile(files, (lines) => {
    const remove = [...new Set([...linesWithComment(lines, comment), ...expiredOneTimeLines(lines, now)])].sort((a, b) => a - b);
    return { edit: { remove, replace: new Map(), append: [] }, removed: remove.length };
  }, options);
}
