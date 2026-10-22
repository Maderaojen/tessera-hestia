import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeInteraction } from '../../src/providers/claude-interaction.js';
import { answerInteraction, interactionId, pendingFromPane, type InteractionAnswer } from '../../src/sync/interaction.js';

const capture = (screen: string) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'interaction-prompts', `claude.${screen}.2.1.284.txt`), 'utf8');
const idOf = (pane: string) => interactionId(readClaudeInteraction(pane)!.screen);

// The same screen with the cursor on another numbered row (or Next).
function cursorOn(pane: string, row: number | 'Next'): string {
  const cleared = pane.replace(/^(\s*)❯ (\d+\.|Next)/m, (_all, indent: string, rest: string) => `${indent}  ${rest}`);
  const target = row === 'Next' ? /^(\s*) {2}( *Next\s*)$/m : new RegExp(`^(\\s*)  (${row}\\. )`, 'm');
  return cleared.replace(target, (_all, indent: string, rest: string) => `${indent}❯ ${rest}`);
}

// Plays back one capture per read and records what was sent.
function terminal(screens: string[]) {
  const sent: string[] = [];
  let reads = 0;
  return {
    sent,
    capture: async () => screens[Math.min(reads++, screens.length - 1)]!,
    sendKey: async (key: string) => { sent.push(key); },
    type: async (text: string) => { sent.push(`type:${text}`); },
    sleep: async () => {},
  };
}

const answer = async (screens: string[], body: Omit<InteractionAnswer, 'promptId'>, promptId = idOf(screens[0]!)) => {
  const term = terminal(screens);
  const outcome = await answerInteraction(term, readClaudeInteraction, { promptId, ...body });
  return { outcome, sent: term.sent };
};

describe('interactionId', () => {
  it('stays the same while only the cursor moves or free text is typed, changes with the prompt', () => {
    const q1 = capture('q-multi-q1');
    expect(idOf(cursorOn(q1, 3))).toBe(idOf(q1));
    expect(idOf(capture('q-multi-q1-typed'))).toBe(idOf(q1));
    expect(idOf(capture('q-multi-q3'))).not.toBe(idOf(q1));
    // A ticked box is a different prompt to answer.
    expect(idOf(capture('q-ms-toggled'))).not.toBe(idOf(capture('q-multi-q2')));
  });
});

describe('pendingFromPane', () => {
  it('names a prompt only the pane shows by its screen', () => {
    const read = readClaudeInteraction(capture('q-single'))!;
    expect(pendingFromPane(read, null)).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion', input: null, toolUseId: interactionId(read.screen), screen: read.screen });
  });

  it('keeps what the transcript knows of it', () => {
    const read = readClaudeInteraction(capture('perm-write'))!;
    const fromTranscript = { kind: 'tool_permission' as const, toolUseId: 'toolu_1', toolName: 'Write', input: { file_path: 'a.txt' }, detectedAt: '2026-09-29T00:00:00Z' };
    expect(pendingFromPane(read, fromTranscript)).toMatchObject({ kind: 'tool_permission', input: { file_path: 'a.txt' }, detectedAt: '2026-09-29T00:00:00Z', screen: read.screen });
  });
});

describe('answerInteraction', () => {
  it('confirms the option already under the cursor', async () => {
    expect(await answer([capture('q-single')], { option: 1 })).toEqual({ outcome: 'answered', sent: ['Enter'] });
  });

  it('moves the cursor one row at a time, re-reading it, before confirming', async () => {
    const q = capture('perm-bash');
    expect(await answer([q, cursorOn(q, 2), cursorOn(q, 3), cursorOn(q, 4)], { option: 4 }))
      .toEqual({ outcome: 'answered', sent: ['Down', 'Down', 'Down', 'Enter'] });
    const atNo = capture('perm-bash-cursor-no');
    expect(await answer([atNo, cursorOn(atNo, 3), cursorOn(atNo, 2), cursorOn(atNo, 1)], { option: 1 }))
      .toEqual({ outcome: 'answered', sent: ['Up', 'Up', 'Up', 'Enter'] });
  });

  it('types a free-text answer, reads it back, then confirms it', async () => {
    const q1 = capture('q-multi-q1');
    expect(await answer([q1, cursorOn(q1, 2), cursorOn(q1, 3), capture('q-multi-q1-typed')], { option: 3, text: '芭樂' }))
      .toEqual({ outcome: 'answered', sent: ['Down', 'Down', 'type:芭樂', 'Enter'] });
  });

  it('sends free text as one line', async () => {
    const q1 = capture('q-multi-q1');
    const { sent } = await answer([cursorOn(q1, 3), capture('q-multi-q1-typed')], { option: 3, text: ' 芭\n樂 ' });
    expect(sent[0]).toBe('type:芭 樂');
  });

  it('leaves a multi-select free-text row ticked by the typing, without the Enter that would untick it', async () => {
    const toggled = capture('q-ms-toggled');
    expect(await answer([toggled, cursorOn(toggled, 2), cursorOn(toggled, 3), capture('q-ms-typed')], { option: 3, text: '紫' }))
      .toEqual({ outcome: 'answered', sent: ['Down', 'Down', 'type:紫'] });
  });

  it("goes to a multi-select question's Next row", async () => {
    const typed = capture('q-ms-typed');
    const promptId = idOf(typed);
    expect(await answer([typed, capture('q-ms-next')], { option: 'next' }, promptId)).toEqual({ outcome: 'answered', sent: ['Down', 'Enter'] });
  });

  it('sends a note along with a permission through Tab', async () => {
    const atNo = capture('perm-bash-cursor-no');
    expect(await answer([atNo, capture('perm-bash-no-amend')], { option: 4, text: '不要搬，停' }))
      .toEqual({ outcome: 'answered', sent: ['Tab', 'type:不要搬，停', 'Enter'] });
    expect(await answer([capture('perm-write'), capture('perm-write-amend')], { option: 1, text: '好' }))
      .toEqual({ outcome: 'answered', sent: ['Tab', 'type:好', 'Enter'] });
  });

  it('sends nothing when the prompt on screen is another one, or gone', async () => {
    expect(await answer([capture('q-multi-q3')], { option: 1 }, idOf(capture('q-multi-q1')))).toEqual({ outcome: 'changed', sent: [] });
    expect(await answer([capture('idle-after')], { option: 1 }, 'pane:x')).toEqual({ outcome: 'not_shown', sent: [] });
  });

  it('refuses answers the option cannot take', async () => {
    const q1 = capture('q-multi-q1');
    expect((await answer([q1], { option: 9 })).outcome).toBe('invalid');
    expect((await answer([q1], { option: 1, text: 'x' })).outcome).toBe('invalid');
    expect((await answer([q1], { option: 3 })).outcome).toBe('invalid');
    // Row 2 of a permission can't carry a note.
    expect((await answer([capture('perm-bash')], { option: 2, text: 'x' })).outcome).toBe('invalid');
  });

  it('confirms nothing it cannot verify', async () => {
    const q1 = capture('q-multi-q1');
    // The cursor doesn't move.
    expect(await answer([q1], { option: 2 })).toEqual({ outcome: 'unsure', sent: ['Down', 'Down', 'Down', 'Down'] });
    // The text shown isn't what was typed: no Enter.
    expect(await answer([cursorOn(q1, 3), capture('q-multi-q1-typed')], { option: 3, text: '番茄' })).toEqual({ outcome: 'unsure', sent: ['type:番茄'] });
    // Text already typed on the row in the terminal.
    expect(await answer([capture('q-multi-q1-typed')], { option: 3, text: '番茄' }, idOf(q1))).toEqual({ outcome: 'unsure', sent: [] });
  });
});
