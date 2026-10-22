import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { probeCodex } from '../account-status/codex.js';
import { NATIVE_PROVIDER_HOMES, PROVIDER_ROOTS } from '../config.js';
import { UUID_SHAPE } from '../ids.js';
import { codexAdapter } from '../providers/codex.js';
import { inspectProcess, openFilesIn } from './process-evidence.js';
import { RUNTIME_LABELS } from '../contract/runtimes.js';
import { readMenu, readTrustMenu, type MenuSpec, type TrustMenuSpec } from './startup-prompt-menu.js';
import { codexModels } from './codex-models.js';
import { codexSandboxAvailable } from './codex-sandbox-state.js';
import type { IdentityObservation, LaunchPlan, MenuReading, RuntimeDriver, StartupPromptReading, UpdateChoice } from './types.js';
import { t } from '../i18n/index.js';

/**
 * Codex CLI 0.156.1 (launched with --no-daemon) holds a lock FD for its
 * thread before the first prompt; re-verified on 0.160.0 for a fresh
 * launch and for `resume`. It may retain old locks after an in-CLI
 * /clear, so only one open thread lock constitutes evidence. This does not
 * read a rollout or interact with the TUI.
 */
export async function observeCodexSession({ pid, home }: { pid: number; home: string }): Promise<IdentityObservation> {
  let canonicalHome: string;
  try { canonicalHome = await realpath(home); }
  catch { return { status: 'pending', reason: 'codex_home_unavailable' }; }
  const inspection = await inspectProcess(pid, (view) => view.comm === 'codex'
    ? codexLockIdsFromFdTargets(view.openFiles, canonicalHome)
    : null);
  if (inspection.status === 'unavailable') return { status: 'pending', reason: 'process_descriptors_unavailable' };
  if (inspection.status === 'changed') return { status: 'pending', reason: 'process_changed_during_observation' };
  const ids = inspection.value;
  if (!ids) return { status: 'pending', reason: 'foreground_process_is_not_codex' };
  return ids.length === 1
    ? { status: 'resolved', providerSessionId: ids[0]!, evidence: 'process_thread_lock' }
    // e.g. 0 when a shared app-server daemon owns the thread, 2 after /clear.
    : { status: 'unobservable', reason: `holds ${ids.length} thread locks (need exactly 1)` };
}

export function codexSessionIdFromFdTargets(targets: (string | null)[], home: string): string | null {
  const ids = codexLockIdsFromFdTargets(targets.filter((target): target is string => target !== null), home);
  return ids.length === 1 ? ids[0]! : null;
}

function codexLockIdsFromFdTargets(targets: string[], home: string): string[] {
  const lockDir = path.join(path.resolve(home), 'thread-writer-locks');
  return openFilesIn(targets, lockDir).flatMap((target) => {
    const match = /^([0-9a-f-]{36})\.lock$/i.exec(path.basename(target));
    return match && UUID_SHAPE.test(match[1]!) ? [match[1]!.toLowerCase()] : [];
  });
}

/**
 * Codex CLI 0.157.1's folder-trust prompt, shown on the first launch in a
 * directory its CODEX_HOME's config.toml has no trust_level for (verified
 * in an isolated tmux, 2026-09-27): "Trust this folder? Codex can read,
 * edit, and run files here, …" over "1. Trust and continue" / "2. Quit",
 * cursor marked by "› ", starting on Trust, Enter confirms, Esc quits.
 * The menu does not wrap. Answering clears the screen; Codex's own input
 * box also starts with "› ", so only the exact option labels count.
 * Captures: test/fixtures/startup-prompts/codex-*.
 */
export const codexTrustPrompt: TrustMenuSpec = {
  question: /Trust this folder\?/,
  trust: ['Trust and continue'],
  decline: ['Quit'],
  cursor: ['›', '>'],
  hints: /continue|quit/i,
};

export function readCodexStartupPrompt(paneText: string): StartupPromptReading | null {
  return readTrustMenu(paneText, codexTrustPrompt);
}

/**
 * Codex CLI 0.160.0 reopening a thread (verified in an isolated tmux,
 * 2026-10-05): `codex resume <id>` keeps appending to that thread's own
 * rollout under the same id, and with --no-daemon the pane's process holds
 * its one thread lock, so the resume is checked the same way a fresh
 * launch is bound. Without --no-daemon the lock sits on a shared daemon
 * when one runs (any -c also forces embedded mode, but isn't relied on).
 * --no-daemon goes after the subcommand: a native profile may already pass
 * it before `resume`, and Codex rejects the flag twice in one place but
 * accepts it on both. -C pins the working folder: without it, a thread
 * whose last recorded cwd differs first asks which folder to use, a menu
 * that would eat the first message.
 */
export function buildCodexResume(providerSessionId: string, cwd: string): LaunchPlan {
  if (!UUID_SHAPE.test(providerSessionId)) throw new Error('invalid Codex thread id');
  if (!path.isAbsolute(cwd)) throw new Error('Codex resume needs an absolute folder');
  return { argv: ['codex', 'resume', '--no-daemon', '-C', cwd, providerSessionId], providerSessionId };
}

/**
 * Codex CLI 0.161.0 forking a thread (verified in an isolated tmux,
 * 2026-10-08, cli-version-alignment.md): `codex fork <id>` from any folder
 * starts a new thread at once, in a new rollout that copies none of the
 * old one's history (its session_meta names it in `forked_from_id`; Codex
 * reads the old rollout for the memory). With --no-daemon the pane holds
 * the new thread's one lock, so it is bound the way a fresh launch is. No
 * "open in another app" screen while the old thread is still open. -C
 * pins the folder, as resume's does.
 */
export function buildCodexFork(fromProviderSessionId: string, cwd: string): LaunchPlan {
  if (!UUID_SHAPE.test(fromProviderSessionId)) throw new Error('invalid Codex thread id');
  if (!path.isAbsolute(cwd)) throw new Error('Codex fork needs an absolute folder');
  return { argv: ['codex', 'fork', '--no-daemon', '-C', cwd, fromProviderSessionId], providerSessionId: null };
}

/**
 * Codex CLI 0.160.0's screen when the resumed thread is still open in
 * another process (another pane, or a shared daemon that keeps a thread
 * for about a minute after its TUI exits): "🔒 This conversation is open in
 * another app" over the keys "r retry  f fork  esc/ctrl+c/q exit". It holds
 * no thread lock; any text typed into it is read as keys (f forks a new
 * thread, q quits). Only the screen's own last lines count — the key hints
 * last, the 🔒 line just above — so a reply quoting the sentence doesn't
 * match. Captures: test/fixtures/resume-conflicts/.
 */
export function readCodexResumeConflict(paneText: string): boolean {
  const lines = paneText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).slice(-3);
  return /^r retry\b.*\bf fork\b.*\bexit\b/.test(lines.at(-1) ?? '')
    && lines.some((line) => /^🔒\s*This conversation is open in another app/u.test(line));
}

/**
 * Codex CLI 0.162.1's launch permission modes (`codex --help`, and `codex
 * resume --help` / `codex fork --help` take the same flags; started in an
 * isolated tmux, 2026-10-11): `--approve-for-me` sends approval requests
 * to automatic review in the workspace-write sandbox (status bar
 * "Workspace · Approve for me"); `--dangerously-bypass-approvals-and-sandbox`
 * runs everything unsandboxed ("Full Access · never"). Neither shows a
 * screen before the input box. Both override the CODEX_HOME's own
 * approval_policy / sandbox_mode for that launch. The sandbox needs
 * bubblewrap with user namespaces: on a host that blocks them (Ubuntu's
 * kernel.apparmor_restrict_unprivileged_userns=1 without a bwrap profile)
 * every command of an auto launch fails before it runs (TODO.md).
 */
export function codexPermissionArgs(mode: 'auto' | 'yolo'): string[] {
  return mode === 'auto' ? ['--approve-for-me'] : ['--dangerously-bypass-approvals-and-sandbox'];
}

/**
 * Codex CLI 0.163.0's update check (verified in an isolated tmux and
 * CODEX_HOME, 2026-10-16, cli-version-alignment.md): with version.json's
 * latest_version newer than itself, every TUI start — fresh, `resume`,
 * `fork` — first shows "Update available · 0.163.0 → x" over "1. Update now
 * (runs `npm install -g @openai/codex`)" / "2. Skip" / "3. Skip until next
 * version", cursor on Update now. Enter there updates the shared global
 * install and quits ("🎉 Update ran successfully! Please restart Codex.").
 * `-c check_for_update_on_startup=false` shows neither that menu nor the
 * update notice, on all three. -c otherwise forces Codex's embedded mode,
 * which --no-daemon already asks for: the pane still holds its one thread
 * lock, so the session is bound as before.
 */
export const CODEX_UPDATE_CHECK_OFF = ['-c', 'check_for_update_on_startup=false'] as const;

/**
 * The update menu above, as Codex 0.163.0 draws it: cursor "› ", numbered
 * options (Update now's label names the install command, so only its start
 * is matched), key hints "enter continue · esc skip". The menu wraps
 * around. Captures: test/fixtures/launch-screens/codex.update-*.
 */
export const codexUpdatePrompt: MenuSpec<UpdateChoice> = {
  question: /Update available\b/,
  options: [
    { choice: 'update', labels: ['Update now'] },
    { choice: 'skip', labels: ['Skip'] },
    { choice: 'skip_version', labels: ['Skip until next version'] },
  ],
  cursor: ['›', '>'],
  hints: /enter continue|esc skip/i,
};

export function readCodexUpdatePrompt(paneText: string): MenuReading<UpdateChoice> | null {
  return readMenu(paneText, codexUpdatePrompt);
}

/**
 * What Codex 0.163.0 leaves on screen after updating itself from that menu
 * (seen live 2026-10-16, cube's handoff): "🎉 Update ran successfully!
 * Please restart Codex." and then the shell's prompt. Only the screen's
 * last few lines count.
 */
export function readCodexUpdated(paneText: string): boolean {
  const lines = paneText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).slice(-3);
  return lines.some((line) => /Please restart Codex\.?$/.test(line));
}

/**
 * Codex CLI's input box, ready for a message (0.157.1, 0.160.0, 0.161.0 and
 * 0.163.0 captures): a "› " line that isn't a numbered menu option, with
 * only its footer below — a status line ("model · folder · …", "? for
 * shortcuts") — and nothing after it. While a turn runs, its working line
 * ("… esc to interrupt") sits above the box, which stays: that is busy, not
 * ready. The trust and update menus number their
 * options; the login screen uses "> ".
 */
export function readCodexInputReady(paneText: string): boolean {
  const lines = paneText.split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  let box = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (/^› /.test(lines[i]!) || lines[i] === '›') {
      box = i;
      break;
    }
  }
  if (box < 0 || /^›\s*\d+\.\s/.test(lines[box]!)) return false;
  const footer = lines.slice(box + 1).filter((line) => line.trim() !== '');
  if (!footer.length || footer.length > 3 || !footer.every((line) => /^ {2}\S/.test(line))) return false;
  if (!footer.some((line) => / · |\? for shortcuts/.test(line))) return false;
  // The working line can sit a few lines up, with the turn's output below it.
  const above = lines.slice(Math.max(0, box - 12), box).join('\n');
  return !/esc to interrupt/i.test(above);
}

export const codexCliRuntime: RuntimeDriver = {
  ...codexAdapter,
  runtimeId: 'codex-cli',
  provider: 'codex',
  label: RUNTIME_LABELS['codex-cli'],
  nativeProfile: { configKey: 'codex', label: () => t('launch.native.codex'), defaultExecutable: 'codex' },
  janus: { conversationSubdir: 'sessions' },
  accountStatus: { probe: (account) => probeCodex(account) },
  // Installed through npm, the pane's foreground process is a node wrapper.
  processIdentity: { commands: ['codex'], wrappers: ['node'] },
  buildLaunch() {
    // Codex 0.156.1 otherwise attaches the TUI to a shared app-server daemon
    // for this CODEX_HOME when one is running (e.g. Codex Desktop's). The
    // daemon then owns the thread-writer lock, leaving this pane's process
    // with nothing to observe, so its session id could never be bound.
    return { argv: ['codex', '--no-daemon'], providerSessionId: null };
  },
  // 0.156.1: C-c exits at an idle prompt but only interrupts a running turn
  // ("Conversation interrupted"); Escape interrupts, then C-c exits.
  buildExitPlan: () => ({ status: 'supported', kind: 'control', key: 'C-c' }),
  buildResume: buildCodexResume,
  resume: { kind: 'in_place' },
  fork: { buildFork: buildCodexFork },
  // Esc leaves the conflict screen by exiting Codex (verified 0.160.0).
  resumeConflict: { detect: readCodexResumeConflict, dismissKey: 'Escape' },
  interruptReply: 'Escape',
  // Codex can render injected text but treat an immediately-following Enter
  // as a line break. A live 0.156.1 pane reproduces this without a pause and
  // submits reliably when the key is sent 100ms after the text — for short
  // text. In 0.160.0, typed text of a few hundred characters or more leaves
  // its Enter unsubmitted (the delay needed grows with the length), and a
  // ~4000-character one lost ~600 characters. Pasted as one bracketed
  // paste, 30–8000 characters, multi-line text and text sent right after
  // an Esc interrupt all arrived whole with this same 100ms (2026-10-05).
  submitDelayMs: 100,
  textInput: 'paste',
  readStartupPrompt: readCodexStartupPrompt,
  models: codexModels,
  identity: {
    kind: 'observed_after_start',
    observe: ({ pid, profile }) => profile.home
      ? observeCodexSession({ pid, home: profile.home })
      : Promise.resolve({ status: 'pending', reason: 'launch_profile_has_no_codex_home' }),
  },
  updateCheckOff: { args: CODEX_UPDATE_CHECK_OFF },
  readInputReady: readCodexInputReady,
  updatePrompt: { read: readCodexUpdatePrompt, updated: readCodexUpdated },
  nativeLocations: () => ({ home: NATIVE_PROVIDER_HOMES.codex, conversationRoot: PROVIDER_ROOTS.codex }),
  // A native codex must use the snapshot's home, not whatever the pane's
  // shell happens to export. Janus sets CODEX_HOME for its own profiles.
  nativeLaunchEnv: (profile): Record<string, string> => (profile.home ? { CODEX_HOME: profile.home } : {}),
  permissionArgs: codexPermissionArgs,
  // auto runs every command in Codex's workspace-write sandbox: not offered
  // where that sandbox can't start (probed, permission-modes/codex-sandbox.ts).
  permissionModeUnavailable: (mode) => (mode === 'auto' && !codexSandboxAvailable() ? 'sandbox_unavailable' : null),
  permissionConflicts: {
    always: ['--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '-a', '--ask-for-approval', '-s', '--sandbox'],
  },
};
