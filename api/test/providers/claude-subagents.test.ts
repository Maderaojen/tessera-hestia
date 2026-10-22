import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { listClaudeSubagents, locateClaudeSubagentFile, openClaudeSubagents } from '../../src/providers/claude-subagents.js';

// Record shapes copied from Claude Code 2.1.283 transcripts.
const agentCall = (toolUseId: string, description: string, ts: string, subagentType = 'general-purpose') => ({
  type: 'assistant', timestamp: ts,
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, subagent_type: subagentType, prompt: 'do it' } }] },
});
const launched = (toolUseId: string, agentId: string, ts: string) => ({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'x' },
});
const ranInForeground = (toolUseId: string, agentId: string, ts: string) => ({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'PONG' }] }] },
  toolUseResult: { status: 'completed', agentId, agentType: 'general-purpose' },
});
const notification = (ids: string[], status: string, summary: string) =>
  `<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>`).join('\n')}\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
const notifiedAsUser = (ids: string[], status: string, summary: string, ts: string) => ({
  type: 'user', timestamp: ts, origin: { kind: 'task-notification' },
  message: { role: 'user', content: notification(ids, status, summary) },
});
const notifiedAsAttachment = (ids: string[], status: string, summary: string, ts: string) => ({
  type: 'attachment', timestamp: ts,
  attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notification(ids, status, summary) },
});
const sendMessage = (to: string, ts: string) => ({
  type: 'assistant', timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_send_${to}`, name: 'SendMessage', input: { to, message: 'more' } }] },
});

const SID = '11111111-1111-4111-8111-111111111111';
const OLD_SID = '22222222-2222-4222-8222-222222222222';
let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'subagents-test-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

const mainFile = () => path.join(projectDir, `${SID}.jsonl`);
const subagentFile = (sid: string, agentId: string) => path.join(projectDir, sid, 'subagents', `agent-${agentId}.jsonl`);

describe('listClaudeSubagents', () => {
  it('follows each subagent from its Agent call to the notification that ends it', async () => {
    await writeJsonl(mainFile(), [
      agentCall('toolu_a', 'Backend batches', '2026-09-26T01:00:00Z'),
      launched('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z'),
      agentCall('toolu_b', 'Installer', '2026-09-26T01:00:02Z', 'Explore'),
      launched('toolu_b', 'bbbbbbbbbbbbbbbb2', '2026-09-26T01:00:03Z'),
      agentCall('toolu_c', 'Quick check', '2026-09-26T01:00:04Z'),
      ranInForeground('toolu_c', 'ccccccccccccccccc', '2026-09-26T01:00:05Z'),
      agentCall('toolu_d', 'Still going', '2026-09-26T01:00:06Z'),
      launched('toolu_d', 'ddddddddddddddddd', '2026-09-26T01:00:07Z'),
      // A background shell command's notification, not an agent's.
      notifiedAsUser(['b6fh7urnq'], 'failed', 'dev server exited', '2026-09-26T01:00:08Z'),
      notifiedAsUser(['aaaaaaaaaaaaaaaa1'], 'completed', 'Agent "Backend batches" finished', '2026-09-26T01:10:00Z'),
      notifiedAsAttachment(['bbbbbbbbbbbbbbbb2'], 'killed', 'stopped by user', '2026-09-26T01:11:00Z'),
    ]);

    expect(await listClaudeSubagents(mainFile())).toEqual([
      {
        agentId: 'aaaaaaaaaaaaaaaa1', description: 'Backend batches', subagentType: 'general-purpose', background: true,
        status: 'completed', startedAt: '2026-09-26T01:00:00Z', endedAt: '2026-09-26T01:10:00Z', summary: 'Agent "Backend batches" finished',
      },
      {
        agentId: 'bbbbbbbbbbbbbbbb2', description: 'Installer', subagentType: 'Explore', background: true,
        status: 'stopped', startedAt: '2026-09-26T01:00:02Z', endedAt: '2026-09-26T01:11:00Z', summary: 'stopped by user',
      },
      {
        agentId: 'ccccccccccccccccc', description: 'Quick check', subagentType: 'general-purpose', background: false,
        status: 'completed', startedAt: '2026-09-26T01:00:04Z', endedAt: '2026-09-26T01:00:05Z', summary: null,
      },
      {
        agentId: 'ddddddddddddddddd', description: 'Still going', subagentType: 'general-purpose', background: true,
        status: 'running', startedAt: '2026-09-26T01:00:06Z', endedAt: null, summary: null,
      },
    ]);
  });

  it('ends every agent one notification names, and a SendMessage sets one running again', async () => {
    await writeJsonl(mainFile(), [
      agentCall('toolu_a', 'A', '2026-09-26T01:00:00Z'),
      launched('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z'),
      agentCall('toolu_b', 'B', '2026-09-26T01:00:02Z'),
      launched('toolu_b', 'bbbbbbbbbbbbbbbb2', '2026-09-26T01:00:03Z'),
      notifiedAsUser(['aaaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbbb2'], 'stopped', '2 background agents did not finish', '2026-09-26T02:00:00Z'),
      sendMessage('aaaaaaaaaaaaaaaa1', '2026-09-26T03:00:00Z'),
    ]);

    const [a, b] = await listClaudeSubagents(mainFile());
    expect(a).toMatchObject({ agentId: 'aaaaaaaaaaaaaaaa1', status: 'running', endedAt: null, summary: null });
    expect(b).toMatchObject({ agentId: 'bbbbbbbbbbbbbbbb2', status: 'stopped', endedAt: '2026-09-26T02:00:00Z' });
  });

  it('marks a foreground subagent whose tool_result is an error as failed', async () => {
    await writeJsonl(mainFile(), [
      agentCall('toolu_a', 'A', '2026-09-26T01:00:00Z'),
      { ...ranInForeground('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z'),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', is_error: true, content: 'boom' }] } },
    ]);
    expect(await listClaudeSubagents(mainFile())).toMatchObject([{ status: 'failed', background: false }]);
  });

  it('lists nothing for a transcript with no subagents or no file', async () => {
    await writeJsonl(mainFile(), [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    expect(await listClaudeSubagents(mainFile())).toEqual([]);
    expect(await listClaudeSubagents(path.join(projectDir, 'missing.jsonl'))).toEqual([]);
  });
});

describe('locating and reading a subagent', () => {
  const subagentLines = [
    { type: 'user', isSidechain: true, agentId: 'aaaaaaaaaaaaaaaa1', timestamp: '2026-09-26T01:00:01Z', message: { role: 'user', content: 'Reply PONG' } },
    { type: 'assistant', isSidechain: true, agentId: 'aaaaaaaaaaaaaaaa1', timestamp: '2026-09-26T01:00:02Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PONG' }] } },
  ];

  it('finds a subagent under its own session directory, or one started before a continuation', async () => {
    await writeJsonl(subagentFile(SID, 'aaaaaaaaaaaaaaaa1'), subagentLines);
    await writeJsonl(subagentFile(OLD_SID, 'bbbbbbbbbbbbbbbb2'), subagentLines);
    expect(await locateClaudeSubagentFile(mainFile(), 'aaaaaaaaaaaaaaaa1')).toBe(subagentFile(SID, 'aaaaaaaaaaaaaaaa1'));
    expect(await locateClaudeSubagentFile(mainFile(), 'bbbbbbbbbbbbbbbb2')).toBe(subagentFile(OLD_SID, 'bbbbbbbbbbbbbbbb2'));
    expect(await locateClaudeSubagentFile(mainFile(), 'eeeeeeeeeeeeeeeee')).toBeNull();
  });

  it('never turns an id into a path', async () => {
    expect(await locateClaudeSubagentFile(mainFile(), '../x')).toBeNull();
    expect(await locateClaudeSubagentFile(mainFile(), 'a/b')).toBeNull();
  });

  it('reads the messages of an agent this conversation names, and nothing else', async () => {
    await writeJsonl(mainFile(), [
      agentCall('toolu_a', 'A', '2026-09-26T01:00:00Z'),
      launched('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z'),
    ]);
    await writeJsonl(subagentFile(SID, 'aaaaaaaaaaaaaaaa1'), subagentLines);
    // On disk, but not one of this conversation's.
    await writeJsonl(subagentFile(OLD_SID, 'fffffffffffffffff'), subagentLines);

    expect(await claudeAdapter.readSubagentMessages!(mainFile(), 'aaaaaaaaaaaaaaaa1')).toEqual([
      { role: 'user', text: 'Reply PONG', ts: '2026-09-26T01:00:01Z' },
      { role: 'assistant', text: 'PONG', ts: '2026-09-26T01:00:02Z' },
    ]);
    expect(await claudeAdapter.readSubagentMessages!(mainFile(), 'fffffffffffffffff')).toBeNull();
  });

  it('returns null for a named agent whose transcript is gone', async () => {
    await writeJsonl(mainFile(), [
      agentCall('toolu_a', 'A', '2026-09-26T01:00:00Z'),
      launched('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z'),
    ]);
    expect(await claudeAdapter.readSubagentMessages!(mainFile(), 'aaaaaaaaaaaaaaaa1')).toBeNull();
  });
});

describe('the background agents still out (the poller\'s cheap signal)', () => {
  it('are the launched ones no notification has ended, foreground ones never', async () => {
    await writeJsonl(mainFile(), [
      agentCall('toolu_a', 'Done', '2026-09-26T01:00:00Z'),
      launched('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z'),
      agentCall('toolu_b', 'Still going', '2026-09-26T01:00:02Z'),
      launched('toolu_b', 'bbbbbbbbbbbbbbbb2', '2026-09-26T01:00:03Z'),
      agentCall('toolu_c', 'Foreground', '2026-09-26T01:00:04Z'),
      ranInForeground('toolu_c', 'ccccccccccccccccc', '2026-09-26T01:00:05Z'),
      notifiedAsAttachment(['aaaaaaaaaaaaaaaa1'], 'completed', 'ok', '2026-09-26T01:00:06Z'),
    ]);
    expect(await openClaudeSubagents(mainFile())).toEqual([
      { agentId: 'bbbbbbbbbbbbbbbb2', startedAt: '2026-09-26T01:00:02Z', since: '2026-09-26T01:00:02Z' },
    ]);
    expect(claudeAdapter.openBackgroundSubagents).toBe(openClaudeSubagents);
    // The main transcript is the authority: nothing further to confirm.
    expect(claudeAdapter.subagentStillRunning).toBeUndefined();
  });

  it('follows the transcript as it grows: a notification ends one, a SendMessage sets it running again', async () => {
    const head = [agentCall('toolu_a', 'Job', '2026-09-26T01:00:00Z'), launched('toolu_a', 'aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:01Z')];
    await writeJsonl(mainFile(), head);
    expect(await openClaudeSubagents(mainFile())).toHaveLength(1);
    const ended = [...head, notifiedAsUser(['aaaaaaaaaaaaaaaa1'], 'completed', 'ok', '2026-09-26T01:00:02Z')];
    await writeJsonl(mainFile(), ended);
    expect(await openClaudeSubagents(mainFile())).toEqual([]);
    await writeJsonl(mainFile(), [...ended, sendMessage('aaaaaaaaaaaaaaaa1', '2026-09-26T01:00:03Z')]);
    expect(await openClaudeSubagents(mainFile())).toHaveLength(1);
  });
});
