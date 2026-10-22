import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../../src/providers/codex.js';
import { codexItemDetail, codexProcessTurns } from '../../src/process/codex.js';

// Records shaped like Codex 0.162.1's rollout; content and ids made up.
let n = 0;
const at = () => `2026-10-12T02:00:${String(n++).padStart(2, '0')}.000Z`;
const CWD = '/work/demo';
const event = (payload: Record<string, unknown>) => ({ timestamp: at(), type: 'event_msg', payload });
const item = (value: Record<string, unknown>) => event({ type: 'item_completed', item: value });
const userMessage = (text: string) => ({ timestamp: at(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const reply = (text: string, phase: string) => ({ timestamp: at(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } });

function rollout(): unknown[] {
  n = 0;
  return [
    { timestamp: at(), type: 'session_meta', payload: { id: 'x', cwd: CWD } },
    event({ type: 'task_started' }),
    { timestamp: at(), type: 'turn_context', payload: { cwd: CWD } },
    userMessage('服務有啟動嗎'),
    item({ type: 'Reasoning', id: 'rs_1', summary_text: [], raw_content: [] }),
    reply('我先看啟動設定。', 'commentary'),
    item({ type: 'CommandExecution', id: 'exec-1', command: ['/bin/bash', '-lc', 'cat package.json'], parsed_cmd: [{ type: 'read', path: `${CWD}/package.json`, name: 'package.json' }], status: 'completed', exit_code: 0, aggregated_output: '{}' }),
    item({ type: 'CommandExecution', id: 'exec-2', command: ['/bin/bash', '-lc', 'systemctl --user status demo'], parsed_cmd: [{ type: 'unknown' }], status: 'failed', exit_code: 3, aggregated_output: 'inactive' }),
    item({ type: 'FileChange', id: 'exec-3', status: 'completed', changes: { [`${CWD}/README.md`]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b' } } }),
    reply('沒有啟動，服務是停止的。', 'final_answer'),
    event({ type: 'task_complete' }),
    event({ type: 'task_started' }),
    userMessage('那先不要'),
    reply('好的，我先停在這裡', 'commentary'),
    event({ type: 'turn_aborted' }),
  ];
}

describe('codexProcessTurns', () => {
  it('uses Codex\'s own phase for each text', () => {
    const turns = codexProcessTurns(rollout());
    expect(turns.map((turn) => turn.parts.map((part) => part.kind))).toEqual([['progress', 'reply'], ['progress']]);
    for (const turn of turns) expect(turn.parts.map((part) => part.text).join('\n\n')).toBe(turn.assistantText);
  });

  it('reads tools from the completed items', () => {
    const [first] = codexProcessTurns(rollout());
    expect(first!.counts).toMatchObject({ read: 1, run: 1, edit: 1, failed: 1, thinking: 1 });
    const labels = first!.events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.label);
    expect(labels).toEqual(['package.json', 'systemctl --user status demo', 'README.md']);
  });

  it('gives an item\'s details only within its turn', () => {
    const records = rollout();
    const [first, second] = codexProcessTurns(records);
    expect(codexItemDetail(records, first!, 'exec-2')).toEqual({ input: 'systemctl --user status demo', output: 'inactive', exitCode: 3, truncated: false });
    expect(codexItemDetail(records, first!, 'exec-3')).toEqual({ diff: `--- ${CWD}/README.md\n+++ ${CWD}/README.md\n@@ -1 +1 @@\n-a\n+b`, truncated: false });
    expect(codexItemDetail(records, first!, 'rs_1')).toEqual({ thinking: null, truncated: false });
    expect(codexItemDetail(records, second!, 'exec-2')).toBeNull();
  });

  it('matches the turn parser', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-codex-process-'));
    try {
      const file = path.join(dir, 'rollout.jsonl');
      const records = rollout();
      await writeFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
      const parsed = await codexAdapter.parseTurns(file);
      expect(codexProcessTurns(records).map((turn) => [turn.user.text, turn.user.at, turn.assistantText]))
        .toEqual(parsed.map((turn) => [turn.user.text, turn.user.at, turn.assistant.text]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('codexWholeTurn', () => {
  it('reads a subagent rollout whose tasks are not user messages as one turn', async () => {
    const { readFile } = await import('node:fs/promises');
    const { codexWholeTurn } = await import('../../src/process/codex.js');
    const lines = (await readFile(new URL('../fixtures/subagents/codex.child.0.162.1.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
    // Only the child's own part (no user message in it).
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => !(record.type === 'response_item' && (record.payload as Record<string, unknown>).role === 'user'));
    const turn = codexWholeTurn(records)!;
    expect(turn.parts.map((part) => part.kind)).toContain('reply');
    expect(turn.parts.map((part) => part.text).join('\n\n')).toBe(turn.assistantText);
  });
});
