import { createHash } from 'node:crypto';
import type { InteractionScreen, PendingInteraction } from '../contract/sessions.js';
import type { PaneInteraction } from '../providers/types.js';

/**
 * Names one prompt as the user sees it: the same while only the cursor moves
 * or text is being typed on its free-text row; different once it is another
 * question, another step, or a box got ticked. An answer names the prompt it
 * answers, so it never lands on one that took its place.
 */
export function interactionId(screen: InteractionScreen): string {
  const shape = {
    kind: screen.kind,
    title: screen.title,
    detail: screen.detail,
    options: screen.options.map((option) => [option.number, option.freeText ? '' : option.label, option.checked]),
    steps: screen.steps,
  };
  return `pane:${createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16)}`;
}

/**
 * What the CLI waits on, from a prompt read on its pane: the screen, and
 * anything the transcript knows of it (older Claude Code versions write the
 * tool_use while the prompt waits; 2.1.284 doesn't).
 */
export function pendingFromPane(read: PaneInteraction, fromTranscript: PendingInteraction | null): PendingInteraction {
  return {
    kind: read.screen.kind === 'permission' ? 'tool_permission' : 'question',
    toolUseId: interactionId(read.screen),
    toolName: fromTranscript?.toolName ?? read.toolName,
    input: fromTranscript?.input ?? null,
    detectedAt: fromTranscript?.detectedAt ?? new Date().toISOString(),
    screen: read.screen,
  };
}

export type InteractionAnswer = {
  // The prompt answered (PendingInteraction.toolUseId of a screen).
  promptId: string;
  // The option's number, or 'next' for a multi-select question's Next row.
  option: number | 'next';
  // Typed on a free-text row, or sent along with an amendable permission.
  text?: string;
};

// answered: the keys were sent. not_shown: no prompt on screen. changed: the
// prompt on screen isn't the one answered. invalid: that option can't be
// answered that way. unsure: the cursor or the typed text couldn't be
// confirmed, so nothing was confirmed (typed text may be left on screen).
export type AnswerOutcome = 'answered' | 'not_shown' | 'changed' | 'invalid' | 'unsure';

export type InteractionTerminal = {
  capture(): Promise<string>;
  sendKey(key: 'Up' | 'Down' | 'Enter' | 'Tab'): Promise<void>;
  type(text: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
};

// Time for the CLI to redraw its prompt after a key.
const REDRAW_MS = 300;

const compact = (text: string) => text.replace(/\s+/g, '');

/**
 * Answers the prompt on screen, the way docs/reference/human-in-the-loop.md records
 * Claude Code 2.1.284 taking it: the cursor is moved with Up/Down, re-read
 * after every key, until it is positively on the option; then
 * - a free-text row: the text is typed, read back, and confirmed with Enter
 *   (on a multi-select question typing ticks it, and Enter would untick it,
 *   so none is sent there);
 * - a permission with a note: Tab opens the row for it, the note is typed,
 *   read back, and confirmed with Enter;
 * - anything else: Enter.
 * A line break can't be typed into a row (it would confirm it), so the text
 * is sent as one line.
 */
export async function answerInteraction(
  terminal: InteractionTerminal,
  read: (paneText: string) => PaneInteraction | null,
  answer: InteractionAnswer,
): Promise<AnswerOutcome> {
  const sleep = terminal.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let current = read(await terminal.capture());
  if (!current) return 'not_shown';
  const promptId = interactionId(current.screen);
  if (promptId !== answer.promptId) return 'changed';
  const target = current.screen.options.findIndex((option) => (answer.option === 'next' ? option.number === null : option.number === answer.option));
  const option = current.screen.options[target];
  if (!option) return 'invalid';
  const text = answer.text?.replace(/\s+/g, ' ').trim() ?? '';
  if (option.freeText ? !text : text && !option.amendable) return 'invalid';
  // Text already typed there (in the terminal) would run into ours.
  if (option.freeText && option.label !== '') return 'unsure';

  for (let moves = 0; current.cursor !== target; moves += 1) {
    if (current.cursor === null || moves > current.screen.options.length) return 'unsure';
    await terminal.sendKey(target < current.cursor ? 'Up' : 'Down');
    await sleep(REDRAW_MS);
    const next = read(await terminal.capture());
    if (!next || interactionId(next.screen) !== promptId) return 'unsure';
    current = next;
  }

  if (option.freeText || text) {
    if (!option.freeText) {
      await terminal.sendKey('Tab');
      await sleep(REDRAW_MS);
    }
    await terminal.type(text);
    await sleep(REDRAW_MS);
    const typed = read(await terminal.capture());
    const shown = typed?.cursor === target ? typed.screen.options[target]?.label : undefined;
    // A free-text row shows just the text; a permission row "Yes, <text>".
    const confirmed = shown !== undefined && (option.freeText ? compact(shown) === compact(text) : compact(shown).endsWith(compact(text)));
    if (!confirmed) return 'unsure';
    if (option.freeText && current.screen.multiSelect) return 'answered';
  }
  await terminal.sendKey('Enter');
  return 'answered';
}
