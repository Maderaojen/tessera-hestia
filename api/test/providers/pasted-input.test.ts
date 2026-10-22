import { describe, expect, it } from 'vitest';
import { claudeMessagesFromRecords, unwrapPastedContent } from '../../src/providers/claude.js';
import { codexMessages, codexTypedText } from '../../src/providers/codex.js';

// How the CLIs record what was pasted into them (the app's sends are
// pastes): Claude Code 2.1.278–2.1.300 and Codex 0.162.1, record shapes
// from real transcripts, paths and text replaced.
const PATH = '/state/uploads/sess-1/a.png';

describe('Claude Code: a paste read back as it was sent', () => {
  it('takes a folded paste out of its <pasted_content> tags', () => {
    const recorded = '\n\n<pasted_content id="83d1">\n兩張各是什麼顏色？\n\n/a.png\n/b.png\n</pasted_content id="83d1">\n';
    expect(unwrapPastedContent(recorded)).toBe('兩張各是什麼顏色？\n\n/a.png\n/b.png');
    // Typed words before a paste stay.
    expect(unwrapPastedContent('看這段\n\n<pasted_content id="1a">\nbody\n</pasted_content id="1a">')).toBe('看這段\n\nbody');
    // Tags that don't pair up are text someone wrote.
    expect(unwrapPastedContent('<pasted_content id="1a">x</pasted_content id="2b">')).toBe('<pasted_content id="1a">x</pasted_content id="2b">');
  });

  it('puts an image path back where the CLI wrote "[Image #N]", from its source companion', () => {
    const records = [
      { type: 'user', promptId: 'p1', imagePasteIds: [1], timestamp: 'T1', message: { role: 'user', content: [{ type: 'text', text: '[Image #1]' }, { type: 'image', source: {} }] } },
      { type: 'user', promptId: 'p1', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `[Image: source: ${PATH}]` }] } },
      { type: 'assistant', timestamp: 'T2', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '紅色' }] } },
    ];
    expect(claudeMessagesFromRecords(records, false).map((message) => message.text)).toEqual([PATH, '紅色']);
  });

  it('leaves "[Image #N]" for an image pasted with no path', () => {
    const records = [
      { type: 'user', promptId: 'p1', imagePasteIds: [1], message: { role: 'user', content: [{ type: 'text', text: '[Image #1]' }, { type: 'image', source: {} }] } },
      { type: 'user', promptId: 'p1', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '[Image: original 935x2048, displayed at 913x2000.]' }] } },
    ];
    expect(claudeMessagesFromRecords(records, false).map((message) => message.text)).toEqual(['[Image #1]']);
  });
});

describe('Codex: a paste read back as it was sent', () => {
  it('puts an image path back where it attached the image', () => {
    const recorded = `<image name=[Image #1] path="${PATH}">\n</image>\n[Image #1]`;
    expect(codexTypedText(recorded)).toBe(PATH);
    const records = [{
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `<image name=[Image #1] path="${PATH}">` }, { type: 'input_image', image_url: 'data:' }, { type: 'input_text', text: '</image>' }, { type: 'input_text', text: '[Image #1]' }],
      },
    }];
    expect(codexMessages(records).map((message) => message.text)).toEqual([PATH]);
  });

  it('leaves text without one alone', () => {
    expect(codexTypedText('see [Image #2]')).toBe('see [Image #2]');
  });
});
