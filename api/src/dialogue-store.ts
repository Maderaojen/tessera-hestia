import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIALOGUE_ROOT } from './config.js';
import type { ConversationSegment, ManagedSession, Turn } from './types.js';

// The host an archive is filed under (and names in its rows).
export const ARCHIVE_HOST = os.hostname();
const HOST = ARCHIVE_HOST;

// New archives are partitioned by managed tmux and conversation. Legacy
// provider/tmux JSONL files are intentionally left untouched. A
// conversation's other files (its recap, recap/store.ts) sit beside its
// archive under the same name with their own extension.
export function dialogueFile(
  session: Pick<ManagedSession, 'tmuxName'>,
  conversation: Pick<ConversationSegment, 'id' | 'provider'>,
  extension = '.jsonl',
): string {
  if (!conversation.provider) throw new Error('Cannot archive a turn without an immutable conversation provider');
  return path.join(DIALOGUE_ROOT, HOST, conversation.provider, encodeURIComponent(session.tmuxName), `${encodeURIComponent(conversation.id)}${extension}`);
}

/**
 * The archive row's own shape. Rows without it (version 1) were written
 * before rows described themselves; a file can hold both, since a row is
 * only rewritten when its turn changes.
 */
export const ARCHIVE_VERSION = 2;

// What makes a row traceable on its own, after a rename or a move: ids
// first (host, project, the CLI's own session id, runtime, launch profile),
// and the transcript path only as a hint of where it was last seen —
// paths are resolved again when used, ids are what identify.
function archiveIdentity(session: ManagedSession, conversation: ConversationSegment) {
  return {
    archiveVersion: ARCHIVE_VERSION,
    host: HOST,
    projectId: session.projectId ?? null,
    providerSessionId: conversation.providerSessionId ?? null,
    runtimeId: conversation.runtimeId ?? conversation.launchProfile?.runtimeId ?? null,
    launchProfileId: conversation.launchProfile?.id ?? null,
    transcriptFile: conversation.transcript?.file ?? null,
  };
}

const appendQueues = new Map<string, Promise<void>>();

// Appends the turn, or — when this conversation already has a record at the
// same index — replaces that record if its content changed (a stored reply
// that kept growing; see sync/turns.ts diffTurns). An identical record is left
// as is, so re-archiving the same turn stays a no-op. A replacement rewrites
// the file via a temp file + rename so a crash never leaves it half-written.
export async function upsertTurn(session: ManagedSession, conversation: ConversationSegment, turn: Turn): Promise<void> {
  const file = dialogueFile(session, conversation);
  const record = {
    ...turn,
    sessionId: session.id,
    conversationId: conversation.id,
    tmuxName: session.tmuxName,
    cwd: session.cwd,
    provider: conversation.provider,
    ...archiveIdentity(session, conversation),
  };
  const serialized = JSON.stringify(record);
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const write = previous.then(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let old = '';
    let exists = false;
    try { old = await readFile(file, 'utf-8'); exists = true; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (exists) await chmod(file, 0o600);
    const lines = old.split('\n');
    const existing = lines.findIndex((line) => {
      if (!line) return false;
      try {
        const parsed = JSON.parse(line) as { conversationId?: string; index?: number };
        return parsed.conversationId === conversation.id && parsed.index === turn.index;
      } catch { return false; }
    });
    if (existing === -1) {
      await appendFile(file, `${serialized}\n`, { encoding: 'utf-8', mode: 0o600 });
      return;
    }
    if (lines[existing] === serialized) return;
    lines[existing] = serialized;
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, lines.join('\n'), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  });
  appendQueues.set(file, write.catch(() => {}));
  await write;
}
