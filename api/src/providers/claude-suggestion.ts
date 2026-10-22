// Claude Code's prompt suggestion: after a reply it may guess the user's
// next message and draw it inside the empty input box as dim ghost text.
// Verified against Claude Code 2.1.296 by capturing real panes with
// `tmux capture-pane -e` (api/test/fixtures/cli-suggestion):
//
//   ────────────────────────────            the box's top rule
//   ❯\u00a0\e[2mrun hello.py\e[0m           the suggestion, SGR 2 (dim)
//   ────────────────────────────            the closing rule
//
// Without `-e` it reads "❯ run hello.py", exactly like text the user typed
// there, so it can only be told apart from a capture that keeps attributes.
// Typed text is drawn without SGR 2; so is the part a user typed before
// Claude's own dim completion of a slash command ("/com" + dim "pact"),
// which is why any non-dim text means "not a suggestion". Before a
// conversation's first message the same spot holds a dim placeholder
// (`Try "how do I log an error?"`), which isn't one either.
//
// Accepting it in the CLI (Tab or →) only fills the input box; Enter on the
// empty box doesn't submit it; typing replaces it (2.1.296, isolated tmux).
// The app never presses any of those: it offers the text in its own
// composer instead.

// Only SGR (…m) moves the dim state; other CSI sequences and OSC strings
// (hyperlinks) are dropped. ESC is matched as \x1b.
// eslint-disable-next-line no-control-regex -- the real escape bytes are what this matches.
const ESCAPE = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex -- see ESCAPE.
const ANY_ESCAPE = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const RULE = /^─{20,}(?: .+ ─+)?\s*$/;
const PROMPT = /^❯(?:[ \u00a0]|$)/;
// Placeholders Claude Code draws dim in the same spot (2.1.296 bundle:
// `Try "${example}"`, and the queued-message hints).
const PLACEHOLDERS = [/^Try ".*"$/, /^Press (?:up|Enter) to /];
const MAX_LENGTH = 2000;

type Run = { text: string; dim: boolean };

/** The pane with every escape sequence removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANY_ESCAPE, '');
}

// The dim state at the start of `line` is carried in from the line above
// (a capture can leave a run open across a newline), hence `dimAtStart`.
function runsOf(line: string, dimAtStart: boolean): { runs: Run[]; dimAtEnd: boolean } {
  const runs: Run[] = [];
  let dim = dimAtStart;
  let last = 0;
  for (const match of line.matchAll(ESCAPE)) {
    if (match.index > last) runs.push({ text: line.slice(last, match.index), dim });
    last = match.index + match[0].length;
    if (match[2] === 'm') dim = nextDim(dim, match[1] ?? '');
  }
  if (last < line.length) runs.push({ text: line.slice(last), dim });
  return { runs, dimAtEnd: dim };
}

function nextDim(dim: boolean, params: string): boolean {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((code) => (code === '' ? 0 : Number(code)));
  let result = dim;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 38 || code === 48 || code === 58) {
      // Extended colour: 5;n or 2;r;g;b — its numbers are not attributes.
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 1;
      continue;
    }
    if (code === 0 || code === 22) result = false;
    else if (code === 2) result = true;
  }
  return result;
}

// A dim-only line's text, '' for a blank one, null as soon as anything on
// it isn't dim.
function dimText(runs: Run[]): string | null {
  let text = '';
  for (const run of runs) {
    if (!run.dim && run.text.replace(/[\s\u00a0]/g, '') !== '') return null;
    if (run.dim) text += run.text;
  }
  return text;
}

const WIDE = /[⺀-鿿豈-﫿＀-￯]/;

/**
 * The suggestion Claude Code shows in its empty input box, from a capture
 * taken with attributes (`capture-pane -e`); null when the box is empty,
 * holds typed text (even partly), holds a placeholder, or isn't on screen.
 */
export function readClaudeSuggestion(ansiPane: string): string | null {
  const raw = ansiPane.split('\n');
  const plain = raw.map((line) => stripAnsi(line).replace(/\s+$/, ''));
  // The input box is the last "❯" line with a rule right above it and one
  // somewhere below (claude.ts paneShowsIdle reads it the same way).
  let at = -1;
  for (let i = plain.length - 1; i > 0; i -= 1) {
    if (PROMPT.test(plain[i]!) && RULE.test(plain[i - 1]!) && plain.slice(i + 1).some((line) => RULE.test(line))) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  const closing = plain.findIndex((line, i) => i > at && RULE.test(line));

  let dim = runsOf(raw[at - 1]!, false).dimAtEnd;
  const parts: string[] = [];
  for (let i = at; i < closing; i += 1) {
    const { runs, dimAtEnd } = runsOf(raw[i]!, dim);
    dim = dimAtEnd;
    if (i === at) {
      // Drop the marker and the one space after it, whatever their state.
      const marker = runs.findIndex((run) => run.text.includes('❯'));
      if (marker === -1) return null;
      const rest = runs[marker]!.text.slice(runs[marker]!.text.indexOf('❯') + 1).replace(/^[ \u00a0]/, '');
      runs.splice(0, marker + 1, ...(rest ? [{ text: rest, dim: runs[marker]!.dim }] : []));
    }
    const text = dimText(runs);
    if (text === null) return null;
    if (text.trim()) parts.push(text.replace(/\u00a0/g, ' ').trim());
  }
  // A long one wraps inside the box: CJK text mid-sentence, anything else
  // at a space (unverified: no wrapped suggestion has been captured yet).
  const suggestion = parts.reduce((joined, part) => {
    if (!joined) return part;
    return WIDE.test(joined.at(-1)!) && WIDE.test(part[0]!) ? joined + part : `${joined} ${part}`;
  }, '');
  if (!suggestion || PLACEHOLDERS.some((pattern) => pattern.test(suggestion))) return null;
  return suggestion.slice(0, MAX_LENGTH);
}
