import type { MenuReading, StartupChoice, StartupPromptReading } from './types.js';

/**
 * What one CLI's menu looks like on screen: the workspace-trust menu every
 * CLI shows before its first input, and Codex's update menu. Everything a
 * CLI version changes about a menu belongs in its spec (next to its
 * driver); how any such menu is read and answered is shared, below.
 */
export type MenuSpec<C extends string> = {
  // The question the menu sits under. Only the last one on screen is live:
  // an earlier launch that was turned away can leave its prompt above.
  question: RegExp;
  // Option labels exactly as shown, without the cursor mark or "N." number.
  // A label may go on with a parenthesized note ("Update now (runs …)").
  options: readonly { choice: C; labels: readonly string[] }[];
  // Marks drawn before the option under the cursor.
  cursor: readonly string[];
  // The key-hint line(s) drawn under the options.
  hints: RegExp;
};

/** The two-way workspace-trust menu, as each driver writes it. */
export type TrustMenuSpec = {
  question: RegExp;
  trust: readonly string[];
  decline: readonly string[];
  cursor: readonly string[];
  hints: RegExp;
};

// A status bar some CLIs draw at the bottom while the menu is up (Agy
// 1.2.12). It is right-aligned, while every CLI's own screen after the menu
// (input box, rules, a shell prompt) starts at the left edge.
const RIGHT_ALIGNED = /^ {10,}\S/;

type OptionLine<C extends string> = { choice: C; underCursor: boolean };

function readOption<C extends string>(line: string, spec: MenuSpec<C>): OptionLine<C> | null {
  let rest = line.trim();
  const mark = spec.cursor.find((candidate) => rest.startsWith(candidate));
  if (mark) rest = rest.slice(mark.length).trimStart();
  rest = rest.replace(/^\d+\.\s*/, '');
  const option = spec.options.find((candidate) => candidate.labels.some((label) => rest === label || rest.startsWith(`${label} (`)));
  return option ? { choice: option.choice, underCursor: !!mark } : null;
}

/**
 * Reads a menu from a pane capture: null unless every one of its options is
 * there and the menu is what the screen currently ends with. `selected` is
 * null when the cursor can't be placed on exactly one option.
 */
export function readMenu<C extends string>(paneText: string, spec: MenuSpec<C>): MenuReading<C> | null {
  const questions = [...paneText.matchAll(new RegExp(spec.question.source, `${spec.question.flags.replace('g', '')}g`))];
  const last = questions.at(-1);
  if (last?.index === undefined) return null;
  const lines = paneText.slice(last.index).split('\n');
  const parsed = lines.map((line) => readOption(line, spec));
  const options = parsed.filter((option): option is OptionLine<C> => option !== null);
  const order = [...new Set(options.map((option) => option.choice))];
  if (order.length !== new Set(spec.options.map((option) => option.choice)).size) return null;
  // Still what the screen ends with: once answered, the CLI's own screen
  // (or the shell, after declining) comes below it.
  let lastOption = parsed.length - 1;
  while (parsed[lastOption] === null) lastOption -= 1;
  const below = lines.slice(lastOption + 1);
  if (!below.every((line) => line.trim() === '' || spec.hints.test(line) || RIGHT_ALIGNED.test(line))) return null;
  const marked = new Set(options.filter((option) => option.underCursor).map((option) => option.choice));
  const selected = marked.size === 1 ? [...marked][0]! : null;
  return { selected, options: order };
}

/**
 * Reads a two-way trust menu from a pane capture: null unless the menu is
 * what the screen currently ends with. `selected` is null when the cursor
 * can't be placed on exactly one of the two answers.
 */
export function readTrustMenu(paneText: string, spec: TrustMenuSpec): StartupPromptReading | null {
  const reading = readMenu<StartupChoice>(paneText, {
    question: spec.question,
    options: [{ choice: 'trust', labels: spec.trust }, { choice: 'decline', labels: spec.decline }],
    cursor: spec.cursor,
    hints: spec.hints,
  });
  return reading ? { kind: 'workspace_trust', selected: reading.selected, options: reading.options } : null;
}

export type MenuTerminal = {
  capture(): Promise<string>;
  sendKey(key: 'Up' | 'Down' | 'Enter'): Promise<void>;
  sleep?(ms: number): Promise<void>;
};

export type StartupAnswer = 'answered' | 'not_shown' | 'unsure';

// Time for the CLI to redraw its menu after a navigation key.
const MENU_REDRAW_MS = 300;

/**
 * Selects `choice` in a menu and confirms it. The cursor is re-read before
 * every key (some menus wrap, some don't), moved toward the wanted option,
 * and Enter is sent only once that option is positively under it.
 * 'unsure' means nothing was confirmed.
 */
export async function answerMenu<C extends string>(
  terminal: MenuTerminal,
  read: (paneText: string) => { selected: C | null; options?: C[] } | null,
  choice: C,
): Promise<StartupAnswer> {
  const sleep = terminal.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let moves = 0; ; moves += 1) {
    const reading = read(await terminal.capture());
    if (!reading) return moves === 0 ? 'not_shown' : 'unsure';
    if (reading.selected === null) return 'unsure';
    if (reading.selected === choice) {
      await terminal.sendKey('Enter');
      return 'answered';
    }
    const order = reading.options ?? [];
    // One move per option is enough for any menu; one more allows a redraw.
    if (moves >= Math.max(order.length, 2)) return 'unsure';
    const from = order.indexOf(reading.selected);
    const to = order.indexOf(choice);
    await terminal.sendKey(from !== -1 && to !== -1 && to < from ? 'Up' : 'Down');
    await sleep(MENU_REDRAW_MS);
  }
}

/** Selects `choice` in the start-up trust prompt and confirms it (answerMenu). */
export function answerTrustMenu(
  terminal: MenuTerminal,
  read: (paneText: string) => StartupPromptReading | null,
  choice: StartupChoice,
): Promise<StartupAnswer> {
  return answerMenu(terminal, read, choice);
}
