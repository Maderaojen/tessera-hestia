import { describe, expect, it } from 'vitest';
import { delegateCommand, parseDoneArgs, parseReviewArgs, parseStartArgs, type DelegateDeps } from '../../src/cli/delegate.js';

class Failed extends Error {}

function deps(patch: Partial<DelegateDeps> & { routes?: Record<string, unknown> } = {}) {
  const calls: { route: string; init?: { method?: string; body?: unknown } }[] = [];
  const logs: string[] = [];
  const routes: Record<string, unknown> = {
    '/sessions': [{ id: 'child-1', tmuxName: 'hestia-child-1' }, { id: 'p1', tmuxName: 'hestia-p1' }],
    '/delegations/ab12cd34/deliver': { delegation: { id: 'ab12cd34', workspace: { branch: 'delegate/ab12cd34' } } },
    ...patch.routes,
  };
  const value: DelegateDeps = {
    api: async <T>(route: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ route, init });
      if (!(route in routes)) throw new Failed(`no route ${route}`);
      return routes[route] as T;
    },
    fail: (message: string) => { throw new Failed(message); },
    env: { HESTIA_DELEGATION_ID: 'ab12cd34' },
    tmuxName: () => 'hestia-child-1',
    readFile: async (file) => (file === 'report.md' ? '## Done\n- added --json' : Promise.reject(new Error('ENOENT'))),
    log: (line) => logs.push(line),
    ...patch,
  };
  return { value, calls, logs };
}

describe('hestia delegate', () => {
  it('parses done\'s options', () => {
    expect(parseDoneArgs(['--report', 'ok'])).toEqual({ report: { text: 'ok' }, blocked: false });
    expect(parseDoneArgs(['--report-file', 'r.md', '--blocked'])).toEqual({ report: { file: 'r.md' }, blocked: true });
    expect(parseDoneArgs([])).toMatch(/exactly one/);
    expect(parseDoneArgs(['--report', 'a', '--report-file', 'b'])).toMatch(/exactly one/);
    expect(parseDoneArgs(['--report'])).toMatch(/needs/);
    expect(parseDoneArgs(['--force'])).toMatch(/unknown option/);
  });

  it('delivers the report file for the delegation named in the tmux', async () => {
    const { value, calls, logs } = deps();
    await delegateCommand(['done', '--report-file', 'report.md'], value);
    expect(calls.at(-1)).toEqual({
      route: '/delegations/ab12cd34/deliver',
      init: { method: 'POST', body: { fromSessionId: 'child-1', report: '## Done\n- added --json', blocked: false } },
    });
    expect(logs[0]).toContain('已交付指派 ab12cd34');
  });

  it('finds the delegation by its own tmux without the variable', async () => {
    const { value, calls } = deps({
      env: {},
      routes: { '/delegations?session=child-1': { delegations: [
        { id: 'old', childSessionId: 'child-1', state: 'accepted' },
        { id: 'ab12cd34', childSessionId: 'child-1', state: 'working' },
      ] } },
    });
    await delegateCommand(['done', '--report', 'blocked on X', '--blocked'], value);
    expect(calls.at(-1)?.route).toBe('/delegations/ab12cd34/deliver');
    expect(calls.at(-1)?.init?.body).toMatchObject({ blocked: true, report: 'blocked on X' });
  });

  it('refuses outside a tmux the app manages', async () => {
    const { value } = deps({ tmuxName: () => null });
    await expect(delegateCommand(['done', '--report', 'x'], value)).rejects.toThrow(/not in a tmux/);
    const { value: other } = deps({ tmuxName: () => 'my-own-tmux' });
    await expect(delegateCommand(['done', '--report', 'x'], other)).rejects.toThrow(/not in a tmux/);
  });

  it('refuses an unreadable or empty report', async () => {
    await expect(delegateCommand(['done', '--report-file', 'missing.md'], deps().value)).rejects.toThrow(/can't read/);
    await expect(delegateCommand(['done', '--report', '  '], deps().value)).rejects.toThrow(/empty/);
  });

  it('shows one delegation, or this tmux\'s', async () => {
    const delegation = {
      id: 'ab12cd34', state: 'needs_attention', stateReason: 'idle', stateDetail: null, title: 'Status JSON', profileLabel: 'Codex CLI',
      briefFile: '/w/.hestia/delegations/ab12cd34/brief.md',
      workspace: { path: '/w', branch: 'delegate/ab12cd34', baseCommit: 'base0001abcdef' },
    };
    const { value, logs } = deps({ routes: { '/delegations/ab12cd34': { delegation }, '/delegations?session=child-1': { delegations: [delegation] } } });
    await delegateCommand(['status', 'ab12cd34'], value);
    expect(logs[0]).toContain('ab12cd34  needs_attention（idle）  Status JSON');
    expect(logs[0]).toContain('branch：delegate/ab12cd34（base base0001）');
    await delegateCommand(['status'], value);
    expect(logs[1]).toContain('Codex CLI');
  });

  it('prints the usage for anything else', async () => {
    await expect(delegateCommand(['start'], deps().value)).rejects.toThrow(/usage: hestia delegate/);
    await expect(delegateCommand(['review'], deps().value)).rejects.toThrow(/usage: hestia delegate/);
    await expect(delegateCommand(['stop'], deps().value)).rejects.toThrow(/usage: hestia delegate/);
  });
});

describe('hestia delegate start / stop / status (the delegating LLM)', () => {
  const asParent = (patch: Partial<DelegateDeps> & { routes?: Record<string, unknown> } = {}) => deps({ env: {}, tmuxName: () => 'hestia-p1', ...patch });

  it('parses start\'s options', () => {
    expect(parseStartArgs(['--task', 'do it'])).toEqual({ task: { text: 'do it' }, worktree: false });
    expect(parseStartArgs(['--task-file', 't.md', '--profile', 'native:codex', '--title', 'T', '--worktree']))
      .toEqual({ task: { file: 't.md' }, profileId: 'native:codex', title: 'T', worktree: true });
    expect(parseStartArgs([])).toMatch(/exactly one/);
    expect(parseStartArgs(['--task', 'a', '--task-file', 'b'])).toMatch(/exactly one/);
    expect(parseStartArgs(['--profile'])).toMatch(/needs a value/);
    expect(parseStartArgs(['--shared'])).toMatch(/unknown option/);
  });

  it('starts one from its own tmux, and prints the id and state', async () => {
    const { value, calls, logs } = asParent({
      readFile: async () => 'Add a --json flag',
      routes: { '/delegations': { delegation: { id: 'ef56ab78', state: 'proposed', profileLabel: 'Codex CLI' } } },
    });
    await delegateCommand(['start', '--task-file', 'task.md', '--profile', 'native:codex', '--worktree'], value);
    expect(calls.at(-1)).toEqual({
      route: '/delegations',
      init: { method: 'POST', body: { parentSessionId: 'p1', task: 'Add a --json flag', profileId: 'native:codex', isolation: 'worktree' } },
    });
    expect(logs[0]).toBe('ef56ab78 proposed');
    expect(logs[1]).toContain('等使用者在 App 核准');
  });

  it('refuses to start outside a tmux the app manages, or with an empty task', async () => {
    await expect(delegateCommand(['start', '--task', 'x'], asParent({ tmuxName: () => null }).value)).rejects.toThrow(/not in a tmux/);
    await expect(delegateCommand(['start', '--task', ' '], asParent().value)).rejects.toThrow(/empty/);
  });

  it('stops one from its own tmux', async () => {
    const { value, calls, logs } = asParent({ routes: { '/delegations/ab12cd34/stop': { delegation: { id: 'ab12cd34', state: 'stopped' } } } });
    await delegateCommand(['stop', 'ab12cd34'], value);
    expect(calls.at(-1)).toEqual({ route: '/delegations/ab12cd34/stop', init: { method: 'POST', body: { fromSessionId: 'p1' } } });
    expect(logs[0]).toContain('已停止指派 ab12cd34');
  });

  it('lists its own delegation first, then the ones it started, saying which is which', async () => {
    const base = { stateReason: null, stateDetail: null, profileLabel: 'Codex CLI', depth: 1, initiator: 'llm', briefFile: '/w/b.md', workspace: { path: '/w', branch: null } };
    const { value, logs } = deps({
      env: {},
      routes: { '/delegations?session=child-1': { delegations: [
        { ...base, id: 'started1', state: 'working', title: 'Sub task', parentSessionId: 'child-1', childSessionId: 'child-9' },
        { ...base, id: 'mine', state: 'working', title: 'My task', parentSessionId: 'p1', childSessionId: 'child-1', initiator: 'user' },
      ] } },
    });
    await delegateCommand(['status'], value);
    const [own, started] = logs[0]!.split('\n\n');
    expect(own).toContain('mine  working  My task  [你是被指派者]');
    expect(own).toContain('使用者發起');
    expect(started).toContain('started1  working  Sub task  [你發起的]');
    expect(started).toContain('深度 1，LLM 發起');
  });
});

describe('hestia delegate review (the delegating LLM)', () => {
  const asParent = { tmuxName: () => 'hestia-p1' };

  it('parses review\'s arguments', () => {
    expect(parseReviewArgs(['ab12cd34', '--pass'])).toEqual({ id: 'ab12cd34', verdict: 'pass', feedback: null });
    expect(parseReviewArgs(['--send-back', 'ab12cd34', '--feedback-file', 'f.md'])).toEqual({ id: 'ab12cd34', verdict: 'send_back', feedback: { file: 'f.md' } });
    expect(parseReviewArgs(['ab12cd34', '--pass', '--feedback', 'LGTM'])).toEqual({ id: 'ab12cd34', verdict: 'pass', feedback: { text: 'LGTM' } });
    expect(parseReviewArgs(['--pass'])).toMatch(/id/);
    expect(parseReviewArgs(['ab12cd34'])).toMatch(/--pass or --send-back/);
    expect(parseReviewArgs(['ab12cd34', '--pass', '--send-back'])).toMatch(/exactly one/);
    expect(parseReviewArgs(['ab12cd34', '--send-back'])).toMatch(/needs --feedback/);
    expect(parseReviewArgs(['ab12cd34', '--send-back', '--feedback', 'a', '--feedback-file', 'b'])).toMatch(/at most one/);
    expect(parseReviewArgs(['ab12cd34', 'cd34ef56', '--pass'])).toMatch(/unexpected/);
    expect(parseReviewArgs(['ab12cd34', '--approve'])).toMatch(/unknown option/);
  });

  it('sends it back from its own tmux with the feedback file', async () => {
    const { value, calls, logs } = deps({
      ...asParent,
      readFile: async (file) => (file === 'feedback.md' ? 'Add a test.' : Promise.reject(new Error('ENOENT'))),
      routes: { '/delegations/ab12cd34/review': { delegation: { id: 'ab12cd34', state: 'working', round: 2, workspace: { branch: 'delegate/ab12cd34' } } } },
    });
    await delegateCommand(['review', 'ab12cd34', '--send-back', '--feedback-file', 'feedback.md'], value);
    expect(calls.at(-1)).toEqual({
      route: '/delegations/ab12cd34/review',
      init: { method: 'POST', body: { fromSessionId: 'p1', verdict: 'send_back', feedback: 'Add a test.' } },
    });
    expect(logs[0]).toContain('已退回指派 ab12cd34（第 2 輪）');
  });

  it('passes it on, saying it is the user\'s now', async () => {
    const { value, calls, logs } = deps({
      ...asParent,
      routes: { '/delegations/ab12cd34/review': { delegation: { id: 'ab12cd34', state: 'delivered', stateReason: 'passed', workspace: { branch: 'delegate/ab12cd34' } } } },
    });
    await delegateCommand(['review', 'ab12cd34', '--pass'], value);
    expect(calls.at(-1)?.init?.body).toEqual({ fromSessionId: 'p1', verdict: 'pass' });
    expect(logs[0]).toContain('交給使用者在 App 驗收');
  });

  it('says when its send-backs were used up', async () => {
    const { value, logs } = deps({
      ...asParent,
      routes: { '/delegations/ab12cd34/review': { delegation: { id: 'ab12cd34', state: 'delivered', stateReason: 'review_rounds', workspace: { branch: null } } } },
    });
    await delegateCommand(['review', 'ab12cd34', '--send-back', '--feedback', 'again'], value);
    expect(logs[0]).toContain('退回的次數已用完');
  });

  it('refuses outside a tmux the app manages, and empty feedback', async () => {
    await expect(delegateCommand(['review', 'ab12cd34', '--pass'], deps({ tmuxName: () => null }).value)).rejects.toThrow(/not in a tmux/);
    await expect(delegateCommand(['review', 'ab12cd34', '--send-back', '--feedback', '  '], deps(asParent).value)).rejects.toThrow(/empty/);
  });

  it('tells the delegate it went to review first when it delivers', async () => {
    const { value, logs } = deps({
      routes: { '/delegations/ab12cd34/deliver': { delegation: { id: 'ab12cd34', state: 'reviewing', workspace: { branch: 'delegate/ab12cd34' } } } },
    });
    await delegateCommand(['done', '--report', 'done'], value);
    expect(logs[0]).toContain('先給發起的 LLM 審');
  });
});
