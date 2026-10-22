import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let codexAdapter: typeof import('../../src/providers/codex.js')['codexAdapter'];
let codexOpenTurnAtEnd: typeof import('../../src/providers/codex.js')['codexOpenTurnAtEnd'];
let codexCliRuntime: typeof import('../../src/runtimes/codex-cli.js')['codexCliRuntime'];
let codexSessionIdFromFdTargets: typeof import('../../src/runtimes/codex-cli.js')['codexSessionIdFromFdTargets'];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codex-fixture-'));
  // PROVIDER_ROOTS.codex is derived from CODEX_HOME/HOME at config.ts's
  // module-load time — point it at a scratch dir per test (same isolation
  // registry.test.ts uses for HESTIA_STATE_DIR) so this never reads
  // this machine's real ~/.codex/sessions.
  vi.resetModules();
  vi.stubEnv('CODEX_HOME', dir);
  ({ codexAdapter, codexOpenTurnAtEnd } = await import('../../src/providers/codex.js'));
  ({ codexSessionIdFromFdTargets, codexCliRuntime } = await import('../../src/runtimes/codex-cli.js'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function jsonlOf(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('codexCliRuntime.buildLaunch', () => {
  it('has no session id to pin and never attaches to a shared app-server daemon', () => {
    const plan = codexCliRuntime.buildLaunch('/some/cwd');
    expect(plan).toEqual({ argv: ['codex', '--no-daemon'], providerSessionId: null });
  });
});

describe('codexAdapter.parseTurns', () => {
  it('assembles a turn from response_item message records, skipping non-message payloads', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'session_meta' }, // ignored: not a response_item
        {
          type: 'response_item',
          timestamp: 't1',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi codex' }] },
        },
        {
          type: 'response_item',
          payload: { type: 'function_call', role: 'assistant', content: 'ignored, not a message' },
        },
        {
          type: 'response_item',
          timestamp: 't2',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello there' }] },
        },
      ]),
      'utf-8',
    );

    const turns = await codexAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('hi codex');
    expect(turns[0].assistant.text).toBe('hello there');
  });

  it('drops a trailing user message with no assistant reply yet', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(
      file,
      jsonlOf([
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'first' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'reply' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'still in flight' } },
      ]),
      'utf-8',
    );
    const turns = await codexAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('first');
  });
});

describe('codexAdapter.findPendingInteraction', () => {
  it('reports unknown rather than claiming no pending interaction', async () => {
    expect(await codexAdapter.findPendingInteraction('/any/path')).toEqual({ status: 'unknown' });
    expect(await codexAdapter.isTurnComplete('/any/path')).toEqual({ status: 'unknown' });
  });
});

describe('codexAdapter.isTurnComplete', () => {
  const FIXTURES = path.join(import.meta.dirname, '../fixtures/turn-boundaries');

  // Real rollouts (0.160.0), cut down to their record skeleton.
  it('keeps a turn open while Codex waits on a sub-agent, despite commentary and quiet spells', async () => {
    const file = path.join(FIXTURES, 'codex.delegating-mid-turn.0.160.0.jsonl');
    expect(await codexAdapter.parseMessages(file)).not.toHaveLength(0);
    expect(await codexAdapter.isTurnComplete(file)).toEqual({ status: 'supported', value: false });
  });

  it('closes a turn on task_complete, and one stopped with Esc on turn_aborted', async () => {
    const lines = (await readFile(path.join(FIXTURES, 'codex.interrupted-then-complete.0.160.0.jsonl'), 'utf8')).trim().split('\n');
    const boundary = (type: string) => lines.findIndex((line) => line.includes(`"type": "${type}"`));
    const upTo = async (index: number, name: string) => {
      const file = path.join(dir, name);
      await writeFile(file, lines.slice(0, index + 1).join('\n') + '\n');
      return codexAdapter.isTurnComplete(file);
    };

    expect(await upTo(boundary('task_started'), 'started.jsonl')).toEqual({ status: 'supported', value: false });
    expect(await upTo(boundary('turn_aborted'), 'aborted.jsonl')).toEqual({ status: 'supported', value: true });
    expect(await upTo(lines.length - 1, 'complete.jsonl')).toEqual({ status: 'supported', value: true });
  });

  // Real rollout (0.161.0, session #31), cut down: the turn starts the
  // moment the message is taken in, the message itself is written after an
  // automatic compaction ~100 s later.
  it('reads turn starts that come well before the message they were started by', async () => {
    const file = path.join(FIXTURES, 'codex.compaction-before-user-message.0.161.0.jsonl');
    expect(await codexAdapter.parseTurnStarts!(file)).toEqual(['2026-10-08T23:16:35.316Z']);
    const users = (await codexAdapter.parseMessages(file)).filter((message) => message.role === 'user');
    expect(users).toEqual([{ role: 'user', text: '完成了嗎？', ts: '2026-10-08T23:18:17.044Z' }]);
  });

  it('leaves it to file quiescence when the rollout has no turn events', async () => {
    const file = path.join(dir, 'old.jsonl');
    await writeFile(file, jsonlOf([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } },
    ]));
    expect(await codexAdapter.isTurnComplete(file)).toEqual({ status: 'unknown' });
  });

  // Real rollout (0.160.0, a /compact typed between two turns), cut down:
  // the compaction runs as a task of its own with a `compacted` item and no
  // message at all; the earlier history rides inside the item, not as
  // messages. Nothing the app reads as the user's.
  it('takes a /compact for no message and no turn', async () => {
    const lines = (await readFile(path.join(FIXTURES, 'codex.manual-compact.0.160.0.jsonl'), 'utf8')).trim().split('\n');
    const before = path.join(dir, 'before.jsonl');
    await writeFile(before, lines.slice(0, lines.findIndex((line) => line.includes('"turn-2"'))).join('\n') + '\n');
    const file = path.join(FIXTURES, 'codex.manual-compact.0.160.0.jsonl');

    expect(await codexAdapter.parseMessages(file)).toEqual(await codexAdapter.parseMessages(before));
    expect(await codexAdapter.parseTurns(file)).toEqual(await codexAdapter.parseTurns(before));
    expect((await codexAdapter.parseTurns(file)).map((turn) => turn.user.text)).toEqual(['Remember the code word for later.']);
    expect(await codexAdapter.isTurnComplete(file)).toEqual({ status: 'supported', value: true });
    expect(await codexAdapter.openTurnAtEnd!(file)).toBeNull();
  });
});

describe('codexAdapter.openTurnAtEnd', () => {
  const FIXTURES = path.join(import.meta.dirname, '../fixtures/turn-boundaries');

  // Same real rollout (0.161.0): a person's turn whose message is written
  // ~100 s after its task_started reads as Codex's own until then.
  it("is a person's once the turn's message is there, Codex's own before", async () => {
    const lines = (await readFile(path.join(FIXTURES, 'codex.compaction-before-user-message.0.161.0.jsonl'), 'utf8')).trim().split('\n');
    const records = lines.map((line) => JSON.parse(line) as unknown);
    const started = lines.findIndex((line) => line.includes('"task_started"'));
    expect(codexOpenTurnAtEnd(records.slice(0, started + 1))).toEqual({ openedBy: 'cli', at: null });
    expect(codexOpenTurnAtEnd(records)).toEqual({ openedBy: 'user', at: '2026-10-08T23:18:17.044Z' });
  });

  it('is nothing once the turn closed, or with no turn events at all', async () => {
    const lines = (await readFile(path.join(FIXTURES, 'codex.interrupted-then-complete.0.160.0.jsonl'), 'utf8')).trim().split('\n');
    expect(codexOpenTurnAtEnd(lines.map((line) => JSON.parse(line) as unknown))).toBeNull();
    expect(codexOpenTurnAtEnd([])).toBeNull();
  });
});

describe('codexAdapter.locateSessionFile', () => {
  it('returns null when the codex sessions root does not exist', async () => {
    const found = await codexAdapter.locateSessionFile({
      cwd: '/x',
      providerSessionId: null,
      launchedAfter: new Date(0).toISOString(),
    });
    expect(found).toEqual({ status: 'pending' });
  });

  it('does not treat unique cwd metadata as proof of tmux ownership', async () => {
    const profileRoot = path.join(dir, 'janus-profile', 'sessions');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(profileRoot, { recursive: true });
    const matching = path.join(profileRoot, 'rollout-match.jsonl');
    const other = path.join(profileRoot, 'rollout-other.jsonl');
    await writeFile(matching, jsonlOf([{ type: 'session_meta', payload: { cwd: '/expected' } }]), 'utf-8');
    await writeFile(other, jsonlOf([{ type: 'session_meta', payload: { cwd: '/elsewhere' } }]), 'utf-8');
    const launchedAfter = new Date(Date.now() - 1_000).toISOString();

    await expect(codexAdapter.locateSessionFile({
      cwd: '/expected', providerSessionId: null, launchedAfter, conversationRoot: profileRoot,
    })).resolves.toEqual({ status: 'pending' });
  });

  it('refuses to guess when multiple same-cwd rollouts could belong to concurrent sessions', async () => {
    const profileRoot = path.join(dir, 'janus-profile', 'sessions');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, 'rollout-a.jsonl'), jsonlOf([{ type: 'session_meta', payload: { cwd: '/same' } }]), 'utf-8');
    await writeFile(path.join(profileRoot, 'rollout-b.jsonl'), jsonlOf([{ type: 'session_meta', payload: { cwd: '/same' } }]), 'utf-8');
    await expect(codexAdapter.locateSessionFile({
      cwd: '/same', providerSessionId: null, launchedAfter: new Date(Date.now() - 1_000).toISOString(), conversationRoot: profileRoot,
    })).resolves.toEqual({ status: 'pending' });
  });

  it('distinguishes two same-cwd rollouts using observed IDs and session_meta', async () => {
    const profileRoot = path.join(dir, 'sessions');
    const dayRoot = path.join(profileRoot, '2026', '09', '24');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dayRoot, { recursive: true });
    const ids = ['01a0d20c-eeeb-79c1-bf0a-89dcdb154013', '01a0d210-6cbe-7073-a439-d4eaa1787744'];
    const files = ids.map((id) => path.join(dayRoot, `rollout-2026-09-24-${id}.jsonl`));
    for (let index = 0; index < ids.length; index++) {
      await writeFile(files[index], jsonlOf([{ type: 'session_meta', payload: { id: ids[index], session_id: ids[index], cwd: '/same' } }]));
    }
    for (let index = 0; index < ids.length; index++) {
      await expect(codexAdapter.locateSessionFile({
        cwd: '/same', providerSessionId: ids[index], launchedAfter: new Date().toISOString(), conversationRoot: profileRoot,
      })).resolves.toEqual({ status: 'resolved', file: files[index], identity: 'verified_metadata' });
    }
  });

  it('rejects filename, metadata, cwd, and duplicate-file conflicts', async () => {
    const root = path.join(dir, 'sessions');
    const dayRoot = path.join(root, '2026', '09', '24');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dayRoot, { recursive: true });
    const id = '01a0d20c-eeeb-79c1-bf0a-89dcdb154013';
    const other = '01a0d210-6cbe-7073-a439-d4eaa1787744';
    const file = path.join(dayRoot, `rollout-${id}.jsonl`);
    const opts = { cwd: '/same', providerSessionId: id, launchedAfter: new Date(0).toISOString(), conversationRoot: root };
    await writeFile(file, jsonlOf([{ type: 'session_meta', payload: { id: other, cwd: '/same' } }]));
    await expect(codexAdapter.locateSessionFile(opts)).resolves.toEqual({ status: 'not_found' });
    await writeFile(file, jsonlOf([{ type: 'session_meta', payload: { id, session_id: other, cwd: '/same' } }]));
    await expect(codexAdapter.locateSessionFile(opts)).resolves.toEqual({ status: 'not_found' });
    await writeFile(file, jsonlOf([{ type: 'session_meta', payload: { id, cwd: '/other' } }]));
    await expect(codexAdapter.locateSessionFile(opts)).resolves.toEqual({ status: 'not_found' });
    await writeFile(file, jsonlOf([{ type: 'session_meta', payload: { id, cwd: '/same' } }]));
    await writeFile(path.join(dayRoot, `rollout-copy-${id}.jsonl`), jsonlOf([{ type: 'session_meta', payload: { id, cwd: '/same' } }]));
    await expect(codexAdapter.locateSessionFile(opts)).resolves.toEqual({ status: 'ambiguous' });
  });
});

describe('Codex 0.156.1 identity evidence', () => {
  const id = '01a0d20c-eeeb-79c1-bf0a-89dcdb154013';
  const other = '01a0d210-6cbe-7073-a439-d4eaa1787744';

  it('accepts one process-owned lock and rejects two locks after in-CLI /clear', () => {
    const home = '/tmp/test-codex-home';
    const lock = (value: string) => path.join(home, 'thread-writer-locks', `${value}.lock`);
    expect(codexSessionIdFromFdTargets([lock(id)], home)).toBe(id);
    expect(codexSessionIdFromFdTargets([lock(id), lock(other)], home)).toBeNull();
    expect(codexSessionIdFromFdTargets([lock(id), lock(id)], home)).toBeNull();
    expect(codexSessionIdFromFdTargets([path.join('/other', 'thread-writer-locks', `${id}.lock`)], home)).toBeNull();
  });
});
