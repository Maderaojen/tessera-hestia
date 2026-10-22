import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexAdapter, rolloutSearchRoots } from '../../src/providers/codex.js';
import { codexSubagentStillRunning, listCodexSubagents, openCodexSubagents, readCodexSubagentMessages } from '../../src/providers/codex-subagents.js';

// Scrubbed from Codex 0.162.1 rollouts: real record shapes, invented ids and
// text (test/fixtures/subagents/).
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/subagents');
const PARENT = '01a12360-1111-7111-8111-111111111111';
const CHILD = '01a12362-2222-7222-8222-222222222222';
const INTERRUPTED = '01a12363-3333-7333-8333-333333333333';

type Row = Record<string, unknown> & { payload?: Record<string, unknown> };

async function fixture(name: string): Promise<Row[]> {
  const text = await readFile(path.join(FIXTURES, name), 'utf-8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Row);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagents-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Where Codex would put this id's rollout: sessions/YYYY/MM/DD by its date.
function rolloutPath(id: string, stamp = '2026-10-10T10-15-41'): string {
  return path.join(rolloutSearchRoots(root, id)[1]!, `rollout-${stamp}-${id}.jsonl`);
}

async function writeJsonl(file: string, rows: unknown[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
  return file;
}

async function setup(options: { parent?: Row[]; child?: Row[] | null } = {}): Promise<string> {
  const parent = await writeJsonl(rolloutPath(PARENT, '2026-10-10T09-28-47'), options.parent ?? await fixture('codex.parent.0.162.1.jsonl'));
  if (options.child !== null) await writeJsonl(rolloutPath(CHILD), options.child ?? await fixture('codex.child.0.162.1.jsonl'));
  return parent;
}

const upTo = (rows: Row[], predicate: (row: Row) => boolean) => rows.slice(0, rows.findIndex(predicate) + 1);
const isType = (type: string) => (row: Row) => row.payload?.type === type;

describe('listCodexSubagents', () => {
  it('lists the direct children this conversation started, a follow-up setting one running again', async () => {
    const list = await listCodexSubagents(await setup());
    expect(list).toEqual([
      {
        agentId: CHILD, description: 'build_check (Nova)', subagentType: null, background: true, status: 'running',
        startedAt: '2026-10-10T02:15:02.000Z', endedAt: null, summary: null, model: 'gpt-test',
      },
      // No rollout of its own here: what the parent last said (interrupted).
      {
        agentId: INTERRUPTED, description: 'lint_pass', subagentType: null, background: true, status: 'stopped',
        startedAt: '2026-10-10T02:15:03.000Z', endedAt: '2026-10-10T02:15:06.000Z', summary: null, model: 'gpt-test-mini',
      },
    ]);
  });

  it('reports completed, with its final answer, once its turn completes', async () => {
    const child = await fixture('codex.child.0.162.1.jsonl');
    const list = await listCodexSubagents(await setup({ child: upTo(child, isType('task_complete')) }));
    expect(list[0]).toMatchObject({
      status: 'completed', endedAt: '2026-10-10T02:15:30.000Z', summary: 'Build passes on all targets.',
    });
  });

  it('reports stopped when its turn was aborted', async () => {
    const child = await fixture('codex.child.0.162.1.jsonl');
    const aborted = { ...child.at(-1)!, ordinal: 99, timestamp: '2026-10-10T02:17:00.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't', reason: 'interrupted' } };
    const list = await listCodexSubagents(await setup({ child: [...child, aborted] }));
    expect(list[0]).toMatchObject({ status: 'stopped', endedAt: '2026-10-10T02:17:00.000Z' });
  });

  it("falls back to the parent's word when the child's rollout is missing", async () => {
    const parent = await fixture('codex.parent.0.162.1.jsonl');
    const completed = upTo(parent, (row) => (row.payload?.item as Row | undefined)?.kind === 'completed');
    const list = await listCodexSubagents(await setup({ parent: completed, child: null }));
    expect(list[0]).toMatchObject({
      agentId: CHILD, description: 'build_check', status: 'completed', endedAt: '2026-10-10T02:15:30.000Z', summary: 'Build passes on all targets.',
    });
    const running = await listCodexSubagents(await setup({ parent: parent.slice(0, 4), child: null }));
    expect(running[0]).toMatchObject({ agentId: CHILD, status: 'running', endedAt: null });
  });

  it("ignores a rollout that doesn't name this conversation as its parent", async () => {
    const child = await fixture('codex.child.0.162.1.jsonl');
    const foreign = structuredClone(child);
    foreign[0]!.payload!.parent_thread_id = '01a12360-9999-7999-8999-999999999999';
    const list = await listCodexSubagents(await setup({ child: foreign }));
    // Treated as missing: the parent says the latest is a follow-up.
    expect(list[0]).toMatchObject({ description: 'build_check', status: 'running' });
    expect(await readCodexSubagentMessages(rolloutPath(PARENT, '2026-10-10T09-28-47'), CHILD)).toBeNull();
  });

  it('treats a child\'s "/root" activity as its talk with the parent, not a child of its own', async () => {
    await setup();
    // The child's rollout read as a conversation of its own lists nothing:
    // its only SubAgentActivity is with "/root".
    expect(await listCodexSubagents(rolloutPath(CHILD))).toEqual([]);
  });

  it('is what the Codex adapter offers', async () => {
    const parent = await setup();
    expect(await codexAdapter.listSubagents!(parent)).toHaveLength(2);
  });
});

describe('readCodexSubagentMessages', () => {
  it("reads the child's own messages, without the parent history it was forked with", async () => {
    const messages = await readCodexSubagentMessages(await setup(), CHILD);
    expect(messages).toEqual([
      { role: 'assistant', text: 'Running the build now.', ts: '2026-10-10T02:15:04.000Z' },
      { role: 'assistant', text: 'Build passes on all targets.', ts: '2026-10-10T02:15:29.000Z' },
      { role: 'assistant', text: 'Re-running with the cache cleared.', ts: '2026-10-10T02:16:02.000Z' },
    ]);
  });

  it('starts after the copied history even without subagent_history_start_ordinal', async () => {
    const child = structuredClone(await fixture('codex.child.0.162.1.jsonl'));
    delete child[0]!.payload!.subagent_history_start_ordinal;
    const messages = await readCodexSubagentMessages(await setup({ child }), CHILD);
    expect(messages?.map((message) => message.text)).not.toContain('Check the build and the lint in parallel.');
    expect(messages).toHaveLength(3);
  });

  it('reads nothing for ids the conversation never started, or that are not ids', async () => {
    const parent = await setup();
    expect(await readCodexSubagentMessages(parent, '01a12364-4444-7444-8444-444444444444')).toBeNull(); // a grandchild
    expect(await readCodexSubagentMessages(parent, '01a12399-0000-7000-8000-000000000000')).toBeNull();
    expect(await readCodexSubagentMessages(parent, '../../etc/passwd')).toBeNull();
    expect(await readCodexSubagentMessages(parent, 'aaaaaaaaaaaaaaaa1')).toBeNull(); // a Claude id
  });

  it('is null when the child has no rollout yet', async () => {
    expect(await readCodexSubagentMessages(await setup({ child: null }), CHILD)).toBeNull();
  });
});

describe('the background children still out (the poller\'s cheap signal)', () => {
  it("counts the parent's started or interacted children with no end since, from its rollout alone", async () => {
    // build_check: interacted again after it completed; lint_pass: interrupted;
    // the grandchild is not a direct child.
    expect(await openCodexSubagents(await setup({ child: null }))).toEqual([
      { agentId: CHILD, startedAt: '2026-10-10T02:15:02.000Z', since: '2026-10-10T02:16:01.000Z' },
    ]);
  });

  it('has none once the parent records the end', async () => {
    const parent = await fixture('codex.parent.0.162.1.jsonl');
    const completed = upTo(parent, (row) => (row.payload?.item as Row | undefined)?.kind === 'completed');
    expect(await openCodexSubagents(await setup({ parent: completed, child: null }))).toEqual([]);
  });

  it('sees a child appended to the rollout after an earlier read', async () => {
    const parent = await fixture('codex.parent.0.162.1.jsonl');
    const file = await setup({ parent: parent.slice(0, 3), child: null });
    expect(await openCodexSubagents(file)).toEqual([]);
    await writeJsonl(file, parent.slice(0, 4));
    expect((await openCodexSubagents(file)).map((agent) => agent.agentId)).toEqual([CHILD]);
  });

  it('is what the Codex adapter offers', async () => {
    const parent = await setup();
    expect(await codexAdapter.openBackgroundSubagents!(parent)).toHaveLength(1);
    expect(await codexAdapter.subagentStillRunning!(parent, CHILD)).toBe(true);
  });
});

describe("confirming a child by its own rollout's tail", () => {
  it('is running while its last own turn has only started', async () => {
    expect(await codexSubagentStillRunning(await setup(), CHILD)).toBe(true);
  });

  it('has ended once that turn completed or was aborted', async () => {
    const child = await fixture('codex.child.0.162.1.jsonl');
    expect(await codexSubagentStillRunning(await setup({ child: upTo(child, isType('task_complete')) }), CHILD)).toBe(false);
    const aborted = { ...child.at(-1)!, ordinal: 99, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't', reason: 'interrupted' } };
    expect(await codexSubagentStillRunning(await setup({ child: [...child, aborted] }), CHILD)).toBe(false);
  });

  it("never takes the parent history it was forked with for its own", async () => {
    // Only the copied history's turn: the child has no boundary of its own yet.
    const child = await fixture('codex.child.0.162.1.jsonl');
    const copiedOnly = child.filter((row) => typeof row.ordinal !== 'number' || (row.ordinal as number) < 5);
    expect(await codexSubagentStillRunning(await setup({ child: copiedOnly }), CHILD)).toBeNull();
  });

  it("can't tell without a rollout of its own, or for an id that isn't a child's", async () => {
    expect(await codexSubagentStillRunning(await setup({ child: null }), CHILD)).toBeNull();
    const foreign = structuredClone(await fixture('codex.child.0.162.1.jsonl'));
    foreign[0]!.payload!.parent_thread_id = '01a12360-9999-7999-8999-999999999999';
    expect(await codexSubagentStillRunning(await setup({ child: foreign }), CHILD)).toBeNull();
    expect(await codexSubagentStillRunning(await setup(), '../../etc/passwd')).toBeNull();
  });
});
