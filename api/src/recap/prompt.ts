import type { ConversationRecapItem } from '../contract/recap.js';
import type { Turn } from '../contract/sessions.js';
import { prompt } from '../i18n/index.js';
import { RECAP_TURN_ASSISTANT_CHARS, RECAP_TURN_USER_CHARS } from './constants.js';

// What one batch sends the model, on stdin: the instructions, the recap so far, and the batch's turns cut to
// size between two markers. The conversation is untrusted: it is data
// inside the markers, and can't close them early (see guardMarkers). The
// words are in i18n/prompts/recap.json (Chinese only: what the model is told).

export const RECAP_CONVERSATION_START = prompt('recap.marker.start');
export const RECAP_CONVERSATION_END = prompt('recap.marker.end');
export const RECAP_USER_OMITTED = prompt('recap.cut.user');
export const RECAP_ASSISTANT_OMITTED = prompt('recap.cut.assistant');

const INSTRUCTIONS = [
  prompt('recap.instructions.role'),
  prompt('recap.instructions.items'),
  prompt('recap.instructions.ids'),
  prompt('recap.instructions.turns'),
  prompt('recap.instructions.status'),
  prompt('recap.instructions.userStatus'),
  prompt('recap.instructions.output'),
].join('\n');

// '<' only ever appears inside a JSON string, where < means the same
// character; written that way, no text in the conversation can spell a
// marker.
function guardMarkers(json: string): string {
  return json.replaceAll('<<<', '\\u003c<<');
}

/** A turn's user text and follow-ups, cut together to RECAP_TURN_USER_CHARS characters. */
export function cutUserText(texts: string[], limit = RECAP_TURN_USER_CHARS): string[] {
  const out: string[] = [];
  let left = limit;
  for (const text of texts) {
    const chars = Array.from(text);
    if (chars.length <= left) {
      out.push(text);
      left -= chars.length;
      continue;
    }
    if (left > 0) out.push(chars.slice(0, left).join('') + RECAP_USER_OMITTED);
    else if (out.length > 0) out[out.length - 1] += RECAP_USER_OMITTED;
    else out.push(RECAP_USER_OMITTED);
    break;
  }
  return out;
}

/** A reply cut to RECAP_TURN_ASSISTANT_CHARS characters, keeping its start and its end. */
export function cutAssistantText(text: string, limit = RECAP_TURN_ASSISTANT_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${chars.slice(0, half).join('')}\n${RECAP_ASSISTANT_OMITTED}\n${chars.slice(chars.length - (limit - half)).join('')}`;
}

export function recapTurnInput(turn: Turn): { index: number; user: string; followUps: string[]; assistant: string } {
  const [user = '', ...followUps] = cutUserText([turn.user.text, ...(turn.followUps ?? []).map((message) => message.text)]);
  return { index: turn.index, user, followUps, assistant: cutAssistantText(turn.assistant.text) };
}

export function buildRecapPrompt({ previous, turns }: { previous: ConversationRecapItem[]; turns: Turn[] }): string {
  const list = previous.map(({ id, title, status, statusSource, turns: range }) => ({ id, title, status, statusSource, turns: range }));
  const conversation = turns.map((turn) => guardMarkers(JSON.stringify(recapTurnInput(turn))));
  return [
    INSTRUCTIONS,
    '',
    prompt('recap.prompt.previous', { list: guardMarkers(JSON.stringify(list)) }),
    '',
    RECAP_CONVERSATION_START,
    `[${conversation.join(',\n')}]`,
    RECAP_CONVERSATION_END,
    '',
  ].join('\n');
}
