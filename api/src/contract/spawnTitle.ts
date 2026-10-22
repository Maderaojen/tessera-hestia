// The title a delegation or a branch line gets when none is given (and the
// one the dialogs show, greyed, before it is started): the instruction's
// first clause, cut to about 16 Chinese characters. Shared with the app so
// both say the same.

/** How wide a default title may be, in columns: a CJK character is two, anything else one. */
export const SPAWN_TITLE_COLUMNS = 32;

// Ends a clause: Chinese and Western sentence or clause marks; a full stop
// only before a space or the end (not inside "v1.2" or a path).
const CLAUSE_END = /[。，；！？,;!?]|\.(?=\s|$)/u;
// A clause shorter than this says too little ("好", "OK"): the line is used.
const MIN_CLAUSE_COLUMNS = 4;

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

function columns(text: string): number {
  let total = 0;
  for (const char of text) total += WIDE.test(char) ? 2 : 1;
  return total;
}

/** `text` cut to `max` columns, with an ellipsis when it was cut. */
export function clipTitle(text: string, max = SPAWN_TITLE_COLUMNS): string {
  const trimmed = text.trim();
  if (columns(trimmed) <= max) return trimmed;
  let out = '';
  let used = 0;
  for (const char of trimmed) {
    const width = WIDE.test(char) ? 2 : 1;
    if (used + width > max - 1) break;
    out += char;
    used += width;
  }
  return `${out.trimEnd()}…`;
}

/** A title from an instruction or a task: its first line's first clause, cut short; '' for an empty one. */
export function spawnDefaultTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  const end = line.search(CLAUSE_END);
  const clause = end > 0 ? line.slice(0, end).trim() : line;
  return clipTitle(columns(clause) >= MIN_CLAUSE_COLUMNS ? clause : line);
}

/**
 * A branch line's title when none is given: from its first instruction,
 * else after the main line's — `branchOf` words that in the caller's
 * language ("… 的支線").
 */
export function forkDefaultTitle(instruction: string | null | undefined, parentTitle: string, branchOf: (title: string) => string): string {
  const fromInstruction = instruction?.trim() ? spawnDefaultTitle(instruction) : '';
  return fromInstruction || branchOf(clipTitle(parentTitle));
}
