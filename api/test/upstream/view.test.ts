import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/registry.js', () => ({ getSession: vi.fn() }));
const registry = await import('../../src/registry.js');
const { dialogueFile } = await import('../../src/dialogue-store.js');
const { readUpstream } = await import('../../src/upstream/view.js');

const turn = (index: number, text: string) => ({ index, user: { text, at: null }, assistant: { text: 'ok' } });

// A conversation whose turns are numbered from 12 (a branch line's, say).
const session = {
  id: 's1', tmuxName: 'hestia-main', projectId: 'p1',
  conversations: [{
    id: 'c1', provider: 'claude' as const, runtimeId: 'claude',
    transcript: { state: 'resolved', file: '/home/u/.claude/projects/p/abc.jsonl' },
    turns: [turn(12, '第一'), turn(13, '第二'), turn(14, '第三')],
  }],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('readUpstream', () => {
  it('up to the nth turn: its request and its Turn.index, with the count of turns now', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session as never);
    const view = await readUpstream('s1', 'c1', 2);
    expect(view).toMatchObject({ lastRequest: '第二', lastIndex: 13, turns: 3, transcriptFile: '/home/u/.claude/projects/p/abc.jsonl', transcriptFormat: 'jsonl' });
    // No archive written yet: not pointed at.
    expect(view.archiveFile).toBeNull();
  });

  it('null reads it all; more than there are stops at the last', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session as never);
    expect(await readUpstream('s1', 'c1', null)).toMatchObject({ lastRequest: '第三', lastIndex: 14, turns: 3 });
    expect(await readUpstream('s1', 'c1', 99)).toMatchObject({ lastRequest: '第三', lastIndex: 14 });
    expect(await readUpstream('s1', 'c1', 0)).toMatchObject({ lastRequest: null, lastIndex: null, turns: 3 });
  });

  it('points at the archive once there is one', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session as never);
    const archive = dialogueFile(session, session.conversations[0]!);
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, '');
    expect((await readUpstream('s1', 'c1', null)).archiveFile).toBe(archive);
  });

  it('nothing for a conversation that is not there', async () => {
    vi.mocked(registry.getSession).mockResolvedValue(session as never);
    expect(await readUpstream('s1', 'gone', null)).toEqual({
      archiveFile: null, transcriptFile: null, transcriptFormat: null, recapFile: null, lastRequest: null, turns: 0, lastIndex: null,
    });
    vi.mocked(registry.getSession).mockResolvedValue(undefined as never);
    expect((await readUpstream('gone', 'c1', null)).turns).toBe(0);
  });
});
