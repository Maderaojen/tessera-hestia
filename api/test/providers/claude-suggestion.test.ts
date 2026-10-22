import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readClaudeSuggestion, stripAnsi } from '../../src/providers/claude-suggestion.js';
import { claudeAdapter } from '../../src/providers/claude.js';
import { readClaudeInteraction } from '../../src/providers/claude-interaction.js';

// Real panes, Claude Code 2.1.296 in an isolated tmux (capture-pane with
// and without -e), the suggestion on screen.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/cli-suggestion');
const ANSI = readFileSync(path.join(FIXTURES, 'claude.suggestion.2.1.296.ansi.txt'), 'utf-8');
const PLAIN = readFileSync(path.join(FIXTURES, 'claude.suggestion.2.1.296.txt'), 'utf-8');

const E = '\x1b';
const RULE = `${E}[38;5;244m${'─'.repeat(60)}`;
const NAMED_RULE = `${E}[38;5;244m${'─'.repeat(50)} my-session ──`;
const FOOTER = `${E}[39m  ${E}[38;5;220m⏵⏵ auto mode on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;

// The bottom of an idle Claude pane, its input line as given.
function pane(inputLine: string, { top = RULE, more = [] as string[] } = {}): string {
  return ['● done.', '', top, inputLine, ...more, RULE, FOOTER, ''].join('\n');
}

describe('readClaudeSuggestion', () => {
  it('reads the dim ghost text off a real 2.1.296 pane', () => {
    expect(readClaudeSuggestion(ANSI)).toBe('Write sub.py with a function sub that subtracts two numbers');
  });

  it('reads the reported shape: a plain space after the marker, CJK text', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯ ${E}[2mpush 同步更新 stable${E}[0m`))).toBe('push 同步更新 stable');
  });

  it('reads it under a rule that carries the session name', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2mrun hello.py${E}[0m`, { top: NAMED_RULE }))).toBe('run hello.py');
  });

  it('reads a dim run left open until the next line', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2mrun hello.py`).replace(`\n${RULE}\n${FOOTER}`, `\n${E}[0m${RULE}\n${FOOTER}`))).toBe('run hello.py');
  });

  it('joins a suggestion wrapped inside the box', () => {
    const wrapped = pane(`${E}[39m❯\u00a0${E}[2madd tests for mul${E}[0m`, { more: [`  ${E}[2mand div${E}[0m`] });
    expect(readClaudeSuggestion(wrapped)).toBe('add tests for mul and div');
    const cjk = pane(`${E}[39m❯\u00a0${E}[2m把同步更新${E}[0m`, { more: [`  ${E}[2m推到 stable${E}[0m`] });
    expect(readClaudeSuggestion(cjk)).toBe('把同步更新推到 stable');
  });

  it('is null for text the user typed', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0run hello.py`))).toBeNull();
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[38;5;231mrun hello.py${E}[39m`))).toBeNull();
  });

  it('is null for typed text with a dim completion after it', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0/com${E}[2mpact${E}[0m`))).toBeNull();
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2mrun${E}[22m hello.py`))).toBeNull();
  });

  it('is null for a dim line that isn\'t the first line\'s continuation', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2mrun hello.py${E}[0m`, { more: ['  typed below'] }))).toBeNull();
  });

  it('is null for an empty box and for the first-run placeholder', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0`))).toBeNull();
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2mTry "how do I log an error?"`).replace(`\n${RULE}`, `\n${E}[0m${RULE}`))).toBeNull();
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2mPress up to edit queued messages${E}[0m`))).toBeNull();
  });

  it('does not take an extended colour\'s numbers for dim', () => {
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[38;2;200;200;200mrun hello.py${E}[39m`))).toBeNull();
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[38;5;2mrun hello.py${E}[39m`))).toBeNull();
    expect(readClaudeSuggestion(pane(`${E}[39m❯\u00a0${E}[2;38;5;246mrun hello.py${E}[0m`))).toBe('run hello.py');
  });

  it('ignores a submitted prompt echoed in the scrollback, and a pane without the box', () => {
    const echoed = [`${E}[38;5;246m${E}[48;5;237m❯ ${E}[2mold${E}[0m`, '● ok', ''].join('\n');
    expect(readClaudeSuggestion(echoed)).toBeNull();
    expect(readClaudeSuggestion('')).toBeNull();
  });

  it('is null in a capture without attributes, where it reads like typed text', () => {
    expect(readClaudeSuggestion(PLAIN)).toBeNull();
  });
});

// The rest of the app reads the pane without attributes (polling.ts,
// services/messages.ts): there the suggestion looks like a typed draft, and
// none of those readings may change because of it.
describe('ghost text and the plain-text pane readings', () => {
  it('shows exactly like typed text without -e', () => {
    expect(PLAIN).toContain('❯\u00a0Write sub.py with a function sub that subtracts two numbers');
    expect(stripAnsi(ANSI).replace(/[ \t]+$/gm, '')).toBe(PLAIN.replace(/[ \t]+$/gm, ''));
  });

  it('still reads idle, not busy, with no prompt to answer', () => {
    expect(claudeAdapter.paneShowsIdle!(PLAIN)).toBe(true);
    expect(claudeAdapter.paneShowsBusy!(PLAIN)).toBe(false);
    expect(claudeAdapter.paneShowsPermissionPrompt!(PLAIN)).toBe(false);
    expect(readClaudeInteraction(PLAIN)).toBeNull();
  });

  it('still reads idle when the suggestion looks like a menu option', () => {
    const plain = stripAnsi(pane(`${E}[39m❯\u00a0${E}[2m1. Yes${E}[0m`));
    expect(claudeAdapter.paneShowsIdle!(plain)).toBe(true);
    expect(readClaudeInteraction(plain)).toBeNull();
  });
});
