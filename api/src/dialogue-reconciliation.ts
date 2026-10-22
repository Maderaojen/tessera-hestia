import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIALOGUE_ROOT, SESSION_PREFIX } from './config.js';
import { RFC4122_UUID } from './ids.js';
import * as registry from './registry.js';
import type { ManagedSession } from './types.js';

const PROVIDERS = new Set(['claude', 'codex', 'gemini']);

// A registered tmux name becomes a path component of the destination, so
// only the shape this tool gives its sessions is accepted: this install's
// prefix and nothing but letters, digits and '-' after it.
function isCanonicalTmuxName(name: string): boolean {
  return name.startsWith(SESSION_PREFIX) && /^[A-Za-z0-9-]+$/.test(name.slice(SESSION_PREFIX.length));
}

export type ReconciliationResult = {
  status: 'would_copy' | 'copied' | 'already_canonical' | 'rejected';
  source: string;
  destination?: string;
  reason?: string;
  sha256?: string;
  bytes?: number;
};

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function rejectSymlinkComponents(target: string, stopAt: string): Promise<boolean> {
  const relative = path.relative(stopAt, target);
  let current = stopAt;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

function parseAndValidateRows(bytes: Buffer, session: ManagedSession, conversationId: string, provider: string): string | null {
  const text = bytes.toString('utf8');
  const lines = text.split('\n').filter((line, index, all) => line.length > 0 || index < all.length - 1);
  if (!lines.length || lines.some((line) => !line.trim())) return 'archive is empty or contains a blank row';
  for (const line of lines) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { return 'archive contains malformed JSON'; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'archive row is not an object';
    const metadata = row as Record<string, unknown>;
    if (metadata.sessionId !== session.id
      || metadata.conversationId !== conversationId
      || metadata.provider !== provider
      || metadata.tmuxName !== session.tmuxName) {
      return 'archive row metadata does not match the registered owner';
    }
  }
  return null;
}

/**
 * Reconcile one explicitly named UUID-layout archive. Dry-run is the default;
 * this function never scans folders or touches the old provider/tmux flat layout.
 */
export async function reconcileDialogueArchive(
  sourcePath: string,
  options: { apply?: boolean; sessions?: ManagedSession[] } = {},
): Promise<ReconciliationResult> {
  const source = path.resolve(sourcePath);
  const root = path.resolve(DIALOGUE_ROOT);
  const rejected = (reason: string): ReconciliationResult => ({ status: 'rejected', source, reason });
  if (!isWithin(root, source)) return rejected('source must be inside the dialogue archive root');
  const relative = path.relative(root, source).split(path.sep);
  const [host, sessionId, filename, ...extra] = relative;
  const conversationId = filename?.endsWith('.jsonl') ? filename.slice(0, -'.jsonl'.length) : '';
  if (extra.length || relative.length !== 3 || host !== os.hostname() || !RFC4122_UUID.test(sessionId ?? '') || !RFC4122_UUID.test(conversationId)) {
    return rejected('source must be one UUID archive at <host>/<sessionId>/<conversationId>.jsonl');
  }
  if (await rejectSymlinkComponents(source, root)) return rejected('symlinks are not allowed in source path');
  let sourceStat;
  try { sourceStat = await lstat(source); } catch { return rejected('source file does not exist'); }
  if (!sourceStat.isFile()) return rejected('source is not a regular file');

  const sessions = options.sessions ?? await registry.listAllSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return rejected('session is not present in the registry');
  const conversation = session.conversations?.find((candidate) => candidate.id === conversationId);
  if (!conversation?.provider || !PROVIDERS.has(conversation.provider)) return rejected('conversation has no registered provider identity');
  if (!isCanonicalTmuxName(session.tmuxName)) return rejected('registered tmux name is not a canonical Hestia name');

  let bytes: Buffer;
  try { bytes = await readFile(source); } catch { return rejected('source could not be read'); }
  const rowError = parseAndValidateRows(bytes, session, conversationId, conversation.provider);
  if (rowError) return rejected(rowError);

  const destination = path.join(root, host!, conversation.provider, session.tmuxName, `${conversationId}.jsonl`);
  if (await rejectSymlinkComponents(destination, root)) return { ...rejected('symlinks are not allowed in destination path'), destination };
  const sha256 = digest(bytes);
  try {
    const existing = await readFile(destination);
    if (existing.equals(bytes) && digest(existing) === sha256) {
      return { status: 'already_canonical', source, destination, sha256, bytes: bytes.length };
    }
    return { ...rejected('canonical destination exists with different content'), destination };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ...rejected('canonical destination could not be read'), destination };
  }
  if (!options.apply) return { status: 'would_copy', source, destination, sha256, bytes: bytes.length };

  // Create parent directories one component at a time, refusing symlink
  // components. A sibling temporary file is verified before a no-clobber
  // hard-link publishes it at the canonical path.
  let current = root;
  for (const component of [host!, conversation.provider, session.tmuxName]) {
    current = path.join(current, component);
    try { await mkdir(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ...rejected('could not create canonical directory'), destination };
    }
    const st = await lstat(current).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) return { ...rejected('canonical directory is not a real directory'), destination };
  }
  const temp = path.join(path.dirname(destination), `.${conversationId}.${process.pid}.${Date.now()}.reconcile-tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    const copied = await readFile(temp);
    const afterSource = await readFile(source);
    if (!copied.equals(bytes) || digest(copied) !== sha256 || !afterSource.equals(bytes) || digest(afterSource) !== sha256) {
      return { ...rejected('source/copy hash or byte verification failed'), destination };
    }
    try {
      await link(temp, destination);
      return { status: 'copied', source, destination, sha256, bytes: bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ...rejected('could not publish canonical copy'), destination };
      const existing = await readFile(destination);
      return existing.equals(bytes) && digest(existing) === sha256
        ? { status: 'already_canonical', source, destination, sha256, bytes: bytes.length }
        : { ...rejected('canonical destination appeared with different content'), destination };
    }
  } catch {
    return { ...rejected('copy or verification failed'), destination };
  } finally {
    await unlink(temp).catch(() => {});
  }
}
