import { describe, expect, it } from 'vitest';
import { HANDOFF_MESSAGES, handoffMessageKind } from '../../src/contract/continuity.js';

describe('handoffMessageKind', () => {
  const file = '/p/.hestia/handoffs/20261005-024513Z-dc6ee9c1.md';

  it.each([
    ['the request to write the brief', HANDOFF_MESSAGES.writeBrief(file), 'write_brief'],
    ['the same, its head lost (as Codex 0.160.0 once recorded it)', HANDOFF_MESSAGES.writeBrief(file).slice(HANDOFF_MESSAGES.writeBrief(file).indexOf('0261005')), 'write_brief'],
    ['the request in its earlier wording', `額度快用完了，接下來會交給另一個 LLM 接手。請把交接內容用 Markdown 寫到 ${file}：…`, 'write_brief'],
    ['the briefing, asking for a report', HANDOFF_MESSAGES.briefAsk(file), 'brief'],
    ['the briefing, carrying on', HANDOFF_MESSAGES.briefAuto(file), 'brief'],
    ['the briefing, rewrapped', HANDOFF_MESSAGES.briefAsk(file).replace('。請', '。\n請'), 'brief'],
    ['the go-ahead', HANDOFF_MESSAGES.confirm, 'confirm'],
  ] as const)('%s', (_name, text, kind) => {
    expect(handoffMessageKind(text)).toBe(kind);
  });

  it.each([
    ['the user\'s own message', '請在 calc.py 加一個 subtract 函式'],
    ['a go-ahead in other words', '確認，開始做吧'],
    ['nothing', ''],
  ])('not %s', (_name, text) => {
    expect(handoffMessageKind(text)).toBeNull();
  });
});
