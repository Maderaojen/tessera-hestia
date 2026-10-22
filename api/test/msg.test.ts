import { describe, expect, it } from 'vitest';
import { assembleCompleteTurns, dedupe, isWrapper, textFromContent } from '../src/providers/msg.js';

describe('textFromContent', () => {
  it('passes through a plain string', () => {
    expect(textFromContent('hello')).toBe('hello');
  });

  it('extracts prose blocks and skips tool blocks from a content array', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'tool_use', input: { foo: 'bar' } },
      { type: 'text', text: 'second' },
    ];
    expect(textFromContent(content)).toBe('first\nsecond');
  });

  it('returns empty string for a pure tool_result block', () => {
    const content = [{ type: 'tool_result', content: 'irrelevant' }];
    expect(textFromContent(content)).toBe('');
  });
});

describe('isWrapper', () => {
  it('flags known synthetic wrapper prefixes', () => {
    expect(isWrapper('<local-command-stdout>Goodbye!</local-command-stdout>')).toBe(true);
  });

  it('does not flag ordinary conversation', () => {
    expect(isWrapper('how do I do X?')).toBe(false);
  });
});

describe('dedupe', () => {
  it('collapses consecutive identical role+text pairs', () => {
    const messages = [
      { role: 'assistant' as const, text: 'a', ts: '1' },
      { role: 'assistant' as const, text: 'a', ts: '2' },
      { role: 'user' as const, text: 'b', ts: '3' },
    ];
    expect(dedupe(messages)).toHaveLength(2);
  });
});

describe('assembleCompleteTurns', () => {
  it('attaches a mid-reply follow-up to the turn in progress instead of starting a new one', () => {
    const turns = assembleCompleteTurns([
      { role: 'user', text: 'fix the list', ts: '1' },
      { role: 'user', text: 'and the project menu too', ts: '2', followUp: true },
      { role: 'assistant', text: 'done both', ts: '3' },
      { role: 'user', text: 'thanks', ts: '4' },
      { role: 'assistant', text: 'sure', ts: '5' },
    ]);
    expect(turns).toHaveLength(2);
    // Taken in before any reply text: the original message still owns the turn.
    expect(turns[0]).toMatchObject({ user: { text: 'fix the list', at: '1' }, followUps: [{ text: 'and the project menu too', at: '2' }] });
    expect(turns[1]).not.toHaveProperty('followUps');
  });

  it('treats a follow-up with no turn in progress as an ordinary user message', () => {
    const turns = assembleCompleteTurns([
      { role: 'user', text: 'orphan follow-up', ts: '1', followUp: true },
      { role: 'assistant', text: 'reply', ts: '2' },
    ]);
    expect(turns).toEqual([{ index: 1, user: { text: 'orphan follow-up', at: '1' }, assistant: { text: 'reply', at: '2' } }]);
  });

  it('pairs user -> assistant messages into turns', () => {
    const turns = assembleCompleteTurns([
      { role: 'user', text: 'hi', ts: '1' },
      { role: 'assistant', text: 'hello', ts: '2' },
      { role: 'user', text: 'and?', ts: '3' },
      { role: 'assistant', text: 'part1', ts: '4' },
      { role: 'assistant', text: 'part2', ts: '5' },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[1].assistant.text).toBe('part1\n\npart2');
    expect(turns[1].assistant.at).toBe('4');
  });

  it('drops a trailing user message with no assistant reply yet', () => {
    const turns = assembleCompleteTurns([
      { role: 'user', text: 'hi', ts: '1' },
      { role: 'assistant', text: 'hello', ts: '2' },
      { role: 'user', text: 'still thinking about this one', ts: '3' },
    ]);
    expect(turns).toHaveLength(1);
  });
});
