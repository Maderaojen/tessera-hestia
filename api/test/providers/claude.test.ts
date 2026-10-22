import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { buildClaudeResume, claudeCodeRuntime } from '../../src/runtimes/claude-code.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'claude-fixture-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function jsonlOf(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('claudeAdapter mid-turn follow-ups (queued_command)', () => {
  // How Claude Code records a prompt sent while it is still replying: a
  // queue-operation pair and a queued_command attachment, never a user
  // message. Task notifications and peer messages ride the same attachment.
  const queued = (prompt: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
    type: 'attachment',
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp, ...extra },
    timestamp,
  });
  const records = [
    { type: 'user', message: { role: 'user', content: 'fix the session list' }, timestamp: '2026-09-25T00:40:00Z' },
    { type: 'queue-operation', operation: 'enqueue', content: 'also the project menu', timestamp: '2026-09-25T00:40:05Z' },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: '2026-09-25T00:40:06Z' },
    queued('also the project menu', '2026-09-25T00:40:05Z'),
    queued('<task-notification>\n<task-id>x</task-id>', '2026-09-25T00:40:07Z', { commandMode: 'task-notification', origin: undefined }),
    queued('<cross-session-message from="u1">hi</cross-session-message>', '2026-09-25T00:40:08Z', { origin: { kind: 'peer' } }),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Both done.' }] }, timestamp: '2026-09-25T00:41:00Z' },
  ];

  it('keeps them out of parseMessages, which only lists real user/assistant messages', async () => {
    const file = path.join(dir, 'queued.jsonl');
    await writeFile(file, jsonlOf(records));
    expect((await claudeAdapter.parseMessages(file)).map((m) => m.text)).toEqual(['fix the session list', 'Both done.']);
  });

  it('lists only human prompts from parseFollowUps', async () => {
    const file = path.join(dir, 'queued.jsonl');
    await writeFile(file, jsonlOf(records));
    expect(await claudeAdapter.parseFollowUps!(file)).toEqual([
      { role: 'user', text: 'also the project menu', ts: '2026-09-25T00:40:05Z', followUp: true },
    ]);
  });

  it('shows them in the turn they joined', async () => {
    const file = path.join(dir, 'queued.jsonl');
    await writeFile(file, jsonlOf(records));
    expect(await claudeAdapter.parseTurns(file)).toEqual([{
      index: 1,
      user: { text: 'fix the session list', at: '2026-09-25T00:40:00Z' },
      followUps: [{ text: 'also the project menu', at: '2026-09-25T00:40:05Z' }],
      assistant: { text: 'Both done.', at: '2026-09-25T00:41:00Z' },
    }]);
  });
});

describe('claudeAdapter.parseTurns', () => {
  it('assembles a complete turn from a realistic transcript, skipping tool blocks and wrapper messages', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'file-history-snapshot' }, // non user/assistant record — ignored
        {
          type: 'user',
          message: { role: 'user', content: '<local-command-stdout>ready</local-command-stdout>' },
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          type: 'user',
          message: { role: 'user', content: 'what does this function do?' },
          timestamp: '2026-01-01T00:00:01Z',
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } }],
          },
          timestamp: '2026-01-01T00:00:02Z',
        },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents...' }] },
          timestamp: '2026-01-01T00:00:03Z',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'It parses the config.' }] },
          timestamp: '2026-01-01T00:00:04Z',
        },
      ]),
      'utf-8',
    );

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('what does this function do?');
    expect(turns[0].assistant.text).toBe('It parses the config.');
  });

  it('drops a trailing user message with no assistant reply yet', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', message: { role: 'user', content: 'first' }, timestamp: 't1' },
        { type: 'assistant', message: { role: 'assistant', content: 'reply' }, timestamp: 't2' },
        { type: 'user', message: { role: 'user', content: 'second, still in flight' }, timestamp: 't3' },
      ]),
      'utf-8',
    );

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('first');
  });

  it('ignores a CLI-injected isMeta "[Image: ...]" companion so it never overwrites the real user text', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        {
          type: 'user',
          message: { role: 'user', content: '請看這張圖片：/uploads/sess-1/photo.png' },
          timestamp: 't1',
        },
        {
          type: 'user',
          isMeta: true,
          turnCompanion: true,
          message: { role: 'user', content: '[Image: original 935x2048, displayed at 913x2000. Multiply coordinates by 1.02 to map to original image.]' },
          timestamp: 't2',
        },
        { type: 'assistant', message: { role: 'assistant', content: 'I see the photo.' }, timestamp: 't3' },
      ]),
      'utf-8',
    );

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('請看這張圖片：/uploads/sess-1/photo.png');
    expect(turns[0].assistant.text).toBe('I see the photo.');
  });

  it('keeps a background-task notification out of the user side, merging the reply it prompted into the previous turn', async () => {
    // Record shapes as Claude Code 2.1.281 writes them: a failed subagent's
    // <task-notification> is user-role, has no isMeta, and is tagged only by
    // origin/promptSource. Real input is origin.kind "human".
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '派 subagent 做完' }, timestamp: '2026-09-24T04:16:05Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已派出第 2 段。' }] }, timestamp: '2026-09-24T04:16:10Z' },
        {
          type: 'user',
          origin: { kind: 'task-notification' },
          promptSource: 'system',
          turnOrigin: 'task_notification',
          message: { role: 'user', content: '<task-notification>\n<task-id>ad98b9abbecd30413</task-id>\n<status>failed</status>\n</task-notification>' },
          timestamp: '2026-09-24T04:28:35Z',
        },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第 2 段因 429 停了。' }] }, timestamp: '2026-09-24T04:28:40Z' },
        { type: 'user', origin: { kind: 'coordinator' }, message: { role: 'user', content: 'The coordinator sent a message while you were working' }, timestamp: '2026-09-24T04:30:00Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] }, timestamp: '2026-09-24T04:30:05Z' },
        { type: 'user', origin: { kind: 'human' }, promptSource: 'queued', message: { role: 'user', content: '請繼續。' }, timestamp: '2026-09-24T06:27:08Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '繼續。' }] }, timestamp: '2026-09-24T06:27:10Z' },
      ]),
      'utf-8',
    );

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns.map((t) => t.user.text)).toEqual(['派 subagent 做完', '請繼續。']);
    expect(turns[0].assistant.text).toBe('已派出第 2 段。\n\n第 2 段因 429 停了。\n\n收到。');
  });

  it('still reads human input tagged typed / queued / suggestion_accepted, and SDK prompts', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        ...['typed', 'queued', 'suggestion_accepted'].flatMap((promptSource, i) => [
          { type: 'user', origin: { kind: 'human' }, promptSource, message: { role: 'user', content: `q${i}` }, timestamp: `t${i}a` },
          { type: 'assistant', message: { role: 'assistant', content: `a${i}` }, timestamp: `t${i}b` },
        ]),
        { type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'sdk prompt' }, timestamp: 't9a' },
        { type: 'assistant', message: { role: 'assistant', content: 'sdk reply' }, timestamp: 't9b' },
      ]),
      'utf-8',
    );

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns.map((t) => t.user.text)).toEqual(['q0', 'q1', 'q2', 'sdk prompt']);
  });

  it('tolerates a truncated trailing line from a mid-write poll', async () => {
    const file = path.join(dir, 'session.jsonl');
    const good = jsonlOf([
      { type: 'user', message: { role: 'user', content: 'first' }, timestamp: 't1' },
      { type: 'assistant', message: { role: 'assistant', content: 'reply' }, timestamp: 't2' },
    ]);
    await writeFile(file, good + '{"type":"assistant","message":{"role":"assistant","conte', 'utf-8');

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
  });
});

describe('claudeAdapter — the CLI compacting the conversation', () => {
  const FIXTURES = path.join(import.meta.dirname, '../fixtures/turn-boundaries');
  // Real transcript (2.1.296), cut down and scrubbed: a finished turn, then
  // "Compacted while idle, before the prompt cache expired" — a
  // compact_boundary, the isCompactSummary user record, attachments, an
  // informational notice. No reply follows.
  const idle = path.join(FIXTURES, 'claude.idle-compaction.2.1.296.jsonl');

  async function beforeCompaction(): Promise<string> {
    const lines = (await readFile(idle, 'utf8')).trim().split('\n');
    const file = path.join(dir, 'before.jsonl');
    await writeFile(file, lines.slice(0, lines.findIndex((line) => line.includes('compact_boundary'))).join('\n') + '\n');
    return file;
  }

  it('reads an idle compaction as no message and no turn', async () => {
    const before = await beforeCompaction();
    const messages = await claudeAdapter.parseMessages(idle);
    expect(messages).toEqual(await claudeAdapter.parseMessages(before));
    expect(messages.at(-1)?.role).toBe('assistant');
    expect(messages.some((message) => message.text.includes('continued from a previous conversation'))).toBe(false);
    expect(await claudeAdapter.parseFollowUps!(idle)).toEqual([]);
    const turns = await claudeAdapter.parseTurns(idle);
    expect(turns).toEqual(await claudeAdapter.parseTurns(before));
    expect(turns.map((turn) => turn.user.text)).toEqual(['look at the modal layout']);
    expect(await claudeAdapter.isTurnComplete(idle)).toEqual({ status: 'supported', value: true });
    expect(await claudeAdapter.openTurnAtEnd!(idle)).toBeNull();
  });

  it('names when it wrote its summary', async () => {
    expect(await claudeAdapter.parseCompactionSummaryTimes!(idle)).toEqual(['2026-10-11T02:27:31.195Z']);
    expect(await claudeAdapter.parseCompactionSummaryTimes!(await beforeCompaction())).toEqual([]);
  });

  // Same records mid-turn (auto-compaction, seen in 2.1.269 and 2.1.283):
  // the reply carries on after the summary and stays the user's turn.
  it('keeps a reply that goes on after a mid-turn compaction in the turn it belongs to', async () => {
    const file = path.join(dir, 'mid-turn.jsonl');
    await writeFile(file, jsonlOf([
      { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'refactor it' }, timestamp: '2026-09-26T07:00:00Z' },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Starting.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: '2026-09-26T07:00:01Z' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: '2026-09-26T07:00:02Z' },
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' }, timestamp: '2026-09-26T07:31:01Z' },
      { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. (summary)' }, timestamp: '2026-09-26T07:31:00Z' },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }, timestamp: '2026-09-26T07:32:00Z' },
    ]));
    const turns = await claudeAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ user: { text: 'refactor it' }, assistant: { text: 'Done.' } });
  });
});

describe('claudeCodeRuntime.buildLaunch', () => {
  it('pins a session id and includes it in argv', () => {
    const plan = claudeCodeRuntime.buildLaunch('/some/cwd');
    expect(plan.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.argv).toEqual(['claude', '--session-id', plan.providerSessionId]);
  });
});

describe('claudeCodeRuntime.buildResume', () => {
  it('resumes exactly the saved native Claude session without creating a new id', () => {
    expect(buildClaudeResume('a13782f4-715f-4abc-9233-2207319a1234')).toEqual({
      argv: ['claude', '--resume', 'a13782f4-715f-4abc-9233-2207319a1234'],
      providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234',
    });
  });

  it('rejects an empty or option-shaped session id', () => {
    expect(() => buildClaudeResume('')).toThrow();
    expect(() => buildClaudeResume('--help')).toThrow();
  });
});

describe('claudeAdapter.findPendingInteraction', () => {
  it('returns null when there is no tool_use at all', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: 't1' },
        { type: 'assistant', message: { role: 'assistant', content: 'hello' }, timestamp: 't2' },
      ]),
      'utf-8',
    );
    expect(await claudeAdapter.findPendingInteraction(file)).toEqual({ status: 'supported', value: null });
  });

  it('detects an unresolved tool_use as a pending interaction', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', message: { role: 'user', content: 'write a file' }, timestamp: 't1' },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Write', input: { file_path: 'x.txt' } }],
          },
          timestamp: 't2',
        },
      ]),
      'utf-8',
    );
    const pending = await claudeAdapter.findPendingInteraction(file);
    expect(pending).toEqual({ status: 'supported', value: {
      kind: 'tool_permission',
      toolUseId: 'toolu_abc',
      toolName: 'Write',
      input: { file_path: 'x.txt' },
      detectedAt: 't2',
    } });
  });

  it('returns null once a matching tool_result appears (approved or denied)', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', message: { role: 'user', content: 'write a file' }, timestamp: 't1' },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Write', input: { file_path: 'x.txt' } }],
          },
          timestamp: 't2',
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', is_error: true, content: 'User rejected' }],
          },
          timestamp: 't3',
        },
      ]),
      'utf-8',
    );
    expect(await claudeAdapter.findPendingInteraction(file)).toEqual({ status: 'supported', value: null });
  });
});

describe('claudeAdapter.isTurnComplete', () => {
  it('is true once the last assistant message has stop_reason end_turn', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: 't1' },
        {
          type: 'assistant',
          message: { role: 'assistant', content: 'hello', stop_reason: 'end_turn' },
          timestamp: 't2',
        },
      ]),
      'utf-8',
    );
    expect(await claudeAdapter.isTurnComplete(file)).toEqual({ status: 'supported', value: true });
  });

  it('is false while the last assistant message stopped for a tool call, even with a long quiet gap after it', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'user', message: { role: 'user', content: 'run something' }, timestamp: 't1' },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'On it.' }],
            stop_reason: 'end_turn',
          },
          timestamp: 't2',
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 30' } }],
            stop_reason: 'tool_use',
          },
          timestamp: 't3',
        },
      ]),
      'utf-8',
    );
    expect(await claudeAdapter.isTurnComplete(file)).toEqual({ status: 'supported', value: false });
  });

  it('is true (nothing to gate on) when no assistant message has been written yet', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      jsonlOf([{ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: 't1' }]),
      'utf-8',
    );
    expect(await claudeAdapter.isTurnComplete(file)).toEqual({ status: 'supported', value: true });
  });
});

describe('claudeAdapter.locateSessionFile', () => {
  it('returns null when providerSessionId is not set yet', async () => {
    const found = await claudeAdapter.locateSessionFile({
      cwd: '/x',
      providerSessionId: null,
      launchedAfter: new Date().toISOString(),
    });
    expect(found).toEqual({ status: 'not_found' });
  });

  it('looks for the pinned UUID under the selected profile transcript root', async () => {
    const root = path.join(dir, 'janus-home', 'projects');
    const projectDir = path.join(root, 'encoded-project');
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(file, '{}\n', 'utf-8');
    await expect(claudeAdapter.locateSessionFile({
      cwd: '/ignored', providerSessionId: sessionId, launchedAfter: new Date(0).toISOString(), conversationRoot: root,
    })).resolves.toEqual({ status: 'resolved', file, identity: 'pinned_id' });
  });
});

describe('claudeAdapter.parseTurns — interrupted replies', () => {
  const user = (text: string, ts: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });
  const assistant = (text: string, ts: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts });

  it('closes a partially generated reply, flagged as interrupted', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, jsonlOf([
      user('explain the build', '2026-01-01T00:00:01Z'),
      assistant('The build first', '2026-01-01T00:00:02Z'),
      user('[Request interrupted by user]', '2026-01-01T00:00:03Z'),
      user('next question', '2026-01-01T00:00:04Z'),
      assistant('answer', '2026-01-01T00:00:05Z'),
    ]), 'utf-8');

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns.map((turn) => [turn.user.text, turn.assistant.text, turn.assistant.interrupted])).toEqual([
      ['explain the build', 'The build first', true],
      ['next question', 'answer', undefined],
    ]);
  });

  it('keeps the user message as a turn when it was stopped before any text was generated', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, jsonlOf([
      user('explain the build', '2026-01-01T00:00:01Z'),
      user('[Request interrupted by user for tool use]', '2026-01-01T00:00:02Z'),
    ]), 'utf-8');

    const turns = await claudeAdapter.parseTurns(file);
    expect(turns).toEqual([{
      index: 1,
      user: { text: 'explain the build', at: '2026-01-01T00:00:01Z' },
      assistant: { text: '', at: '2026-01-01T00:00:02Z', interrupted: true },
    }]);
  });
});

describe('claudeAdapter pane reading (captured from Claude Code 2.1.281)', () => {
  const prompt = [
    '● Bash(touch probe-file.txt)',
    '  ⎿  Waiting…',
    ' Bash command',
    '   touch probe-file.txt',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to /tmp/x from this project',
    '   4. No',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
  const running = [
    '  Bash(sleep 2)',
    '  ⎿  Running…',
    '✽ Cerebrating… (1m 33s · ↓ 4.0k tokens)',
    '❯ ',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent',
  ].join('\n');
  const idle = ['❯ Try "refactor <filepath>"', '  ⏸ manual mode on · ? for shortcuts'].join('\n');

  it('recognizes a real permission prompt, and not a tool that is merely running', () => {
    expect(claudeAdapter.paneShowsPermissionPrompt?.(prompt)).toBe(true);
    expect(claudeAdapter.paneShowsPermissionPrompt?.(running)).toBe(false);
    expect(claudeAdapter.paneShowsPermissionPrompt?.(idle)).toBe(false);
  });

  it('reads the busy footer', () => {
    expect(claudeAdapter.paneShowsBusy?.(running)).toBe(true);
    expect(claudeAdapter.paneShowsBusy?.(idle)).toBe(false);
    expect(claudeAdapter.paneShowsBusy?.(prompt)).toBe(false);
  });

  // Real panes captured from Claude Code 2.1.281 in a throwaway tmux
  // (133x40, the size every managed pane gets), trimmed to the lines that
  // matter. Rules are full pane width.
  const rule = '─'.repeat(133);
  const manualIdle = [
    '▎ ※ Claim a one-time $100 credit for cloud sessions · /claim-credit',
    '',
    rule,
    '❯ Try "write a test for <filepath>"',
    rule,
    '  ⏸ manual mode on · ? for shortcuts · ← 1 agent                                                                 ◐ medium · /effort',
  ].join('\n');
  const autoIdle = [
    rule,
    '❯ Try "refactor <filepath>"',
    rule,
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent                                                               ◐ medium · /effort',
  ].join('\n');
  const idleAfterReply = [
    '❯ Reply with just the word ok',
    '',
    '● ok',
    '',
    '✻ Churned for 1s · done 上午10:38',
    '',
    rule,
    '❯ ',
    rule,
    '  ⏸ manual mode on · ? for shortcuts · ← 1 agent                                                                 ◐ medium · /effort',
  ].join('\n');
  const busy = [
    '❯ Reply with just the word ok',
    '',
    '✽ Puttering…',
    '  ⎿  Tip: Try setting environment variable COLORTERM=truecolor for richer colors',
    '',
    rule,
    '❯ ',
    rule,
    '  ⏸ manual mode on · esc to interrupt · ← 1 agent                                                                ◐ medium · /effort',
  ].join('\n');
  // /status replaces the input box with its panel; the submitted command
  // stays echoed above it without a rule of its own.
  const statusPanel = [
    '▎ ※ Claim a one-time $100 credit for cloud sessions · /claim-credit',
    '',
    '❯ /status',
    '',
    rule,
    '  Settings  Status   Config   Usage   Stats',
    '',
    '  Version:           2.1.281',
    '  Session kind:      interactive',
    '  Auto mode server:  Disabled',
    '',
    '  Esc to cancel',
  ].join('\n');

  it('reads the input box as idle in both manual and auto mode', () => {
    expect(claudeAdapter.paneShowsIdle?.(manualIdle)).toBe(true);
    expect(claudeAdapter.paneShowsIdle?.(autoIdle)).toBe(true);
    expect(claudeAdapter.paneShowsIdle?.(idleAfterReply)).toBe(true);
  });

  it('never reads busy, a permission prompt or the /status panel as idle', () => {
    expect(claudeAdapter.paneShowsBusy?.(busy)).toBe(true);
    expect(claudeAdapter.paneShowsIdle?.(busy)).toBe(false);
    expect(claudeAdapter.paneShowsIdle?.(running)).toBe(false);
    expect(claudeAdapter.paneShowsIdle?.(prompt)).toBe(false);
    expect(claudeAdapter.paneShowsIdle?.(statusPanel)).toBe(false);
    expect(claudeAdapter.paneShowsBusy?.(statusPanel)).toBe(false);
  });

  // Captured (2.1.283, `claude -n 測試名稱`): the name sits on the top rule.
  it('reads the input box of a named session as idle', () => {
    const named = [
      `${'─'.repeat(115)} 測試名稱 ─`,
      '❯ Try "create a util logging.py that..."',
      rule,
      '  ⏵⏵ auto mode on (shift+tab to cycle)                                                                        ◐ medium · /effort',
    ].join('\n');
    expect(claudeAdapter.paneShowsIdle?.(named)).toBe(true);
    expect(claudeAdapter.paneShowsIdle?.(named.replace('auto mode on (shift+tab to cycle)', 'esc to interrupt'))).toBe(false);
  });

  // Constructed, not captured: the box's closing rule is searched for below
  // the "❯" line rather than required on the very next line.
  it('still reads idle while a multi-line draft sits in the input box', () => {
    const draft = [rule, '❯ first line of a draft', '  second line', rule, '  ⏸ manual mode on · ? for shortcuts'].join('\n');
    expect(claudeAdapter.paneShowsIdle?.(draft)).toBe(true);
  });
});

describe('claudeAdapter.followContinuation', () => {
  const A = '00b2b11c-bc15-4d25-a8e5-7e6f2f78a381';
  const B = '4ae40389-e4d0-4054-87de-eed094dcf2ec';
  const C = '9d1f2e3a-1111-4222-8333-444455556666';
  const fileOf = (id: string) => path.join(dir, `${id}.jsonl`);
  const marker = (from: string, to: string) => ({ type: 'continued-in', timestamp: '2026-09-24T02:51:06.471Z', sessionId: from, continuedInSessionId: to });
  const record = (id: string) => ({ type: 'ai-title', sessionId: id });

  it('follows the continued-in chain to the newest transcript', async () => {
    await writeFile(fileOf(A), jsonlOf([record(A), marker(A, B)]), 'utf-8');
    await writeFile(fileOf(B), jsonlOf([record(B), marker(B, C)]), 'utf-8');
    await writeFile(fileOf(C), jsonlOf([record(C), { type: 'user', sessionId: C, message: { role: 'user', content: 'hi' } }]), 'utf-8');

    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toEqual({ file: fileOf(C), providerSessionId: C });
    expect(await claudeAdapter.followContinuation?.(fileOf(C))).toBeNull();
  });

  it('only honours the marker as the final record', async () => {
    await writeFile(fileOf(A), jsonlOf([record(A), marker(A, B), { type: 'user', sessionId: A, message: { role: 'user', content: 'later' } }]), 'utf-8');
    await writeFile(fileOf(B), jsonlOf([record(B)]), 'utf-8');
    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toBeNull();
  });

  it('refuses a missing target, a target that is not that session, or a marker naming another file', async () => {
    await writeFile(fileOf(A), jsonlOf([record(A), marker(A, B)]), 'utf-8');
    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toBeNull();

    await writeFile(fileOf(B), jsonlOf([record(C)]), 'utf-8');
    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toBeNull();

    await writeFile(fileOf(B), jsonlOf([record(B)]), 'utf-8');
    await writeFile(fileOf(A), jsonlOf([record(A), marker(C, B)]), 'utf-8');
    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toBeNull();
  });

  it('stops at the last good hop when a later link is broken', async () => {
    await writeFile(fileOf(A), jsonlOf([record(A), marker(A, B)]), 'utf-8');
    await writeFile(fileOf(B), jsonlOf([record(B), marker(B, C)]), 'utf-8');
    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toEqual({ file: fileOf(B), providerSessionId: B });
  });

  it('reads only the ends of a large transcript', async () => {
    const filler = Array.from({ length: 3000 }, (_, i) => ({ type: 'user', sessionId: A, message: { role: 'user', content: `line ${i} ${'x'.repeat(40)}` } }));
    await writeFile(fileOf(A), jsonlOf([record(A), ...filler, marker(A, B)]), 'utf-8');
    await writeFile(fileOf(B), jsonlOf([record(B)]), 'utf-8');
    expect(await claudeAdapter.followContinuation?.(fileOf(A))).toEqual({ file: fileOf(B), providerSessionId: B });
  });
});
