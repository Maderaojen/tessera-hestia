import { createHash } from 'node:crypto';
import type { TextRange } from './contract/attachments.js';

// Text the user pasted into a message as a block (the composer's pasted-text
// attachment, capability composer_attachments): the app sends the message's
// whole text and says which parts were pasted; a conversation remembers a
// mark of each (never the text itself — the transcript already has it), and
// the turns as sent find them again in the messages the CLI wrote down, so
// the chat can show each as one block rather than all of it.

/** What a conversation keeps of one pasted part. */
export type PastedTextMark = { head: string; length: number; hash: string };

const HEAD_LENGTH = 32;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/** The marks of `ranges` in `text`; a range outside it, or empty, is left out. */
export function pastedTextMarks(text: string, ranges: readonly TextRange[]): PastedTextMark[] {
  return ranges
    .filter(({ start, end }) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length)
    .map(({ start, end }) => {
      const part = text.slice(start, end);
      return { head: part.slice(0, HEAD_LENGTH), length: part.length, hash: digest(part) };
    });
}

/**
 * Where the pasted parts `marks` remember sit in `text`, in order, none
 * overlapping. A part the CLI wrote down any differently isn't found, and
 * shows as text.
 */
export function pastedTextRanges(text: string, marks: readonly PastedTextMark[]): TextRange[] {
  const found: TextRange[] = [];
  for (const mark of marks) {
    if (mark.length > text.length) continue;
    for (let start = text.indexOf(mark.head); start !== -1; start = text.indexOf(mark.head, start + 1)) {
      const end = start + mark.length;
      if (end > text.length) break;
      if (found.some((range) => start < range.end && end > range.start)) continue;
      if (digest(text.slice(start, end)) !== mark.hash) continue;
      found.push({ start, end });
      break;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
