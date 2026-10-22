import { describe, expect, it } from 'vitest';
import { pastedTextMarks, pastedTextRanges } from '../src/pastedText.js';
import { publicTurns } from '../src/session-dto.js';

const pasted = 'line one of the paste\nline two, long enough to pass the head\nthree';
const sent = `翻譯這段：\n\n${pasted}`;
const range = { start: sent.indexOf(pasted), end: sent.indexOf(pasted) + pasted.length };

describe('pasted text', () => {
  it('keeps a mark of each pasted part, never the text', () => {
    const [mark] = pastedTextMarks(sent, [range]);
    expect(mark).toMatchObject({ head: pasted.slice(0, 32), length: pasted.length });
    expect(JSON.stringify(mark)).not.toContain('three');
    expect(pastedTextMarks(sent, [{ start: 5, end: 5 }, { start: 0, end: sent.length + 1 }])).toEqual([]);
  });

  it('finds the parts again in the message the CLI wrote down', () => {
    const marks = pastedTextMarks(sent, [range]);
    expect(pastedTextRanges(sent, marks)).toEqual([range]);
    // Moved within the message (the CLI trimmed what came before): found where it is now.
    expect(pastedTextRanges(pasted, marks)).toEqual([{ start: 0, end: pasted.length }]);
    // Written down differently: not found, shown as text.
    expect(pastedTextRanges(sent.replace('three', 'THREE'), marks)).toEqual([]);
  });

  it('finds two pastes with the same opening each once', () => {
    const a = `${'x'.repeat(40)}A`;
    const b = `${'x'.repeat(40)}B`;
    const text = `${a}\n${b}`;
    const ranges = pastedTextRanges(text, pastedTextMarks(text, [{ start: 0, end: a.length }, { start: a.length + 1, end: text.length }]));
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual([a, b]);
  });

  it('turns as sent carry the pasted parts of each message', () => {
    const [turn] = publicTurns([{ index: 1, user: { text: sent, at: null }, assistant: { text: 'ok', at: null } }], [], pastedTextMarks(sent, [range]));
    expect(turn?.user.pastes).toEqual([range]);
    const [plain] = publicTurns([{ index: 1, user: { text: 'hi', at: null }, assistant: { text: 'ok', at: null } }], [], pastedTextMarks(sent, [range]));
    expect(plain?.user.pastes).toBeUndefined();
  });
});
