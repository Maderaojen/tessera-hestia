import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProcessCache } from '../../src/process/cache.js';
import type { ManagedSession } from '../../src/types.js';

vi.mock('../../src/sync/binding.js', () => ({ resolvedBinding: vi.fn() }));
const { resolvedBinding } = await import('../../src/sync/binding.js');
const { readSubagentProcess, subagentPublicTurns } = await import('../../src/process/subagents.js');

const SID = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a1b2c3d4e5f6a7b8c';
let dir: string;

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-subagent-process-'));
  clearProcessCache();
  const main = path.join(dir, `${SID}.jsonl`);
  await writeJsonl(main, [
    { type: 'user', timestamp: '2026-10-12T00:00:00Z', origin: { kind: 'human' }, message: { role: 'user', content: '查一下' } },
    { type: 'assistant', timestamp: '2026-10-12T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: '查 build', prompt: 'do it' } }] } },
    { type: 'user', timestamp: '2026-10-12T00:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'done' }] }, toolUseResult: { status: 'completed', agentId: AGENT } },
  ]);
  // A subagent's own transcript: every record is a sidechain one.
  const side = { isSidechain: true, agentId: AGENT };
  await writeJsonl(path.join(dir, SID, 'subagents', `agent-${AGENT}.jsonl`), [
    { ...side, type: 'user', timestamp: '2026-10-12T00:00:02Z', message: { role: 'user', content: 'do it' } },
    { ...side, type: 'assistant', timestamp: '2026-10-12T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: '先跑 build。' }] } },
    { ...side, type: 'assistant', timestamp: '2026-10-12T00:00:04Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm run build' } }] } },
    { ...side, type: 'user', timestamp: '2026-10-12T00:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok' }] } },
    { ...side, type: 'assistant', timestamp: '2026-10-12T00:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'build 通過。' }] } },
  ]);
  vi.mocked(resolvedBinding).mockReturnValue({ file: main, conversation: { provider: 'claude' } } as never);
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('readSubagentProcess', () => {
  it('reads a subagent\'s own transcript into turns with their tools', async () => {
    const process = await readSubagentProcess({} as ManagedSession, AGENT);
    expect(process?.turns).toHaveLength(1);
    const [turn] = subagentPublicTurns(process!, false);
    expect(turn!.user.text).toBe('do it');
    expect(turn!.process).toMatchObject({
      status: 'available', open: false,
      parts: [{ kind: 'progress', text: '先跑 build。' }, { kind: 'reply', text: 'build 通過。' }],
      counts: { run: 1 },
    });
    expect(turn!.assistant.text).toBe('先跑 build。\n\nbuild 通過。');
  });

  it('marks the latest turn open while the subagent runs', async () => {
    const process = await readSubagentProcess({} as ManagedSession, AGENT);
    expect(subagentPublicTurns(process!, true).at(-1)!.process).toMatchObject({ open: true });
  });

  it('knows only subagents its conversation names', async () => {
    expect(await readSubagentProcess({} as ManagedSession, 'ffffffffffffffff0')).toBeNull();
  });
});
