import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as projectStore from '../../src/project-store.js';
import { turnGitChanges } from '../../src/process/git.js';
import type { ConversationSegment, ManagedSession, Turn } from '../../src/types.js';

let repo: string;

function commit(file: string, message: string, at: string): void {
  execFileSync('git', ['add', file], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message], {
    cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
}

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hestia-turn-git-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await writeFile(path.join(repo, 'a.txt'), '1');
  commit('a.txt', 'before the turn', '2026-10-12T00:59:00Z');
  await writeFile(path.join(repo, 'b.txt'), '1');
  commit('b.txt', 'in turn 1', '2026-10-12T01:05:00Z');
  await writeFile(path.join(repo, 'a.txt'), '2');
  commit('a.txt', 'in turn 2', '2026-10-12T02:05:00Z');
  await writeFile(path.join(repo, 'c.txt'), 'not committed');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const turn = (index: number, at: string): Turn => ({ index, user: { text: `q${index}`, at }, assistant: { text: 'a', at } });

function fixture(projectId = 'no-such-project') {
  const conversation = {
    id: 'c', provider: 'claude', providerSessionId: null, startedAt: '2026-10-12T00:00:00Z', launchProfile: null,
    transcript: { state: 'legacy_unverified', file: null, identity: null },
    turns: [turn(1, '2026-10-12T01:00:00.000Z'), turn(2, '2026-10-12T02:00:00.000Z')],
  } as unknown as ConversationSegment;
  const session = { id: 's', cwd: repo, projectId, conversations: [conversation] } as unknown as ManagedSession;
  return { session, conversation };
}

describe('turnGitChanges', () => {
  it('lists the commits made between a turn and the next one, with their files', async () => {
    const { session, conversation } = fixture();
    const changes = await turnGitChanges(session, conversation, 1);
    expect(changes).toMatchObject({ since: '2026-10-12T01:00:00.000Z', until: '2026-10-12T02:00:00.000Z' });
    expect(changes!.repos).toHaveLength(1);
    expect(changes!.repos[0]).toMatchObject({ root: repo, projectRoot: null, truncated: false, uncommitted: null });
    expect(changes!.repos[0]!.commits.map((c) => [c.subject, c.files])).toEqual([['in turn 1', [{ path: 'b.txt', status: 'A' }]]]);
  });

  it('runs the latest turn up to now (no transcript to say when it ended), and counts what is not committed yet', async () => {
    const { session, conversation } = fixture();
    const changes = await turnGitChanges(session, conversation, 2, new Date('2026-10-12T03:00:00Z'));
    expect(changes!.until).toBe('2026-10-12T03:00:00.000Z');
    expect(changes!.repos[0]!.commits.map((c) => c.subject)).toEqual(['in turn 2']);
    expect(changes!.repos[0]!.uncommitted).toBe(1);
  });

  it('ends the latest turn where its transcript ends, and reads its folder from there', async () => {
    await writeFile(path.join(repo, 'd.txt'), '1');
    commit('d.txt', 'long after turn 2', '2026-10-12T02:30:00Z');
    const file = path.join(repo, '..', `${path.basename(repo)}.jsonl`);
    const rec = (type: string, at: string, content: unknown) => ({ type, timestamp: at, cwd: repo, origin: type === 'user' ? { kind: 'human' } : undefined, message: { role: type, content } });
    await writeFile(file, [
      rec('user', '2026-10-12T01:00:00.000Z', 'q1'), rec('assistant', '2026-10-12T01:01:00.000Z', [{ type: 'text', text: 'a' }]),
      rec('user', '2026-10-12T02:00:00.000Z', 'q2'), rec('assistant', '2026-10-12T02:06:00.000Z', [{ type: 'text', text: 'a' }]),
    ].map((r) => `${JSON.stringify(r)}\n`).join(''));
    try {
      const { session, conversation } = fixture();
      const bound = { ...conversation, transcript: { state: 'resolved', file, identity: 'pinned_id' } } as ConversationSegment;
      const changes = await turnGitChanges({ ...session, cwd: '/nonexistent' } as ManagedSession, bound, 2, new Date('2026-10-12T05:00:00Z'));
      expect(changes!.until).toBe('2026-10-12T02:07:00.000Z');
      expect(changes!.repos.map((r) => r.root)).toEqual([repo]);
      expect(changes!.repos[0]!.commits.map((c) => c.subject)).toEqual(['in turn 2']);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('names the project path the Git area can open the repo by', async () => {
    const project = await projectStore.createProject('git turn');
    await projectStore.addProjectPath(project.id, repo);
    const { session, conversation } = fixture(project.id);
    expect((await turnGitChanges(session, conversation, 1))!.repos[0]!.projectRoot).toBe(repo);
  });

  it('has nothing for a turn the conversation does not have', async () => {
    const { session, conversation } = fixture();
    expect(await turnGitChanges(session, conversation, 9)).toBeNull();
  });
});
