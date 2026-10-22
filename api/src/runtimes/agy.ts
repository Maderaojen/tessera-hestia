import { statSync } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import { UUID_SHAPE } from '../ids.js';
import { agyAdapter, agyConversationsRoot } from '../providers/agy.js';
import { verifyAgyDatabase } from '../providers/agy-sqlite.js';
import { inspectProcess, openFilesIn } from './process-evidence.js';
import { RUNTIME_LABELS } from '../contract/runtimes.js';
import { readTrustMenu, type TrustMenuSpec } from './startup-prompt-menu.js';
import { AGY_UPDATE_CHECK_OFF_ENV, agyModels } from './agy-models.js';
import type { IdentityObservation, RuntimeDriver, StartupPromptReading } from './types.js';

/**
 * Agy's workspace-trust prompt, shown on the first launch in a directory
 * not yet in its trustedWorkspaces (1.2.10 verified in an isolated tmux,
 * 2026-09-25): "Do you trust the contents of this project?" over a two-item
 * menu "Yes, I trust this folder" / "No, exit", cursor marked by "> ",
 * Enter confirms. The menu wraps around. 1.2.12 (seen live 2026-09-27)
 * also draws its right-aligned status bar under the key hints.
 * Captures: test/fixtures/startup-prompts/agy-*.
 */
export const agyTrustPrompt: TrustMenuSpec = {
  question: /Do you trust the contents of this project\?/,
  trust: ['Yes, I trust this folder'],
  decline: ['No, exit'],
  cursor: ['>'],
  hints: /navigate|confirm/i,
};

export function readAgyStartupPrompt(paneText: string): StartupPromptReading | null {
  return readTrustMenu(paneText, agyTrustPrompt);
}

const AGY_RULE = /^─{20,}\s*$/;

/**
 * Agy's input box, ready for a message (1.2.12 capture,
 * test/fixtures/model-switch/agy.answers.1.2.12.txt): a "> " line with a
 * full-width rule right above it and another right below, then the
 * footer ("? for shortcuts … mode · model") ending the screen. Its trust
 * menu draws its cursor "> " with no rules around it; its login menu
 * ("> 1. Google OAuth") neither.
 */
export function readAgyInputReady(paneText: string): boolean {
  const lines = paneText.split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (let i = lines.length - 2; i >= Math.max(1, lines.length - 8); i--) {
    if (!/^>(?: |$)/.test(lines[i]!) || /^>\s*\d+\.\s/.test(lines[i]!)) continue;
    if (!AGY_RULE.test(lines[i - 1]!) || !AGY_RULE.test(lines[i + 1] ?? '')) continue;
    // Only the footer below the closing rule.
    return lines.slice(i + 2).filter((line) => line.trim() !== '').length <= 2;
  }
  return false;
}

/**
 * Called with the foreground Agy PID belonging to one tmux pane. A currently
 * open conversation DB fd is positive provenance; directory order is not.
 * Agy 1.2.9 opens this fd after a prompt or /clear, then closes it after an
 * idle period. A missed observation remains pending until another proof.
 * Agy 1.2.12 also briefly opens an old, unrelated conversation's DB while
 * its workspace-trust prompt is up (seen 2026-09-27: one from another
 * folder, created weeks earlier), so a DB created before `notBefore` (the
 * segment's start) is never this launch's conversation.
 */
export async function observeAgySession(input: { pid: number; conversationRoot?: string; notBefore?: string }): Promise<IdentityObservation> {
  const root = agyConversationsRoot(input.conversationRoot);
  const inspection = await inspectProcess(input.pid, (view) => {
    // Agy's self-updater renames the running binary to agy.<stamp>.old.
    const exe = view.exe ? path.basename(view.exe).replace(/ \(deleted\)$/, '') : '';
    if (view.comm !== 'agy' || !/^agy(?:\.\d+\.old)?$/.test(exe)) return { kind: 'not_agy' } as const;
    const ids = [...new Set(openFilesIn(view.openFiles, root).flatMap((target) => {
      const id = path.basename(target).replace(/\.db$/, '');
      return UUID_SHAPE.test(id) && target === path.join(root, `${id}.db`) ? [id] : [];
    }))];
    if (ids.length !== 1) return { kind: 'candidates', count: ids.length } as const;
    // Verified while the process is fenced, so a restart cannot slip in.
    const file = path.join(root, `${ids[0]}.db`);
    return { kind: 'one', id: ids[0]!, verified: verifyAgyDatabase(file, ids[0]!) === 'verified', bornAt: birthTime(file) } as const;
  });
  if (inspection.status === 'unavailable') return { status: 'pending', reason: 'agy_process_not_available' };
  if (inspection.status === 'changed') return { status: 'ambiguous', reason: 'process_changed_during_observation' };
  const found = inspection.value;
  if (found.kind === 'not_agy') return { status: 'pending', reason: 'foreground_process_is_not_agy' };
  if (found.kind === 'candidates') {
    return found.count === 0
      ? { status: 'pending', reason: 'conversation_db_not_open' }
      : { status: 'ambiguous', reason: 'multiple_open_conversation_dbs' };
  }
  if (!found.verified) return { status: 'ambiguous', reason: 'conflicting_db_metadata' };
  const notBefore = input.notBefore ? Date.parse(input.notBefore) : NaN;
  // 1s of slack for filesystem timestamp granularity.
  if (found.bornAt !== null && Number.isFinite(notBefore) && found.bornAt < notBefore - 1000) {
    return { status: 'pending', reason: 'open_conversation_db_predates_launch' };
  }
  return { status: 'resolved', providerSessionId: found.id, evidence: 'process_fd_and_db_metadata' };
}

// A file's creation time in ms, or null where the filesystem doesn't record it.
function birthTime(file: string): number | null {
  try {
    const born = statSync(file).birthtimeMs;
    return born > 0 ? born : null;
  } catch {
    return null;
  }
}

export const agyRuntime: RuntimeDriver = {
  ...agyAdapter,
  runtimeId: 'agy',
  provider: 'gemini',
  label: RUNTIME_LABELS.agy,
  nativeProfile: { configKey: 'agy', label: 'Gemini · Agy', defaultExecutable: 'agy' },
  processIdentity: { commands: ['agy'], wrappers: [] },
  buildLaunch() { return { argv: ['agy'], providerSessionId: null }; },
  // Exists in the CLI (`agy --conversation=<id>`), but no app resume action
  // uses it yet: the spec keeps Agy resume out of scope until validated.
  buildResume(providerSessionId) {
    return { argv: ['agy', `--conversation=${providerSessionId}`], providerSessionId };
  },
  resume: { kind: 'unsupported', reason: 'Agy resume is out of scope until validated' },
  buildExitPlan: () => ({ status: 'supported', kind: 'text', text: '/exit' }),
  identity: {
    kind: 'observed_after_start',
    observe: ({ pid, profile, startedAt }) => observeAgySession({ pid, conversationRoot: profile.conversationRoot, notBefore: startedAt }),
  },
  readStartupPrompt: readAgyStartupPrompt,
  // Agy 1.3.3 (a copy of the binary, isolated HOME, --log-file, 2026-10-16):
  // its updater checks at every start and replaces its own binary in the
  // background ("Spawned background update process"; the copy became 1.4.0
  // with "Update successful, restart CLI to use"). With this set to `true`
  // it logs "Auto-update disabled via environment variable
  // AGY_CLI_DISABLE_AUTO_UPDATE" and leaves the binary alone; set to `1` it
  // still updated.
  updateCheckOff: { env: AGY_UPDATE_CHECK_OFF_ENV },
  readInputReady: readAgyInputReady,
  models: agyModels,
  // Agy 1.3.2 (`agy --help`, started in an isolated tmux 2026-10-11): yolo
  // is --dangerously-skip-permissions, which shows no screen of its own
  // (only the usual workspace-trust prompt). It has no "decide for me"
  // mode, so auto is unsupported.
  permissionArgs: (mode) => (mode === 'yolo' ? ['--dangerously-skip-permissions'] : null),
  permissionConflicts: { always: ['--dangerously-skip-permissions'] },
  nativeLocations: () => ({ home: path.join(HOME, '.gemini'), conversationRoot: path.join(HOME, '.gemini', 'antigravity-cli', 'conversations') }),
};
