import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyClaudeScreen, parseClaudeUsagePanel, probeClaude, type TerminalDriver,
} from '../../src/account-status/claude.js';
import type { AccountRef } from '../../src/account-status/types.js';
import { readClaudeStartupPrompt } from '../../src/runtimes/claude-code.js';

// Fixtures are real `/usage` captures from Claude Code 2.1.281 on this host.
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const NOW = new Date('2026-09-24T06:20:00Z');
// The probe dir's trust prompt, cursor on "No, exit" (Claude Code 2.1.281).
const trustFixture = () => readFile(path.join(import.meta.dirname, '..', 'fixtures', 'startup-prompts', 'claude.decline.2.1.281-usage-probe.txt'), 'utf8');
const onYes = (screen: string) => screen.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');

describe('parseClaudeUsagePanel', () => {
  it('reads the 5h and weekly windows with reset times', async () => {
    const windows = parseClaudeUsagePanel(await fixture('claude-usage-work.txt'), NOW);
    expect(windows).toEqual([
      { id: 'five_hour', label: '5 小時', usedPercent: 3, remainingPercent: 97, windowMinutes: 300, resetsAt: '2026-09-24T11:10:00.000Z', resetsText: 'Resets 7:10pm (Asia/Taipei)' },
      { id: 'seven_day', label: '7 天', usedPercent: 83, remainingPercent: 17, windowMinutes: 10080, resetsAt: '2026-09-24T16:00:00.000Z', resetsText: 'Resets Sep 25, 12am (Asia/Taipei)' },
    ]);
  });

  it('keeps an idle session window that has no reset line', async () => {
    const windows = parseClaudeUsagePanel(await fixture('claude-usage-home.txt'), NOW);
    expect(windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 0, resetsAt: null, resetsText: null });
    expect(windows[1]).toMatchObject({ id: 'seven_day', usedPercent: 42, resetsAt: '2026-09-25T21:59:00.000Z' });
  });

  it('gives model-specific weekly windows their own id and accepts "% left"', () => {
    const windows = parseClaudeUsagePanel([
      'Current week (Sonnet only)', '████ 25% left', 'Resets Sep 30, 9am (UTC)',
    ].join('\n'), NOW);
    expect(windows).toEqual([expect.objectContaining({ id: 'seven_day_sonnet', usedPercent: 75, resetsAt: '2026-09-30T09:00:00.000Z' })]);
  });
});

describe('classifyClaudeScreen', () => {
  it('recognises login and usage screens (the trust prompt is read by the runtime)', async () => {
    expect(classifyClaudeScreen(await fixture('claude-login.txt'), NOW).kind).toBe('login_required');
    expect(classifyClaudeScreen(await trustFixture(), NOW).kind).toBe('other');
    expect(classifyClaudeScreen(await fixture('claude-usage-work.txt'), NOW).kind).toBe('usage');
    expect(classifyClaudeScreen('╭──╮\n│ > │\n╰──╯', NOW).kind).toBe('other');
  });
});

// Scripted terminal: each capture() returns the screen for the current step;
// keystrokes advance the script the way the real CLI would. The trust menu
// (No, exit above Yes) moves its cursor on Up/Down and doesn't wrap.
function scriptedDriver(screens: { idle: string; trust?: string; login?: string; usage: string; frozenTrust?: boolean; trustStartsOnYes?: boolean }) {
  const log: string[] = [];
  let stage: 'trust' | 'idle' | 'typed' | 'usage' | 'login' = screens.login ? 'login' : screens.trust ? 'trust' : 'idle';
  let onTrust = !!screens.trustStartsOnYes;
  const driver: TerminalDriver = {
    async start(argv, env, cwd) { log.push(`start ${argv.join(' ')} ${JSON.stringify(env)} ${path.basename(cwd)}`); },
    async capture() {
      if (stage === 'login') return screens.login!;
      if (stage === 'trust') return onTrust ? onYes(screens.trust!) : screens.trust!;
      if (stage === 'usage') return screens.usage;
      return screens.idle;
    },
    async sendText(text) { log.push(`text ${text}`); if (stage === 'idle') stage = 'typed'; },
    async sendKey(key) {
      log.push(`key ${key}`);
      if (stage === 'trust' && key === 'Down' && !screens.frozenTrust) onTrust = true;
      else if (stage === 'trust' && key === 'Up' && !screens.frozenTrust) onTrust = false;
      else if (stage === 'trust' && key === 'Enter') stage = onTrust ? 'idle' : 'login'; // "No, exit" would quit
      else if (stage === 'typed' && key === 'Enter') stage = 'usage';
    },
    async stop() { log.push('stop'); },
  };
  return { driver, log };
}

const account: AccountRef = {
  id: 'janus:claude:claude-work', provider: 'claude', name: 'claude-work', source: 'janus',
  home: '/nonexistent/claude-work', launch: ['/usr/bin/janus', 'run', 'claude-work'], env: {}, unsetEnv: [],
};
const idle = '╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts';

describe('probeClaude', () => {
  const opts = async (driver: TerminalDriver) => ({
    driver, now: () => NOW, sleep: async () => undefined, cwd: await mkdtemp(path.join(os.tmpdir(), 'probe-')),
    readStartupPrompt: readClaudeStartupPrompt,
  });

  it('accepts the probe-dir trust dialog, runs /usage and returns the windows', async () => {
    const { driver, log } = scriptedDriver({ trust: await trustFixture(), idle, usage: await fixture('claude-usage-work.txt') });
    const status = await probeClaude(account, await opts(driver));
    expect(status).toMatchObject({ state: 'ok', method: 'claude-cli-usage', error: null });
    expect(status.windows.map((w) => [w.id, w.usedPercent])).toEqual([['five_hour', 3], ['seven_day', 83]]);
    expect(log).toEqual([
      expect.stringMatching(/^start \/usr\/bin\/janus run claude-work --safe-mode \{\} probe-/),
      'key Down', 'key Enter', 'text /usage', 'key Enter', 'stop',
    ]);
  });

  it('confirms at once when the cursor already rests on Yes', async () => {
    const { driver, log } = scriptedDriver({ trust: await trustFixture(), trustStartsOnYes: true, idle, usage: await fixture('claude-usage-work.txt') });
    expect((await probeClaude(account, await opts(driver))).state).toBe('ok');
    expect(log.filter((l) => l.startsWith('key')).slice(0, 1)).toEqual(['key Enter']);
    expect(log).not.toContain('key Down');
  });

  it('gives up without confirming anything when the trust menu does not respond', async () => {
    const { driver, log } = scriptedDriver({ trust: await trustFixture(), idle, usage: '', frozenTrust: true });
    const status = await probeClaude(account, await opts(driver));
    expect(status).toMatchObject({ state: 'error', error: 'CLI 的資料夾信任確認無法自動回應' });
    expect(log).not.toContain('key Enter');
    expect(log.at(-1)).toBe('stop');
  });

  it('strips inherited provider env for native accounts so they probe the default home', async () => {
    const { driver, log } = scriptedDriver({ idle, usage: await fixture('claude-usage-work.txt') });
    await probeClaude({ ...account, id: 'native:claude:default', source: 'native', launch: ['claude'], unsetEnv: ['CLAUDE_CONFIG_DIR'] }, await opts(driver));
    expect(log[0]).toMatch(/^start env -u CLAUDE_CONFIG_DIR claude --safe-mode \{\} /);
  });

  it('passes the account environment (PATH included) through env(1), not tmux -e', async () => {
    const { driver, log } = scriptedDriver({ idle, usage: await fixture('claude-usage-work.txt') });
    await probeClaude({ ...account, env: { PATH: '/usr/bin:/home/u/.local/bin' } }, await opts(driver));
    expect(log[0]).toMatch(/^start env PATH=\/usr\/bin:\/home\/u\/\.local\/bin \/usr\/bin\/janus run claude-work --safe-mode \{\} /);
  });

  it('reports a logged-out account without typing anything', async () => {
    const { driver, log } = scriptedDriver({ login: await fixture('claude-login.txt'), idle, usage: '' });
    const status = await probeClaude(account, await opts(driver));
    expect(status.state).toBe('unauthenticated');
    expect(log.filter((l) => l.startsWith('text') || l.startsWith('key'))).toEqual([]);
    expect(log.at(-1)).toBe('stop');
  });

  it('times out (and still cleans up) when the panel never shows', async () => {
    const { driver, log } = scriptedDriver({ idle, usage: idle });
    const status = await probeClaude(account, { ...(await opts(driver)), timeoutMs: 20_000 });
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/timed out/);
    expect(log.filter((l) => l === 'text /usage')).toHaveLength(2); // one retry
    expect(log.at(-1)).toBe('stop');
  });

  it('surfaces a CLI that fails to start', async () => {
    const driver: TerminalDriver = {
      start: async () => { throw new Error('spawn claude ENOENT'); },
      capture: async () => '', sendText: async () => undefined, sendKey: async () => undefined, stop: async () => undefined,
    };
    const status = await probeClaude(account, await opts(driver));
    expect(status.state).toBe('not_installed');
  });
});
