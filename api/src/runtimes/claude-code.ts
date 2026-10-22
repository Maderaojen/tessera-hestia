import { randomUUID } from 'node:crypto';
import { probeClaude } from '../account-status/claude.js';
import { claudeLoginProtocol } from '../account-status/claude-login.js';
import { readClaudeLoginExpiry } from '../account-status/login-expiry.js';
import { NATIVE_PROVIDER_HOMES, PROVIDER_ROOTS } from '../config.js';
import { CLAUDE_SESSION_ID, claudeAdapter } from '../providers/claude.js';
import { RUNTIME_LABELS } from '../contract/runtimes.js';
import { readTrustMenu, type TrustMenuSpec } from './startup-prompt-menu.js';
import { claudeModels } from './claude-models.js';
import type { LaunchPlan, RuntimeDriver, StartupPromptReading } from './types.js';
import { t } from '../i18n/index.js';

export function buildClaudeResume(providerSessionId: string): LaunchPlan {
  if (!CLAUDE_SESSION_ID.test(providerSessionId)) {
    throw new Error('invalid Claude session id');
  }
  return { argv: ['claude', '--resume', providerSessionId], providerSessionId };
}

/**
 * Claude Code 2.1.294 forking a conversation (verified in an isolated tmux,
 * 2026-10-08, cli-version-alignment.md): `--resume <id> --fork-session`
 * takes `--session-id` for the new one, finds the old one from any cwd,
 * and writes a new transcript under the new cwd's project folder — a copy
 * of the old one's records (timestamps kept) followed by its own, written
 * from its first message on. The old one is left untouched, even while
 * its own CLI is still open.
 */
export function buildClaudeFork(fromProviderSessionId: string): LaunchPlan {
  if (!CLAUDE_SESSION_ID.test(fromProviderSessionId)) {
    throw new Error('invalid Claude session id');
  }
  const sessionId = randomUUID();
  return { argv: ['claude', '--resume', fromProviderSessionId, '--fork-session', '--session-id', sessionId], providerSessionId: sessionId };
}

/**
 * Claude Code's workspace-trust prompt, shown on the first launch in a
 * directory it hasn't been trusted in (seen 2026-09-25 in a fresh folder):
 * "Quick safety check: Is this a project you created or one you trust?"
 * over "No, exit" / "Yes, I trust this folder", cursor marked by "❯ ", Enter
 * confirms — with the cursor starting on No, exit, so a message typed into
 * it quits Claude. Older versions asked "Do you trust the files in this
 * folder?" over numbered "1. Yes, proceed" / "2. No, exit"; both are read.
 * Captures: test/fixtures/startup-prompts/claude-*.
 */
export const claudeTrustPrompt: TrustMenuSpec = {
  question: /Is this a project you created or one you trust\?|Do you trust the files in this folder\?/,
  trust: ['Yes, I trust this folder', 'Yes, proceed'],
  decline: ['No, exit'],
  cursor: ['❯', '>'],
  hints: /confirm|cancel/i,
};

export function readClaudeStartupPrompt(paneText: string): StartupPromptReading | null {
  return readTrustMenu(paneText, claudeTrustPrompt);
}

/**
 * Claude Code 2.1.296's launch permission modes (verified in an isolated
 * tmux, 2026-10-11, cli-version-alignment.md). `--permission-mode auto`
 * starts at the input box ("auto mode on"). bypassPermissions — like
 * --dangerously-skip-permissions — first shows "WARNING: Claude Code
 * running in Bypass Permissions mode" with the cursor on "No, exit": Enter
 * or Esc quits, and a message typed into it would too. The flag-level
 * setting skipDangerousModePermissionPrompt skips that screen for this one
 * launch without writing it to the account's settings (the user already
 * confirmed yolo in the app).
 */
export const CLAUDE_YOLO_SETTINGS = '{"skipDangerousModePermissionPrompt":true}';

export function claudePermissionArgs(mode: 'auto' | 'yolo'): string[] {
  return mode === 'auto'
    ? ['--permission-mode', 'auto']
    : ['--permission-mode', 'bypassPermissions', '--settings', CLAUDE_YOLO_SETTINGS];
}

export const claudeCodeRuntime: RuntimeDriver = {
  ...claudeAdapter,
  runtimeId: 'claude-code',
  provider: 'claude',
  label: RUNTIME_LABELS['claude-code'],
  nativeProfile: { configKey: 'claude', label: () => t('launch.native.claude'), defaultExecutable: 'claude' },
  janus: { conversationSubdir: 'projects' },
  // A native account means "whatever the CLI uses with no override".
  accountStatus: {
    probe: (account) => probeClaude(account, { readStartupPrompt: readClaudeStartupPrompt }),
    nativeUnsetEnv: ['CLAUDE_CONFIG_DIR'],
    readLoginExpiry: readClaudeLoginExpiry,
    login: claudeLoginProtocol,
  },
  processIdentity: { commands: ['claude'], wrappers: [] },
  readStartupPrompt: readClaudeStartupPrompt,
  buildLaunch(_cwd, opts) {
    // Verified via `claude --help`: --session-id <uuid> pins the transcript
    // id at launch, so we never have to guess which file is "ours" even
    // with several Claude sessions starting at once. -n/--name is a
    // separate, purely cosmetic display name (prompt box / /resume picker).
    const sessionId = randomUUID();
    const argv = ['claude', '--session-id', sessionId];
    if (opts?.name) argv.push('-n', opts.name);
    return { argv, providerSessionId: sessionId };
  },
  buildResume: buildClaudeResume,
  // `claude --resume <id>` keeps appending to that session's own file.
  resume: { kind: 'in_place' },
  fork: { buildFork: buildClaudeFork },
  // Agent view lets ← on an empty prompt (or /bg) park the conversation as
  // a background job and show another agent in this pane instead. What the
  // app types then lands in that other agent, and no pane or state file
  // says which one is on screen (verified 2.1.283; the pid file's
  // parkedJobId stays set after returning). Off, the pane only ever shows
  // this conversation. Agent-tool subagents, background ones included, run
  // in-process and are unaffected.
  launchEnv: { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' },
  // Claude Code 2.1.301 (isolated HOME and CLAUDE_CONFIG_DIR, 2026-10-16):
  // `claude doctor` reads "Auto-updates: disabled (set by env:
  // DISABLE_AUTOUPDATER)" with it and "enabled" without. It stops only the
  // background self-update of the shared install; `claude update` by hand
  // still works. (DISABLE_UPDATES would stop that too: not the app's call.)
  updateCheckOff: { env: { DISABLE_AUTOUPDATER: '1' } },
  // The verified idle reading (providers/claude.ts paneShowsIdle, 2.1.281
  // and 2.1.284 captures): the input box between its two rules, nothing
  // busy, no permission prompt. The trust prompt and the bypass-permissions
  // warning have no rule right above their "❯" line.
  readInputReady: (paneText) => claudeAdapter.paneShowsIdle!(paneText),
  buildExitPlan: () => ({ status: 'supported', kind: 'text', text: '/exit' }),
  // The app's stop button relies on the same key.
  interruptReply: 'Escape',
  identity: { kind: 'pinned_at_launch' },
  models: claudeModels,
  nativeLocations: () => ({ home: NATIVE_PROVIDER_HOMES.claude, conversationRoot: PROVIDER_ROOTS.claude }),
  permissionArgs: claudePermissionArgs,
  permissionConflicts: {
    always: ['--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
    // yolo passes its own --settings.
    yoloOnly: ['--settings'],
  },
};
