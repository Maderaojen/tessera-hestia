import type { ConversationRecapEvent } from '../contract/recap.js';

// The `recap` events (contract ConversationRecapEvent), apart from
// session-stream.ts: its events all carry a session, which notifications.ts
// and routes/events.ts rely on, and clients from before the trash take an
// event they don't know for a deleted session. Only a stream that asked
// for them (`include=recap`, routes/events.ts) subscribes here.

const observers = new Set<(event: ConversationRecapEvent) => void>();

export function observeRecap(observer: (event: ConversationRecapEvent) => void): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export function publishRecap(event: ConversationRecapEvent): void {
  for (const observer of observers) observer(event);
}
