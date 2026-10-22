import { RESUME_IDENTITY_TIMEOUT_MS } from '../config.js';
import type { RuntimeDriver } from '../runtimes/types.js';
import * as tmuxCli from '../tmux.js';
import type { ConversationSegment, ManagedSession } from '../types.js';
import { requestRuntimeExit } from './exit.js';
import { t, type MessageKey } from '../i18n/index.js';

// A resumed conversation is reopened in place: its turns stay and later
// ones are appended, so the CLI that came up must be holding exactly that
// conversation. A runtime whose id is pinned on the command line (Claude)
// can't come up on another one. One whose identity is only observed after
// start (Codex) can — the thread may still be open elsewhere, and the CLI
// then shows a menu instead, where anything typed is read as keys — so
// until it is seen holding that very conversation the resume does not
// count, and the app sends nothing into the pane (it stays in transition).

export type ResumeIdentityVerdict =
  | { verdict: 'confirmed' }
  // message: what the user should know meanwhile, or null.
  | { verdict: 'waiting'; message: string | null }
  // The CLI was already asked to leave; the attempt is to be failed with this.
  | { verdict: 'failed'; message: string };

// What the session's last error says, by key (resolved when written).
export const RESUME_CONFLICT_MESSAGE = 'session.resume.conflict' satisfies MessageKey;
export const RESUME_MISMATCH_MESSAGE = 'session.resume.mismatch' satisfies MessageKey;
export const RESUME_UNCONFIRMED_MESSAGE = 'session.resume.unconfirmed' satisfies MessageKey;
export const RESUME_STARTUP_PROMPT_MESSAGE = 'session.resume.startupPrompt' satisfies MessageKey;

/**
 * One look at a just-started resume. Called by the poller only once the
 * CLI's process is confirmed alive in the pane. `dispatchedAt`: when the
 * resume command was sent, for the timeout.
 */
export async function settleResumedIdentity(input: {
  session: ManagedSession;
  runtime: RuntimeDriver;
  conversation: ConversationSegment;
  dispatchedAt: string | null;
  now?: number;
}): Promise<ResumeIdentityVerdict> {
  const { session, runtime, conversation } = input;
  if (runtime.identity.kind !== 'observed_after_start') return { verdict: 'confirmed' };
  const expected = conversation.providerSessionId?.toLowerCase();
  const profile = conversation.launchProfile;
  if (!expected || !profile) return leave(session, runtime, t(RESUME_UNCONFIRMED_MESSAGE));

  const pid = await tmuxCli.getPaneRuntimePid(session.tmuxName, runtime.processIdentity);
  if (pid !== null) {
    const observation = await runtime.identity.observe({ pid, profile, startedAt: conversation.startedAt });
    if (observation.status === 'resolved') {
      return observation.providerSessionId.toLowerCase() === expected
        ? { verdict: 'confirmed' }
        : leave(session, runtime, t(RESUME_MISMATCH_MESSAGE));
    }
  }

  let pane: string | null = null;
  try { pane = await tmuxCli.capturePane(session.tmuxName); } catch { /* judged on the next poll */ }
  if (pane !== null && runtime.resumeConflict?.detect(pane)) {
    // Never type into it: leave by its own key, which exits the CLI.
    try { await tmuxCli.sendKey(session.tmuxName, runtime.resumeConflict.dismissKey); } catch { /* the failed attempt says why */ }
    return { verdict: 'failed', message: t(RESUME_CONFLICT_MESSAGE) };
  }
  // A start-up prompt waits on the user, however long that takes.
  if (pane !== null && runtime.readStartupPrompt?.(pane)) return { verdict: 'waiting', message: t(RESUME_STARTUP_PROMPT_MESSAGE) };
  const age = (input.now ?? Date.now()) - Date.parse(input.dispatchedAt ?? '');
  if (Number.isFinite(age) && age >= RESUME_IDENTITY_TIMEOUT_MS) return leave(session, runtime, t(RESUME_UNCONFIRMED_MESSAGE));
  return { verdict: 'waiting', message: null };
}

// The CLI came up on something that isn't this conversation (or can't be
// shown to be): ask it to exit through its verified exit, as at an idle
// prompt — nothing has been sent to it.
async function leave(session: ManagedSession, runtime: RuntimeDriver, message: string): Promise<ResumeIdentityVerdict> {
  try { await requestRuntimeExit(session.tmuxName, runtime, 'idle'); } catch { /* the failed attempt says why */ }
  return { verdict: 'failed', message };
}
