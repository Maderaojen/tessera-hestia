import type { PublicManagedSession } from './session-dto.js';

// Every session mutation flows through registry.updateSession — that's the
// one place this gets published from, so unlike pane-stream.ts there's
// nothing to deduplicate or share: the "poll" already happened (it's
// whatever caused the update), this just fans the result out to whoever is
// listening for this session id.
// `restored`: taken back out of the trash (an update a list that saw the
// session deleted must not ignore).
export type SessionEvent =
  | { type: 'update'; session: PublicManagedSession }
  | { type: 'restored'; session: PublicManagedSession }
  | { type: 'deleted' };

const listeners = new Map<string, Set<(event: SessionEvent) => void>>();
// Listeners to every session's events (notifications.ts), not just one.
const observers = new Set<(sessionId: string, event: SessionEvent) => void>();

export function observeAll(observer: (sessionId: string, event: SessionEvent) => void): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export function subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(sessionId);
  };
}

export function publish(sessionId: string, event: SessionEvent): void {
  for (const observer of observers) observer(sessionId, event);
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const listener of set) listener(event);
}
