import { assembleSourcedTurns, type SourcedMsg } from '../providers/msg.js';
import { countsOf, partsOf } from './classify.js';
import type { ProcessEvent, ProcessTurn } from './types.js';

export type EventsFor = (
  from: number,
  to: number,
  textSrcs: ReadonlySet<number>,
  texts: Map<number, { text: string; at: string | null }>,
) => ProcessEvent[];

// Turns exactly as the turn parser makes them (assembleSourcedTurns over the
// same messages), each with the records from its user message up to the
// next one — its start and end — read into events.
export function buildTurns(recordCount: number, messages: SourcedMsg[], eventsFor: EventsFor): ProcessTurn[] {
  // Where each new turn could start: a user message that isn't a follow-up
  // joining the turn in progress (the same rule assembleSourcedTurns uses).
  const starts: number[] = [];
  let sawUser = false;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.followUp && sawUser) continue;
    sawUser = true;
    starts.push(message.src);
  }
  const bySrc = new Map(messages.map((message) => [message.src, message]));
  return assembleSourcedTurns(messages).map(({ turn, userSrc, assistantSrcs }) => {
    const endSrc = starts.find((start) => start > userSrc) ?? recordCount;
    const texts = new Map(assistantSrcs.map((src) => [src, { text: bySrc.get(src)!.text, at: bySrc.get(src)!.ts }]));
    const events = eventsFor(userSrc, endSrc, new Set(assistantSrcs), texts);
    // Codex labels its texts itself; the messages carry that label.
    for (const event of events) {
      if (event.type !== 'text') continue;
      const phase = (bySrc.get(event.src) as SourcedMsg & { phase?: string } | undefined)?.phase;
      if (phase) event.phase = phase;
    }
    return {
      userSrc,
      endSrc,
      user: { text: turn.user.text, at: turn.user.at },
      assistantText: turn.assistant.text,
      interrupted: turn.assistant.interrupted === true,
      events,
      parts: partsOf(events),
      counts: countsOf(events),
    };
  });
}

// The newest user message onwards, whether or not it has become a turn yet
// (a turn needs some reply text; until then there is only what the CLI is
// doing): what the chat's waiting bubble shows. Null when there is no user
// message at all.
export function openTail(recordCount: number, messages: SourcedMsg[], eventsFor: EventsFor): ProcessTurn | null {
  let start: SourcedMsg | null = null;
  let sawUser = false;
  for (const message of messages) {
    if (message.role !== 'user' || (message.followUp && sawUser)) continue;
    sawUser = true;
    start = message;
  }
  if (!start) return null;
  const replies = messages.filter((message) => message.src > start.src && message.role === 'assistant' && !message.interrupted);
  const texts = new Map(replies.map((message) => [message.src, { text: message.text, at: message.ts }]));
  const events = eventsFor(start.src, recordCount, new Set(texts.keys()), texts);
  return {
    userSrc: start.src,
    endSrc: recordCount,
    user: { text: start.text, at: start.ts },
    assistantText: replies.map((message) => message.text).join('\n\n'),
    interrupted: messages.some((message) => message.src > start.src && message.interrupted),
    events,
    parts: partsOf(events),
    counts: countsOf(events),
  };
}

// Everything as one turn with no user message: a subagent whose tasks
// don't arrive as user messages (a Codex child's are encrypted messages
// from its parent). Null when it said nothing and did nothing.
export function wholeTurn(recordCount: number, messages: SourcedMsg[], eventsFor: EventsFor): ProcessTurn | null {
  const replies = messages.filter((message) => message.role === 'assistant' && !message.interrupted);
  const texts = new Map(replies.map((message) => [message.src, { text: message.text, at: message.ts }]));
  const events = eventsFor(0, recordCount, new Set(texts.keys()), texts);
  if (events.length === 0) return null;
  return {
    userSrc: 0,
    endSrc: recordCount,
    user: { text: '', at: null },
    assistantText: replies.map((message) => message.text).join('\n\n'),
    interrupted: messages.some((message) => message.interrupted),
    events,
    parts: partsOf(events),
    counts: countsOf(events),
  };
}
