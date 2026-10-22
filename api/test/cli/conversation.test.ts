import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversationCommand, parseShowArgs, selectTurns, type ConversationDeps } from '../../src/cli/conversation.js';

class Failed extends Error {}

const turn = (index: number) => ({
  index, user: { text: `question ${index}`, at: `2026-10-08T09:0${index}:00.000Z` }, assistant: { text: `answer ${index}`, at: null },
});

const MAIN = {
  id: 'main', tmuxName: 'hestia-main', cwd: '/work/hestia', activeConversationId: 'c2',
  conversations: [{ id: 'c1' }, { id: 'c2' }],
};

function deps(patch: Partial<ConversationDeps> & { routes?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const routes: Record<string, unknown> = {
    '/sessions': [{ id: 'branch', tmuxName: 'hestia-branch' }, { id: 'main', tmuxName: 'hestia-main' }],
    '/sessions/main': MAIN,
    '/sessions/main/conversations/c1': { id: 'c1', provider: 'claude', runtimeId: 'claude-code', launchProfile: null, turns: [turn(1), turn(2), turn(3), turn(4)] },
    '/sessions/main/conversations/c2': { id: 'c2', provider: 'codex', runtimeId: 'codex-cli', launchProfile: null, turns: [turn(1)] },
    '/forks/f1': { fork: { id: 'f1', childSessionId: 'branch', closedAt: null, origin: { sessionId: 'main', conversationId: 'c1', turnsAtFork: 3 } } },
    ...patch.routes,
  };
  const value: ConversationDeps = {
    api: async <T>(route: string) => {
      calls.push(route);
      if (!(route in routes)) throw new Failed(`no route ${route}`);
      return routes[route] as T;
    },
    fail: (message: string) => { throw new Failed(message); },
    env: { HESTIA_FORK_ID: 'f1' },
    tmuxName: () => 'hestia-branch',
    now: () => new Date('2026-10-08T10:00:00.000Z'),
    log: (text) => logs.push(text),
    ...patch,
  };
  return { value, calls, logs };
}

describe('hestia conversation show', () => {
  it('parses its options', () => {
    expect(parseShowArgs([])).toEqual({ source: { kind: 'own' }, range: { kind: 'all' } });
    expect(parseShowArgs(['--upstream', '--last', '2'])).toEqual({ source: { kind: 'upstream' }, range: { kind: 'last', count: 2 } });
    expect(parseShowArgs(['--session', 's', '--conversation', 'c', '--turns', '3..'])).toEqual({
      source: { kind: 'session', sessionId: 's', conversationId: 'c' }, range: { kind: 'turns', from: 3, to: null },
    });
    expect(parseShowArgs(['--turns', '..8'])).toMatchObject({ range: { kind: 'turns', from: null, to: 8 } });
    expect(parseShowArgs(['--upstream', '--session', 's'])).toMatch(/leave out/);
    expect(parseShowArgs(['--conversation', 'c'])).toMatch(/needs --session/);
    expect(parseShowArgs(['--last', '0'])).toMatch(/number/);
    expect(parseShowArgs(['--last', '2', '--turns', '1..2'])).toMatch(/at most one/);
    expect(parseShowArgs(['--turns', '..'])).toMatch(/range/);
    expect(parseShowArgs(['--write'])).toMatch(/unknown option/);
  });

  it('keeps the turns asked for', () => {
    const turns = [turn(1), turn(2), turn(3)];
    expect(selectTurns(turns, { kind: 'last', count: 2 }).map((t) => t.index)).toEqual([2, 3]);
    expect(selectTurns(turns, { kind: 'turns', from: 2, to: 2 }).map((t) => t.index)).toEqual([2]);
    expect(selectTurns(turns, { kind: 'all' })).toHaveLength(3);
  });

  it('prints a branch line\'s upstream up to the turn it was forked at, writing nothing', async () => {
    const { value, calls, logs } = deps();
    await conversationCommand(['show', '--upstream'], value);
    expect(calls).toEqual(['/forks/f1', '/sessions/main', '/sessions/main/conversations/c1']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('共 3 輪');
    expect(logs[0]).toContain('question 3');
    expect(logs[0]).not.toContain('question 4');
    expect(logs[0]).toContain('`/work/hestia`');
  });

  it('keeps the last N of the upstream', async () => {
    const { value, logs } = deps();
    await conversationCommand(['show', '--upstream', '--last', '1'], value);
    expect(logs[0]).toContain('question 3');
    expect(logs[0]).not.toContain('question 2');
  });

  it('finds the fork by its own tmux without the variable', async () => {
    const { value, calls } = deps({
      env: {},
      routes: { '/forks?session=branch': { forks: [{ id: 'f1', childSessionId: 'branch', closedAt: null, origin: { sessionId: 'main', conversationId: 'c1', turnsAtFork: 3 } }] } },
    });
    await conversationCommand(['show', '--upstream'], value);
    expect(calls.slice(0, 2)).toEqual(['/sessions', '/forks?session=branch']);
  });

  it('prints any session\'s active conversation, or the one named', async () => {
    const active = deps();
    await conversationCommand(['show', '--session', 'main'], active.value);
    expect(active.calls.at(-1)).toBe('/sessions/main/conversations/c2');
    const named = deps();
    await conversationCommand(['show', '--session', 'main', '--conversation', 'c1', '--turns', '2..3'], named.value);
    expect(named.logs[0]).toContain('question 2');
    expect(named.logs[0]).not.toContain('question 1');
  });

  it('says what is wrong instead of guessing', async () => {
    await expect(conversationCommand(['list'], deps().value)).rejects.toThrow(/usage/);
    await expect(conversationCommand(['show', '--upstream'], deps({ env: {}, tmuxName: () => null }).value)).rejects.toThrow('這個 tmux 不是支線也不是指派；用 --session');
    await expect(conversationCommand(['show', '--upstream'], deps({
      env: {}, routes: { '/forks?session=branch': { forks: [] }, '/delegations?session=branch': { delegations: [] } },
    }).value)).rejects.toThrow('這個 tmux 不是支線也不是指派；用 --session');
  });
});

describe('hestia conversation show --upstream in a delegate', () => {
  const delegation = (patch: Record<string, unknown> = {}) => ({
    id: 'd1', childSessionId: 'branch', parentSessionId: 'main', parentConversationId: 'c1', parentTurnsAtStart: 2, ...patch,
  });

  it('prints the delegating conversation up to the turns it had when delegated', async () => {
    const { value, calls, logs } = deps({ env: { HESTIA_DELEGATION_ID: 'd1' }, routes: { '/delegations/d1': { delegation: delegation() } } });
    await conversationCommand(['show', '--upstream'], value);
    expect(calls).toEqual(['/delegations/d1', '/sessions/main', '/sessions/main/conversations/c1']);
    expect(logs[0]).toContain('共 2 輪');
    expect(logs[0]).toContain('question 2');
    expect(logs[0]).not.toContain('question 3');
  });

  it('all of it for a delegation made before the count was kept', async () => {
    const { value, logs } = deps({ env: { HESTIA_DELEGATION_ID: 'd1' }, routes: { '/delegations/d1': { delegation: delegation({ parentTurnsAtStart: null }) } } });
    await conversationCommand(['show', '--upstream'], value);
    expect(logs[0]).toContain('共 4 輪');
    expect(logs[0]).toContain('question 4');
  });

  it('--turns picks by Turn.index, within what was there when delegated', async () => {
    const routes = {
      '/delegations/d1': { delegation: delegation({ parentTurnsAtStart: 3 }) },
      '/sessions/main/conversations/c1': { id: 'c1', provider: 'claude', runtimeId: 'claude-code', launchProfile: null, turns: [turn(5), turn(6), turn(7), turn(8)] },
    };
    const { value, logs } = deps({ env: { HESTIA_DELEGATION_ID: 'd1' }, routes });
    await conversationCommand(['show', '--upstream', '--turns', '6..'], value);
    expect(logs[0]).toContain('question 6');
    expect(logs[0]).toContain('question 7');
    expect(logs[0]).not.toContain('question 5');
    expect(logs[0]).not.toContain('question 8');
  });

  it('a branch line\'s fork comes first when both are set', async () => {
    const { value, calls, logs } = deps({ env: { HESTIA_FORK_ID: 'f1', HESTIA_DELEGATION_ID: 'd1' }, routes: { '/delegations/d1': { delegation: delegation() } } });
    await conversationCommand(['show', '--upstream'], value);
    expect(calls[0]).toBe('/forks/f1');
    expect(logs[0]).toContain('共 3 輪');
  });

  it('finds the delegation by its own tmux, after looking for a fork', async () => {
    const { value, calls, logs } = deps({
      env: {},
      routes: {
        '/forks?session=branch': { forks: [] },
        // The delegating session's own delegation is listed too: not this one.
        '/delegations?session=branch': { delegations: [delegation({ id: 'd0', childSessionId: 'other' }), delegation()] },
      },
    });
    await conversationCommand(['show', '--upstream'], value);
    expect(calls.slice(0, 3)).toEqual(['/sessions', '/forks?session=branch', '/delegations?session=branch']);
    expect(logs[0]).toContain('共 2 輪');
  });

  it('says so when the delegation has no delegating conversation', async () => {
    const { value } = deps({ env: { HESTIA_DELEGATION_ID: 'd1' }, routes: { '/delegations/d1': { delegation: delegation({ parentConversationId: null }) } } });
    await expect(conversationCommand(['show', '--upstream'], value)).rejects.toThrow(/沒有記下發起的對話/);
  });
});

describe('hestia conversation show (usage)', () => {

  it('is in hestia\'s usage', () => {
    const main = path.resolve(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', main], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HESTIA_STATE_DIR: process.env.HESTIA_STATE_DIR ?? '' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hestia conversation show [--upstream');
  });
});
