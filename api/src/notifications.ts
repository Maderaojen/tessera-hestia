import path from 'node:path';
import * as push from './push.js';
import { getRuntimeDriver, isRuntimeId } from './runtimes/index.js';
import * as sessionStream from './session-stream.js';
import type { PublicManagedSession } from './session-dto.js';
import { t } from './i18n/index.js';

// What's worth a notification when the app isn't in front of you: a reply
// that finished, and a CLI waiting for you to confirm something. Read off
// the session updates every change already publishes; the first update seen
// for a session only sets its baseline.

type Seen = { phase: PublicManagedSession['turnPhase']; activity: PublicManagedSession['activity'] };
const seen = new Map<string, Seen>();

export function titleOf(session: Pick<PublicManagedSession, 'alias' | 'cwd'>): string {
  return session.alias ?? (path.basename(session.cwd) || session.cwd);
}

export function messageFor(previous: Seen | undefined, session: PublicManagedSession): push.PushMessage | null {
  if (!previous) return null;
  const runtime = isRuntimeId(session.runtimeId) ? getRuntimeDriver(session.runtimeId) : undefined;
  const cli = runtime?.label ?? session.provider ?? 'CLI';
  const base = { title: titleOf(session), url: `/session/${session.id}` };
  if (session.activity === 'awaiting_approval' && previous.activity !== 'awaiting_approval') {
    return { ...base, body: t('push.session.awaitingApproval', { cli }), tag: `${session.id}:approval` };
  }
  const finished = previous.phase === 'replying' && session.turnPhase === 'idle'
    && session.activity !== 'ended' && session.activity !== 'starting';
  if (finished) return { ...base, body: t('push.session.replied', { cli }), tag: `${session.id}:reply` };
  return null;
}

export function startNotifications(send: (message: push.PushMessage) => Promise<void> = push.sendToAll): () => void {
  return sessionStream.observeAll((sessionId, event) => {
    if (event.type === 'deleted') {
      seen.delete(sessionId);
      return;
    }
    const { session } = event;
    const message = messageFor(seen.get(sessionId), session);
    seen.set(sessionId, { phase: session.turnPhase, activity: session.activity });
    if (message) void send(message).catch((err) => console.warn('[push] failed', err));
  });
}
