import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let geminiAdapter: typeof import('../../src/providers/gemini.js')['geminiAdapter'];
let geminiCliRuntime: typeof import('../../src/runtimes/gemini-cli.js')['geminiCliRuntime'];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'gemini-fixture-'));
  // PROVIDER_ROOTS.gemini is derived from HOME at config.ts's module-load
  // time — point it at a scratch dir per test so this never reads this
  // machine's real ~/.gemini/tmp.
  vi.resetModules();
  vi.stubEnv('HOME', dir);
  ({ geminiAdapter } = await import('../../src/providers/gemini.js'));
  ({ geminiCliRuntime } = await import('../../src/runtimes/gemini-cli.js'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function jsonlOf(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('geminiCliRuntime.buildLaunch', () => {
  it('has no session id to pin — gemini has no flag for it either', () => {
    const plan = geminiCliRuntime.buildLaunch('/some/cwd');
    expect(plan).toEqual({ argv: ['gemini'], providerSessionId: null });
  });
});

describe('geminiAdapter.parseTurns', () => {
  it('assembles a turn from an initial $set batch of messages', async () => {
    const file = path.join(dir, 'chat.json');
    await writeFile(
      file,
      jsonlOf([
        {
          $set: {
            messages: [
              { id: 'm1', type: 'user', content: 'hi gemini', timestamp: 't1' },
              { id: 'm2', type: 'gemini', content: 'hello there', timestamp: 't2' },
            ],
          },
        },
      ]),
      'utf-8',
    );

    const turns = await geminiAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('hi gemini');
    expect(turns[0].assistant.text).toBe('hello there');
  });

  it('replaces an earlier record with a later, longer re-emission of the same id', async () => {
    const file = path.join(dir, 'chat.json');
    await writeFile(
      file,
      jsonlOf([
        { id: 'm1', type: 'user', content: 'hi', timestamp: 't1' },
        { id: 'm2', type: 'gemini', content: 'partial', timestamp: 't2' },
        { id: 'm2', type: 'gemini', content: 'partial and now complete', timestamp: 't2' },
      ]),
      'utf-8',
    );

    const turns = await geminiAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistant.text).toBe('partial and now complete');
  });

  it('drops a trailing user message with no assistant reply yet', async () => {
    const file = path.join(dir, 'chat.json');
    await writeFile(
      file,
      jsonlOf([
        { id: 'm1', type: 'user', content: 'first', timestamp: 't1' },
        { id: 'm2', type: 'gemini', content: 'reply', timestamp: 't2' },
        { id: 'm3', type: 'user', content: 'second, still in flight', timestamp: 't3' },
      ]),
      'utf-8',
    );
    const turns = await geminiAdapter.parseTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.text).toBe('first');
  });
});

describe('geminiAdapter.findPendingInteraction', () => {
  it('reports unknown rather than claiming no pending interaction', async () => {
    expect(await geminiAdapter.findPendingInteraction('/any/path')).toEqual({ status: 'unknown' });
    expect(await geminiAdapter.isTurnComplete('/any/path')).toEqual({ status: 'unknown' });
  });
});

describe('geminiAdapter.locateSessionFile', () => {
  it('returns null when the gemini tmp root does not exist', async () => {
    const found = await geminiAdapter.locateSessionFile({
      cwd: '/x',
      providerSessionId: null,
      launchedAfter: new Date(0).toISOString(),
    });
    expect(found).toEqual({ status: 'not_found' });
  });

  it('does not infer tmux identity from a recent chat file under the selected profile root', async () => {
    const root = path.join(dir, 'profile-home', 'tmp');
    const chats = path.join(root, 'project', 'chats');
    const file = path.join(chats, 'chat.json');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(chats, { recursive: true });
    await writeFile(file, '{}\n', 'utf-8');
    await expect(geminiAdapter.locateSessionFile({
      cwd: '/ignored', providerSessionId: null, launchedAfter: new Date(0).toISOString(), conversationRoot: root,
    })).resolves.toEqual({ status: 'ambiguous' });
  });
});
