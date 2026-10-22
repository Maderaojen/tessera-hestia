import { stat } from 'node:fs/promises';
import { dialogueFile } from '../dialogue-store.js';
import { recapFilePath } from '../recap/store.js';
import * as registry from '../registry.js';
import { segmentRuntime } from '../runtimes/resolve.js';

// Where an upstream conversation can be read (ADR 0023): a branch line's
// main line, a delegation's delegating conversation, a handoff's
// conversation being left. Only where it is — never a copy of it.

/** Where the upstream conversation can be read, and its last request, for a brief. */
export type UpstreamLocations = {
  // Hestia's own archive of its turns (JSONL), when there is one.
  archiveFile: string | null;
  // The CLI's own transcript, and its format (Agy's is a SQLite database).
  transcriptFile: string | null;
  transcriptFormat: 'jsonl' | 'sqlite' | null;
  // Its recap, when it has one.
  recapFile: string | null;
  // The user's request in the last turn read.
  lastRequest: string | null;
};

export type UpstreamView = UpstreamLocations & {
  // Turns the conversation has now (0 when it isn't found).
  turns: number;
  // `Turn.index` of the last turn read; null when there is none.
  lastIndex: number | null;
};

const EMPTY: UpstreamView = { archiveFile: null, transcriptFile: null, transcriptFormat: null, recapFile: null, lastRequest: null, turns: 0, lastIndex: null };

const exists = (target: string) => stat(target).then(() => true, () => false);

/**
 * A session's conversation as a brief points at it, read up to its `upTo`th
 * turn (the last request and lastIndex are that turn's); null reads it all.
 */
export async function readUpstream(sessionId: string, conversationId: string, upTo: number | null): Promise<UpstreamView> {
  const session = await registry.getSession(sessionId);
  const conversation = session?.conversations?.find((item) => item.id === conversationId);
  if (!session || !conversation) return { ...EMPTY };
  const archive = conversation.provider ? dialogueFile(session, conversation) : null;
  const recap = conversation.provider
    ? recapFilePath({ sessionId, tmuxName: session.tmuxName, projectId: session.projectId, conversationId, provider: conversation.provider })
    : null;
  const transcript = conversation.transcript.state === 'resolved' ? conversation.transcript.file : null;
  const last = conversation.turns[Math.min(upTo ?? conversation.turns.length, conversation.turns.length) - 1];
  return {
    archiveFile: archive && await exists(archive) ? archive : null,
    transcriptFile: transcript,
    transcriptFormat: transcript ? (segmentRuntime(conversation)?.runtimeId === 'agy' ? 'sqlite' : 'jsonl') : null,
    recapFile: recap && await exists(recap) ? recap : null,
    lastRequest: last?.user.text ?? null,
    turns: conversation.turns.length,
    lastIndex: last?.index ?? null,
  };
}
