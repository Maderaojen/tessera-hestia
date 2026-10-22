import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeOpenTurnAtEnd, claudeTurnOpenAtEnd } from '../../src/providers/claude.js';

// Record shapes as Claude Code 2.1.294–2.1.296 writes them (real main
// transcripts, structure only): a finished turn ends on an assistant
// end_turn followed by `system`/`turn_duration`; a background agent's end
// wakes the model with a queued_command attachment (commandMode
// task-notification) or a user record whose origin isn't human; a turn
// stopped with Esc ends on the interrupt marker, with no turn_duration.
const human = { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'do it' } };
const reply = (stop: string) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } });
const duration = { type: 'system', subtype: 'turn_duration', durationMs: 1000 };
const wakeAttachment = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>' } };
const wakeUser = { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>…</task-notification>' } };
const peer = { type: 'user', origin: { kind: 'peer' }, message: { role: 'user', content: 'hi' } };
const interrupted = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
const housekeeping = [{ type: 'last-prompt' }, { type: 'ai-title' }, { type: 'mode' }, { type: 'permission-mode' }, { type: 'file-history-snapshot' }];

describe('claudeTurnOpenAtEnd', () => {
  it('is closed once the last turn wrote its turn_duration, whatever housekeeping follows', () => {
    expect(claudeTurnOpenAtEnd([human, reply('end_turn'), duration, ...housekeeping])).toBe(false);
  });

  it('is open once a background agent woke the model after that', () => {
    const done = [human, reply('end_turn'), duration];
    expect(claudeTurnOpenAtEnd([...done, wakeAttachment])).toBe(true);
    expect(claudeTurnOpenAtEnd([...done, wakeUser])).toBe(true);
    expect(claudeTurnOpenAtEnd([...done, peer])).toBe(true);
    expect(claudeTurnOpenAtEnd([...done, wakeAttachment, reply('tool_use')])).toBe(true);
    // ...and closed again when that turn finishes.
    expect(claudeTurnOpenAtEnd([...done, wakeAttachment, reply('end_turn'), duration])).toBe(false);
  });

  it('is closed by an interrupt, which writes no turn_duration', () => {
    expect(claudeTurnOpenAtEnd([duration, wakeAttachment, reply('tool_use'), interrupted, ...housekeeping])).toBe(false);
  });

  it('never says open for a transcript without any turn_duration (older CLIs)', () => {
    expect(claudeTurnOpenAtEnd([human, reply('tool_use'), wakeAttachment])).toBe(false);
    expect(claudeTurnOpenAtEnd([])).toBe(false);
  });

  it("ignores a subagent's own sidechain lines", () => {
    expect(claudeTurnOpenAtEnd([duration, { ...reply('end_turn'), isSidechain: true }])).toBe(false);
  });

  it('sees the transcript grow (the parse cache grows one array in place)', () => {
    const records: unknown[] = [human, reply('end_turn'), duration];
    expect(claudeTurnOpenAtEnd(records)).toBe(false);
    records.push(wakeAttachment);
    expect(claudeTurnOpenAtEnd(records)).toBe(true);
  });
});

describe('claudeOpenTurnAtEnd: who opened the turn still going', () => {
  const done = [human, reply('end_turn'), duration];
  const typed = (at: string) => ({ ...human, timestamp: at, promptSource: 'typed' });

  it("is the CLI's when a wake-up opened it", () => {
    expect(claudeOpenTurnAtEnd([...done, wakeAttachment, reply('tool_use')])).toEqual({ openedBy: 'cli', at: null });
    expect(claudeOpenTurnAtEnd([...done, wakeUser, reply('tool_use')])).toEqual({ openedBy: 'cli', at: null });
  });

  it("is a person's when their message opened it, with its time", () => {
    expect(claudeOpenTurnAtEnd([...done, typed('T1'), reply('tool_use')])).toEqual({ openedBy: 'user', at: 'T1' });
  });

  it('goes by the first opener after the last turn ended', () => {
    // A person's message joining a turn a wake-up opened doesn't make it theirs.
    expect(claudeOpenTurnAtEnd([...done, wakeUser, reply('tool_use'), typed('T1'), reply('tool_use')])).toEqual({ openedBy: 'cli', at: null });
  });

  it("is nothing for a person's message with no reply yet (the poller's fresh-message check owns that)", () => {
    expect(claudeOpenTurnAtEnd([...done, typed('T1')])).toBeNull();
  });

  // Real transcript (2.1.299, fabrica #7), cut down to its record skeleton:
  // a background agent stopped from the terminal wakes the main turn, Esc
  // interrupts it, and a prompt typed right after opens a turn that keeps
  // working through tool calls.
  it('reads a prompt typed right after an Esc as a person opening the turn', async () => {
    const file = path.join(import.meta.dirname, '../fixtures/turn-boundaries/claude.prompt-after-esc.2.1.299.jsonl');
    const records = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(claudeOpenTurnAtEnd(records)).toEqual({ openedBy: 'user', at: '2026-10-14T21:59:58.720Z' });
    // Up to the interrupt, nothing is open.
    const interrupt = records.findIndex((rec) => JSON.stringify(rec).includes('[Request interrupted by user]'));
    expect(claudeOpenTurnAtEnd(records.slice(0, interrupt + 1))).toBeNull();
    // Woken by the stopped agent's notification, before the Esc: the CLI's own.
    expect(claudeOpenTurnAtEnd(records.slice(0, interrupt))).toEqual({ openedBy: 'cli', at: null });
  });
});
