import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { clearProcessCache, readTranscriptProcess } from '../../src/process/cache.js';
import { claudeItemDetail, claudeProcessTurns } from '../../src/process/claude.js';

// Records shaped like Claude Code 2.1.296's (one content block per
// assistant record); the content and ids are made up.
let n = 0;
const at = () => `2026-10-12T01:00:${String(n++).padStart(2, '0')}.000Z`;
const CWD = '/work/demo';
const user = (text: string) => ({ type: 'user', uuid: `u${n}`, cwd: CWD, timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const text = (value: string, stop: string | null = null) => ({ type: 'assistant', uuid: `a${n}`, cwd: CWD, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: value }], stop_reason: stop } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', uuid: `t${n}`, cwd: CWD, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
const result = (id: string, content: string, extra: Record<string, unknown> = {}, isError = false) => ({ type: 'user', uuid: `r${n}`, cwd: CWD, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...extra });
const thinking = (value: string) => ({ type: 'assistant', uuid: `k${n}`, cwd: CWD, timestamp: at(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: value, signature: 'sig' }] } });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', timestamp: at() });
const wake = () => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>' } });
const interrupt = () => ({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });

function transcript(): unknown[] {
  n = 0;
  return [
    user('看一下 Modal 怎麼做'),
    thinking(''),
    text('先看 Modal 元件。'),
    tool('toolu_1', 'Read', { file_path: `${CWD}/src/Modal.vue` }),
    result('toolu_1', '<template>…</template>'),
    thinking('要改 props'),
    text('接著改 props。'),
    tool('toolu_2', 'Edit', { file_path: `${CWD}/src/Modal.vue`, old_string: 'a', new_string: 'b' }),
    result('toolu_2', 'ok', { toolUseResult: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] } }),
    tool('toolu_3', 'Bash', { command: 'npm test\n--silent' }),
    result('toolu_3', 'Exit code 1\nFAIL 1', {}, true),
    text('改好了。', 'end_turn'),
    text('測試有一個失敗，原因是…', 'end_turn'),
    turnEnd(),
    // A question: its lead-in is for the user.
    user('要用哪個做法？'),
    text('有兩個做法，A 比較快、B 比較穩。'),
    tool('toolu_4', 'AskUserQuestion', { questions: [] }),
    result('toolu_4', 'A'),
    text('好，用 A。', 'end_turn'),
    turnEnd(),
    // Woken by a background agent after the CLI had already answered.
    user('背景跑一下測試'),
    text('開一個背景 agent。'),
    tool('toolu_5', 'Agent', { description: '跑測試', run_in_background: true }),
    result('toolu_5', 'async_launched'),
    text('已經開始，完成後回報。', 'end_turn'),
    turnEnd(),
    wake(),
    text('測試全部通過。', 'end_turn'),
    turnEnd(),
    // Stopped mid-tool.
    user('再跑一次'),
    text('重新跑。'),
    tool('toolu_6', 'Bash', { command: 'npm test' }),
    interrupt(),
  ];
}

describe('claudeProcessTurns', () => {
  it('splits each turn into progress and reply parts that join to the turn text', () => {
    const turns = claudeProcessTurns(transcript());
    expect(turns).toHaveLength(4);
    expect(turns[0]!.parts).toEqual([
      { kind: 'progress', text: '先看 Modal 元件。', at: expect.any(String) },
      { kind: 'progress', text: '接著改 props。', at: expect.any(String) },
      { kind: 'reply', text: '改好了。\n\n測試有一個失敗，原因是…', at: expect.any(String) },
    ]);
    for (const turn of turns) expect(turn.parts.map((part) => part.text).join('\n\n')).toBe(turn.assistantText);
  });

  it('counts tools by kind, failures and thinking', () => {
    const [first] = claudeProcessTurns(transcript());
    // The same file read and edited counts once in each.
    expect(first!.counts).toMatchObject({ read: 1, edit: 1, run: 1, failed: 1, runFailed: 1, thinking: 2 });
    const labels = first!.events.filter((event) => event.type === 'tool').map((event) => event.type === 'tool' && event.label);
    expect(labels).toEqual(['src/Modal.vue', 'src/Modal.vue', 'npm test']);
  });

  it('reads the text before a question to the user as reply', () => {
    const second = claudeProcessTurns(transcript())[1]!;
    expect(second.parts.map((part) => part.kind)).toEqual(['reply', 'reply']);
  });

  it('keeps a reply given before a background agent woke the CLI again', () => {
    const third = claudeProcessTurns(transcript())[2]!;
    expect(third.parts.map((part) => [part.kind, part.text])).toEqual([
      ['progress', '開一個背景 agent。'],
      // Two answers at two different times stay two parts.
      ['reply', '已經開始，完成後回報。'],
      ['reply', '測試全部通過。'],
    ]);
  });

  it('leaves a turn stopped mid-tool with progress only', () => {
    const last = claudeProcessTurns(transcript())[3]!;
    expect(last.interrupted).toBe(true);
    expect(last.parts).toEqual([{ kind: 'progress', text: '重新跑。', at: expect.any(String) }]);
    expect(last.events.find((event) => event.type === 'tool')).toMatchObject({ status: 'running' });
  });

  it('reads 2.1.304+ narration as text and keeps other thinking as reasoning', () => {
    n = 0;
    // Signature heads as Claude Code 2.1.305 writes them (the rest cut off).
    const signed = (value: string, signature: string) => ({ ...thinking(value), message: { role: 'assistant', content: [{ type: 'thinking', thinking: value, signature }] } });
    const records = [
      user('能 push 嗎？'),
      signed('', 'CAQSiwkKEAgTGAI4AUIIdGhpbmtpbmcSDPxRYqQq'),
      signed('沒有網頁可以查公證進度，先 push。\n\n', 'CAQSyAoKEQgTGAI4AUIJbmFycmF0aW9uEgwMtQ0r'),
      signed('只是想一下', 'CAQSiwkKEAgTGAI4AUIIdGhpbmtpbmcSDPxRYqQq'),
      signed('簽章看不懂', 'not base64 at all'),
      tool('toolu_1', 'Bash', { command: 'git push' }),
      result('toolu_1', 'ok'),
      text('已推上去。', 'end_turn'),
      turnEnd(),
    ];
    const [turn] = claudeProcessTurns(records);
    expect(turn!.parts.map((part) => [part.kind, part.text])).toEqual([
      ['progress', '沒有網頁可以查公證進度，先 push。'],
      ['reply', '已推上去。'],
    ]);
    expect(turn!.counts).toMatchObject({ thinking: 3 });
  });

  it('gives details only for items of that turn', () => {
    const records = transcript();
    const [first, second] = claudeProcessTurns(records);
    expect(claudeItemDetail(records, first!, 'toolu_2')).toEqual({ diff: '--- src/Modal.vue\n+++ src/Modal.vue\n@@ -3,1 +3,1 @@\n-a\n+b', truncated: false });
    expect(claudeItemDetail(records, first!, 'toolu_3')).toEqual({ input: 'npm test\n--silent', output: 'Exit code 1\nFAIL 1', exitCode: 1, truncated: false });
    expect(claudeItemDetail(records, first!, 'k1')).toEqual({ thinking: null, truncated: false });
    expect(claudeItemDetail(records, first!, 'k5')).toEqual({ thinking: '要改 props', truncated: false });
    // Another turn's tool, and anything that isn't an id seen there.
    expect(claudeItemDetail(records, second!, 'toolu_2')).toBeNull();
    expect(claudeItemDetail(records, first!, '../../etc/passwd')).toBeNull();
  });
});

describe('readTranscriptProcess', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-process-'));
    clearProcessCache();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lines = (records: unknown[]) => records.map((record) => `${JSON.stringify(record)}\n`).join('');

  it('matches the turn parser on the same file', async () => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, lines(transcript()));
    const parsed = await claudeAdapter.parseTurns(file);
    const process = await readTranscriptProcess(file, 'claude');
    expect(process.status).toBe('ok');
    if (process.status !== 'ok') return;
    expect(process.turns.map((turn) => [turn.user.text, turn.user.at, turn.assistantText]))
      .toEqual(parsed.map((turn) => [turn.user.text, turn.user.at, turn.assistant.text]));
  });

  it('keeps finished turns when the file grows and reads the rest again', async () => {
    const file = path.join(dir, 't.jsonl');
    const records = transcript();
    await writeFile(file, lines(records.slice(0, 20)));
    const before = await readTranscriptProcess(file, 'claude');
    await appendFile(file, lines(records.slice(20)));
    const after = await readTranscriptProcess(file, 'claude');
    if (before.status !== 'ok' || after.status !== 'ok') throw new Error('unreadable');
    expect(after.turns[0]).toBe(before.turns[0]);
    clearProcessCache();
    const fresh = await readTranscriptProcess(file, 'claude');
    if (fresh.status !== 'ok') throw new Error('unreadable');
    expect(after.turns).toEqual(fresh.turns);
  });

  it('reads the same turns however the file grew, across repeated and queued messages', async () => {
    n = 0;
    const followUp = (value: string) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: value, origin: { kind: 'human' } } });
    const records = [
      user('第一個問題'),
      text('先查一下。'),
      tool('toolu_a', 'Read', { file_path: `${CWD}/a.ts` }),
      result('toolu_a', 'x'),
      text('答案是 A。', 'end_turn'),
      turnEnd(),
      // Sent twice in a row (the second is deduped away), then a follow-up
      // queued before the reply started.
      user('第二個問題'),
      user('第二個問題'),
      followUp('順便看 b.ts'),
      text('看 b.ts。'),
      tool('toolu_b', 'Read', { file_path: `${CWD}/b.ts` }),
      followUp('還有 c.ts'),
      result('toolu_b', 'y'),
      text('答案是 B。', 'end_turn'),
      turnEnd(),
      user('第三個'),
      followUp('補充'),
      text('好。', 'end_turn'),
      turnEnd(),
    ];
    const file = path.join(dir, 'grow.jsonl');
    clearProcessCache();
    await writeFile(file, lines(records));
    const whole = await readTranscriptProcess(file, 'claude');
    if (whole.status !== 'ok') throw new Error('unreadable');
    expect(whole.turns.map((turn) => turn.user.text)).toEqual(['第一個問題', '第二個問題', '第三個']);
    for (let cut = 1; cut < records.length; cut++) {
      clearProcessCache();
      await writeFile(file, lines(records.slice(0, cut)));
      await readTranscriptProcess(file, 'claude');
      await appendFile(file, lines(records.slice(cut)));
      const grown = await readTranscriptProcess(file, 'claude');
      if (grown.status !== 'ok') throw new Error('unreadable');
      expect(grown.turns, `cut at ${cut}`).toEqual(whole.turns);
    }
  });

  it('says so when the transcript is gone', async () => {
    expect(await readTranscriptProcess(path.join(dir, 'gone.jsonl'), 'claude')).toEqual({ status: 'missing' });
  });
});
