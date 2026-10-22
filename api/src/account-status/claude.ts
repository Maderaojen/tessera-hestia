import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv, scrubTmuxServerEnv } from '../child-env.js';
import { HOME, USAGE_PROBE_DIR } from '../config.js';
import { answerTrustMenu } from '../runtimes/startup-prompt-menu.js';
import type { StartupPromptReading } from '../runtimes/types.js';
import { parseResetText } from './reset-time.js';
import { baseStatus, usageWindow, type AccountRef, type AccountStatus, type UsageWindow } from './types.js';
import { t } from '../i18n/index.js';

// Anthropic has no documented API for subscription usage, so we ask the
// official CLI: start `claude` as the account in a throwaway tmux pane (own
// socket, never visible to the session registry), run `/usage`, and parse the
// rendered panel. `/usage` is a local command — it makes no model request.

const execFileAsync = promisify(execFile);
const PROBE_SOCKET = 'hestia-usage-probe';
// Pause between typing /usage and pressing Enter.
const TEXT_TO_ENTER_DELAY_MS = 300;
// How long /usage may go unanswered before it is dismissed and retyped once.
const USAGE_RESEND_AFTER_MS = 10_000;
// Leaves out the account's hooks, plugins, MCP servers and CLAUDE.md: without
// it every probe fires the user's SessionEnd hooks (a diary hook that commits
// and pushes ran ~650 times a day). /usage and the trust menu are unchanged
// (verified with Claude Code 2.1.293, docs/reference/cli-version-alignment.md).
const PROBE_FLAGS = ['--safe-mode'];
export const PROBE_DIR = USAGE_PROBE_DIR;

// ---------- panel parsing (pure) ----------

const HEADER_RE = /^Current (session|week(?:\s*\(([^)]+)\))?)\s*$/i;
const USED_RE = /(\d+(?:\.\d+)?)\s*%\s*used/i;
const LEFT_RE = /(\d+(?:\.\d+)?)\s*%\s*left/i;
const RESET_LINE_RE = /^Resets\b/i;

export type ClaudeScreen =
  | { kind: 'usage'; windows: UsageWindow[] }
  | { kind: 'login_required' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'other' };

function windowId(header: string, qualifier: string | undefined): { id: string; label: string; minutes: number | null } {
  if (/^session$/i.test(header)) return { id: 'five_hour', label: t('account.window.fiveHour'), minutes: 300 };
  if (!qualifier || /all models/i.test(qualifier)) return { id: 'seven_day', label: t('account.window.sevenDay'), minutes: 10080 };
  const slug = qualifier.toLowerCase().replace(/\bonly\b/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { id: `seven_day_${slug}`, label: t('account.window.sevenDayOf', { qualifier }), minutes: 10080 };
}

export function parseClaudeUsagePanel(screen: string, now: Date, defaultZone?: string): UsageWindow[] {
  const lines = screen.split('\n').map((line) => line.trim());
  const windows: UsageWindow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = HEADER_RE.exec(lines[i]);
    if (!header) continue;
    let used: number | null = null;
    let resetsText: string | null = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      if (HEADER_RE.test(lines[j])) break;
      const usedMatch = USED_RE.exec(lines[j]);
      const leftMatch = LEFT_RE.exec(lines[j]);
      if (used === null && usedMatch) used = Number(usedMatch[1]);
      else if (used === null && leftMatch) used = 100 - Number(leftMatch[1]);
      if (resetsText === null && RESET_LINE_RE.test(lines[j])) resetsText = lines[j];
    }
    if (used === null) continue;
    const { id, label, minutes } = windowId(header[1].startsWith('session') ? 'session' : 'week', header[2]);
    const resetsAt = resetsText ? parseResetText(resetsText, now, defaultZone) : null;
    windows.push(usageWindow(id, label, used, minutes, resetsAt, resetsText));
  }
  return windows;
}

export function classifyClaudeScreen(screen: string, now: Date, defaultZone?: string): ClaudeScreen {
  if (/Select login method|Please run \/login|Not logged in/i.test(screen)) return { kind: 'login_required' };
  const unsupported = /(\/usage is only available[^\n]*|only available for (?:subscription|Claude)[^\n]*)/i.exec(screen);
  if (unsupported) return { kind: 'unsupported', message: unsupported[1].trim() };
  const windows = parseClaudeUsagePanel(screen, now, defaultZone);
  if (windows.length > 0) return { kind: 'usage', windows };
  return { kind: 'other' };
}

// ---------- identity from the account's own config (no tokens read) ----------

export async function readClaudeIdentity(account: AccountRef): Promise<{ email: string | null; plan: string | null }> {
  const file = account.source === 'native' ? path.join(HOME, '.claude.json') : path.join(account.home, '.claude.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { oauthAccount?: Record<string, unknown> };
    const oauth = parsed.oauthAccount;
    if (!oauth) return { email: null, plan: null };
    const org = typeof oauth.organizationType === 'string' ? oauth.organizationType.replace(/^claude_/, '') : null;
    return { email: typeof oauth.emailAddress === 'string' ? oauth.emailAddress : null, plan: org };
  } catch {
    return { email: null, plan: null };
  }
}

// ---------- driving the CLI ----------

// The probe's own tmux server; its env drops the API's secrets (see
// child-env.ts) so the CLIs it probes never see them.
const probeTmux = (...args: string[]) =>
  execFileAsync('tmux', ['-L', PROBE_SOCKET, ...args], { timeout: 5_000, env: childEnv() });

/** Clear the API's secrets from an already-running probe tmux server. */
export async function scrubProbeServerSecretEnv(): Promise<void> {
  await scrubTmuxServerEnv((args) => probeTmux(...args), 'usage probe');
}

export type TerminalDriver = {
  start(argv: string[], env: Record<string, string>, cwd: string): Promise<void>;
  capture(): Promise<string>;
  sendText(text: string): Promise<void>;
  sendKey(key: 'Enter' | 'Up' | 'Down' | 'Escape'): Promise<void>;
  stop(): Promise<void>;
};

export function tmuxDriver(): TerminalDriver {
  const name = `usage-${randomUUID()}`;
  const tmux = probeTmux;
  return {
    async start(argv, env, cwd) {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      await tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '50', '-c', cwd, ...envArgs, '--', ...argv);
    },
    async capture() { return (await tmux('capture-pane', '-p', '-t', name)).stdout; },
    async sendText(text) { await tmux('send-keys', '-t', name, '-l', text); },
    async sendKey(key) { await tmux('send-keys', '-t', name, key); },
    async stop() { await tmux('kill-session', '-t', name).catch(() => undefined); },
  };
}

export type ProbeOptions = {
  // Claude's own start-up prompt reader (claude-code.ts), passed in by its
  // driver: the probe folder may not be trusted yet by a new account.
  readStartupPrompt: (paneText: string) => StartupPromptReading | null;
  driver?: TerminalDriver;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  cwd?: string;
  defaultZone?: string;
};

export async function probeClaude(account: AccountRef, options: ProbeOptions): Promise<AccountStatus> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = options.pollMs ?? 500;
  const budget = Math.ceil((options.timeoutMs ?? 45_000) / pollMs);
  const driver = options.driver ?? tmuxDriver();
  const status: AccountStatus = { ...baseStatus(account, now()), method: 'claude-cli-usage' };
  status.identity = await readClaudeIdentity(account);
  const cwd = options.cwd ?? PROBE_DIR;

  try {
    await mkdir(cwd, { recursive: true });
    // Environment goes through env(1), not tmux's `-e`: tmux can't unset a
    // variable, and tmux 3.4 silently ignores `-e PATH=…` (the pane keeps the
    // server's PATH), which under the bare systemd PATH means no janus/claude.
    const assignments = Object.entries(account.env).map(([key, value]) => `${key}=${value}`);
    const launch = [...account.launch, ...PROBE_FLAGS];
    const argv = account.unsetEnv.length || assignments.length
      ? ['env', ...account.unsetEnv.flatMap((key) => ['-u', key]), ...assignments, ...launch]
      : launch;
    await driver.start(argv, {}, cwd);
    let previous = '';
    let trustAnswered = false;
    let sentAtPoll: number | null = null;
    let resent = false;
    let lastUsage: string | null = null;
    for (let poll = 0; poll < budget; poll++) {
      await sleep(pollMs);
      const screen = await driver.capture();
      const seen = classifyClaudeScreen(screen, now(), options.defaultZone);
      if (seen.kind === 'login_required') {
        status.state = 'unauthenticated';
        status.error = t('account.probe.loginRequired');
        return status;
      }
      if (seen.kind === 'unsupported') {
        status.state = 'unsupported';
        status.error = seen.message;
        return status;
      }
      if (options.readStartupPrompt(screen)) {
        // The probe dir is an empty directory we own. Answered the way the
        // app answers a session's prompt; a later poll may still show it
        // while Claude redraws.
        if (!trustAnswered) {
          trustAnswered = true;
          const answer = await answerTrustMenu({ capture: () => driver.capture(), sendKey: (key) => driver.sendKey(key), sleep }, options.readStartupPrompt, 'trust');
          if (answer === 'unsure') {
            status.error = t('account.probe.trustUnanswered');
            return status;
          }
        }
        previous = screen;
        continue;
      }
      if (seen.kind === 'usage' && sentAtPoll !== null) {
        // Accept once the panel has rendered identically twice (bars fill in progressively).
        const key = JSON.stringify(seen.windows.map((w) => [w.id, w.usedPercent, w.resetsText]));
        if (key === lastUsage) {
          status.windows = seen.windows;
          status.state = 'ok';
          return status;
        }
        lastUsage = key;
        continue;
      }
      if (sentAtPoll === null && screen.trim() && screen === previous) {
        await driver.sendText('/usage');
        await sleep(TEXT_TO_ENTER_DELAY_MS);
        await driver.sendKey('Enter');
        sentAtPoll = poll;
      } else if (sentAtPoll !== null && !resent && poll - sentAtPoll > USAGE_RESEND_AFTER_MS / pollMs) {
        await driver.sendKey('Escape');
        await driver.sendText('/usage');
        await sleep(TEXT_TO_ENTER_DELAY_MS);
        await driver.sendKey('Enter');
        resent = true;
      }
      previous = screen;
    }
    status.error = 'timed out waiting for the /usage panel';
    return status;
  } catch (error) {
    const message = (error as Error).message;
    status.state = /command not found|No such file|ENOENT/i.test(message) ? 'not_installed' : 'error';
    status.error = message;
    return status;
  } finally {
    await driver.stop();
  }
}
