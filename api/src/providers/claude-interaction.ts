import type { InteractionOption } from '../contract/sessions.js';
import type { PaneInteraction } from './types.js';

// Verified against Claude Code 2.1.284 by capturing real panes
// (test/fixtures/interaction-prompts, docs/reference/human-in-the-loop.md). Only the
// prompt the screen ends with is live: an answered one scrolls up with the
// CLI's own output below it.
//
// Permission prompt:
//   ● Bash(touch …)                      the tool, above the prompt's rule
//   ────────
//    Bash command                        what the prompt is about
//      touch /tmp/b.txt
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. Yes, and don't ask again for … (long rows wrap, indented)
//      3. No
//    Esc to cancel · Tab to amend
//
// Question (AskUserQuestion); a single one has " ☐ <header>" and no arrows,
// a multi-select one has "[ ]"/"[✔]" boxes and a "Next" row:
//   ←  ☐ 水果  ☒ 顏色  ✔ Submit  →
//   你喜歡哪種水果？
//   ❯ 1. 蘋果
//        清脆香甜                         the option's description
//     2. Type something.                 the free-text row (its text once typed)
//   ────────
//     3. Chat about this
//   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// Review of several answers, before they are submitted:
//   Review your answers
//    ● 你喜歡哪種水果？
//      → 芭樂
//   Ready to submit your answers?
//   ❯ 1. Submit answers
//     2. Cancel

const RULE = /^\s*─{8,}\s*$/;
const DASHED = /^\s*╌{8,}\s*$/;
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/;
const NEXT_ROW = /^\s*(❯\s*)?Next\s*$/;
const CHECKBOX = /^\[( |✔)\]\s*(.*)$/;
const PERMISSION_TITLE = /^\s*Do you want to /;
const PERMISSION_FOOTER = /^\s*Esc to cancel\b/;
const QUESTION_FOOTER = /^\s*Enter to select · /;
const STEP_LINE = /^\s*(?:←\s+)?[☐☒]\s/;
const TOOL_LINE = /^●\s+([\w.:-]+)\(/;
const FREE_TEXT_PLACEHOLDER = /^Type something\.?$/;
const REVIEW_TITLE = /^\s*Review your answers\s*$/;
const REVIEW_QUESTION = /^\s*Ready to submit your answers\?\s*$/;

function trimLines(paneText: string): string[] {
  const lines = paneText.split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

type RawOption = { number: number | null; text: string; underCursor: boolean; indent: number; more: string[] };

/**
 * Reads option rows from `lines`: a numbered row (or a "Next" row), then its
 * continuation lines, indented deeper than the row's number. Null when a
 * line is neither.
 */
function readOptions(lines: string[]): RawOption[] | null {
  const options: RawOption[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const numbered = OPTION.exec(line);
    if (numbered) {
      options.push({ number: Number(numbered[2]), text: numbered[3]!.trim(), underCursor: !!numbered[1], indent: indentOf(line), more: [] });
      continue;
    }
    const next = NEXT_ROW.exec(line);
    if (next) {
      options.push({ number: null, text: 'Next', underCursor: !!next[1], indent: indentOf(line), more: [] });
      continue;
    }
    const last = options.at(-1);
    if (!last || indentOf(line) <= last.indent) return null;
    last.more.push(line.trim());
  }
  return options;
}

// Rejoins a row the pane wrapped: CJK text wraps mid-sentence with no space
// to restore, anything else at a space.
const WIDE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
function joinWrapped(parts: string[]): string {
  return parts.reduce((joined, part) => {
    if (!joined) return part;
    return WIDE.test(joined.at(-1)!) && WIDE.test(part[0]!) ? joined + part : `${joined} ${part}`;
  }, '');
}

// The tip Claude Code shows over some prompts ("Tip: auto mode handles these
// prompts for you — …"), wrapped at the same indent, isn't about the prompt.
function withoutTip(lines: string[]): string[] {
  const tipAt = lines.findIndex((line) => /^\s*Tip:/.test(line));
  if (tipAt === -1) return lines;
  let end = tipAt + 1;
  while (end < lines.length && indentOf(lines[end]!) === indentOf(lines[tipAt]!)) end += 1;
  return [...lines.slice(0, tipAt), ...lines.slice(end)];
}

function cursorOf(options: RawOption[]): number | null {
  const marked = options.flatMap((option, index) => (option.underCursor ? [index] : []));
  return marked.length === 1 ? marked[0]! : null;
}

function lastIndex(lines: string[], test: (line: string) => boolean, before = lines.length): number {
  for (let index = before - 1; index >= 0; index -= 1) if (test(lines[index]!)) return index;
  return -1;
}

// The key hints under a prompt: its last lines. On a narrow pane they wrap
// ("… ctrl+g to edit in" / "Vim · Esc to cancel"), so the hints start at
// most a couple of lines up; the lines below that start are their wrap.
const FOOTER_WRAP_LINES = 2;
function footerAt(lines: string[], start: RegExp): number {
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 1 - FOOTER_WRAP_LINES); index -= 1) {
    if (start.test(lines[index]!)) {
      const wrap = lines.slice(index + 1);
      return wrap.every((line) => !OPTION.test(line) && !RULE.test(line)) ? index : -1;
    }
  }
  return -1;
}

function readPermission(lines: string[]): PaneInteraction | null {
  const footer = footerAt(lines, PERMISSION_FOOTER);
  if (footer === -1) return null;
  const titleAt = lastIndex(lines, (line) => PERMISSION_TITLE.test(line), footer);
  if (titleAt === -1) return null;
  // A long title (a file name) wraps: it ends at the line ending in "?".
  let titleEnd = titleAt;
  while (titleEnd < footer && !lines[titleEnd]!.trimEnd().endsWith('?')) titleEnd += 1;
  const raw = readOptions(lines.slice(titleEnd + 1, footer));
  if (!raw || raw.length < 2 || raw.some((option) => option.number === null)) return null;
  const amendable = /Tab to amend/.test(lines.slice(footer).join(' '));
  const options: InteractionOption[] = raw.map((option, index) => {
    const label = joinWrapped([option.text, ...option.more]);
    // Verified: Tab turns "1. Yes" and the closing "N. No" into a row a note
    // can be typed on. Rows in between (don't ask again, switch mode) weren't.
    const canAmend = amendable && ((index === 0 && label === 'Yes') || (index === raw.length - 1 && label === 'No'));
    return { number: option.number, label, description: null, freeText: false, amendable: canAmend, checked: null };
  });
  const ruleAt = lastIndex(lines, (line) => RULE.test(line), titleAt);
  const detail = withoutTip(lines.slice(ruleAt + 1, titleAt).filter((line) => line.trim() !== '' && !DASHED.test(line)))
    .map((line) => line.trim());
  const toolAt = ruleAt === -1 ? -1 : lastIndex(lines, (line) => TOOL_LINE.test(line), ruleAt);
  const toolName = toolAt === -1 ? (detail[0] ?? 'tool') : TOOL_LINE.exec(lines[toolAt]!)![1]!;
  return {
    screen: {
      kind: 'permission',
      title: lines.slice(titleAt, titleEnd + 1).map((line) => line.trim()).join(' '),
      detail: detail.length ? detail.join('\n') : null,
      options,
      multiSelect: false,
      steps: null,
    },
    toolName,
    cursor: cursorOf(raw),
  };
}

function readSteps(line: string): { label: string; answered: boolean }[] | null {
  const steps = [...line.matchAll(/([☐☒])\s+(.+?)(?=\s+[☐☒✔]|\s+→|$)/g)]
    .map((match) => ({ label: match[2]!.trim(), answered: match[1] === '☒' }));
  return /←/.test(line) ? steps : null;
}

function readQuestion(lines: string[]): PaneInteraction | null {
  const footer = footerAt(lines, QUESTION_FOOTER);
  if (footer === -1) return null;
  const stepAt = lastIndex(lines, (line) => STEP_LINE.test(line), footer);
  if (stepAt === -1) return null;
  // "Chat about this" sits under the rule closing the options; it isn't
  // offered (it leaves the prompt for a chat about it).
  const closingRule = lastIndex(lines, (line) => RULE.test(line), footer);
  if (closingRule <= stepAt) return null;
  const body = lines.slice(stepAt + 1, closingRule);
  const firstOption = body.findIndex((line) => OPTION.test(line));
  if (firstOption < 1) return null;
  const raw = readOptions(body.slice(firstOption));
  if (!raw || raw.length < 2) return null;
  const numbered = raw.filter((option) => option.number !== null);
  const freeTextRow = numbered.at(-1)!;
  const multiSelect = raw.some((option) => option.number !== null && CHECKBOX.test(option.text));
  const options: InteractionOption[] = raw.map((option) => {
    const box = CHECKBOX.exec(option.text);
    const freeText = option === freeTextRow;
    // What is typed on the free-text row wraps like any long row.
    const text = joinWrapped([(box ? box[2]! : option.text).trim(), ...(freeText ? option.more : [])]);
    return {
      number: option.number,
      label: freeText && FREE_TEXT_PLACEHOLDER.test(text) ? '' : text,
      description: !freeText && option.more.length ? joinWrapped(option.more) : null,
      freeText,
      amendable: false,
      checked: box ? box[1] === '✔' : null,
    };
  });
  return {
    screen: {
      kind: 'question',
      title: joinWrapped(body.slice(0, firstOption).map((line) => line.trim()).filter(Boolean)),
      detail: null,
      options,
      multiSelect,
      steps: readSteps(lines[stepAt]!),
    },
    toolName: 'AskUserQuestion',
    cursor: cursorOf(raw),
  };
}

function readReview(lines: string[]): PaneInteraction | null {
  const questionAt = lastIndex(lines, (line) => REVIEW_QUESTION.test(line));
  const titleAt = lastIndex(lines, (line) => REVIEW_TITLE.test(line), questionAt);
  if (questionAt === -1 || titleAt === -1) return null;
  const raw = readOptions(lines.slice(questionAt + 1));
  if (!raw || raw.length !== 2 || raw.some((option) => option.number === null)) return null;
  const answers = lines.slice(titleAt + 1, questionAt).map((line) => line.trim()).filter(Boolean);
  const stepAt = lastIndex(lines, (line) => STEP_LINE.test(line), titleAt);
  return {
    screen: {
      kind: 'review',
      title: lines[questionAt]!.trim(),
      detail: answers.length ? answers.join('\n') : null,
      options: raw.map((option) => ({
        number: option.number, label: option.text, description: null, freeText: false, amendable: false, checked: null,
      })),
      multiSelect: false,
      steps: stepAt === -1 ? null : readSteps(lines[stepAt]!),
    },
    toolName: 'AskUserQuestion',
    cursor: cursorOf(raw),
  };
}

/** The prompt Claude Code's pane ends with, or null when it shows none. */
export function readClaudeInteraction(paneText: string): PaneInteraction | null {
  const lines = trimLines(paneText);
  return readPermission(lines) ?? readQuestion(lines) ?? readReview(lines);
}
