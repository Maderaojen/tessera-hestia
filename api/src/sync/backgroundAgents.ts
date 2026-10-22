import { stat } from 'node:fs/promises';
import * as registry from '../registry.js';
import { activeTurnPhase, deriveSessionActivity, type ManagedSession } from '../types.js';
import type { OpenSubagent } from '../providers/types.js';
import { resolvedBinding } from './binding.js';

// How many of the CLI's own background subagents are still running, for
// the terminal button's breath once the main turn is over (a CLI ends its
// turn right after sending one off; the subagent keeps working). Kept apart
// from `activity`: the user can still type, hand off and be told the turn
// is done while they run — only the indicator shows them.
//
// Every tick costs only the main transcript the poller already reads (its
// parse is cached, the adapter's walk memoized): the subagents it says are
// still out. A CLI whose main transcript need not record a background
// subagent's end (Codex) has each confirmed against the subagent's own
// transcript tail, at most every BACKGROUND_CONFIRM_MS per session and only
// while the main turn is over; until then, and when that can't tell, the
// main transcript's word stands.

export const BACKGROUND_CONFIRM_MS = 12_000;
// A turn the CLI started by itself (backgroundTurn) whose transcript has
// been quiet this long is taken as over: one that ended without its
// closing record (a crash in the middle, a tool killed) must not keep the
// light on for good.
export const BACKGROUND_TURN_QUIET_MS = 10 * 60_000;

type Verdict = { since: string | null; running: boolean };
type Checks = { file: string; confirmedAt: number; verdicts: Map<string, Verdict> };

const checks = new Map<string, Checks>();

/**
 * A subagent runs inside its CLI's process: once the session's CLI is gone,
 * or was relaunched after the subagent started, one its transcript last saw
 * running will never write its end. Shared with the subagent listing
 * (routes/subagents.ts), which shows such a one as stopped.
 */
export function subagentOutlivedItsCli(session: ManagedSession, startedAt: string | null): boolean {
  const activity = deriveSessionActivity(session);
  if (activity === 'ended' || activity === 'not_started') return true;
  const launchedAt = session.providerLaunchedAt ? Date.parse(session.providerLaunchedAt) : Number.NaN;
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(launchedAt) && Number.isFinite(started) && started < launchedAt;
}

/** The number of the session's background subagents still running now. */
export async function countBackgroundAgents(session: ManagedSession, now: number = Date.now()): Promise<number> {
  const activity = deriveSessionActivity(session);
  const binding = activity === 'ended' || activity === 'not_started' || activity === 'starting' ? null : resolvedBinding(session);
  const adapter = binding?.adapter;
  if (!binding || !adapter?.openBackgroundSubagents) {
    checks.delete(session.id);
    return 0;
  }
  const open = (await adapter.openBackgroundSubagents(binding.file))
    .filter((agent) => !subagentOutlivedItsCli(session, agent.startedAt));
  if (open.length === 0) {
    checks.delete(session.id);
    return 0;
  }
  let state = checks.get(session.id);
  if (!state || state.file !== binding.file) {
    state = { file: binding.file, confirmedAt: Number.NEGATIVE_INFINITY, verdicts: new Map() };
    checks.set(session.id, state);
  }
  const verdictOf = (agent: OpenSubagent) => {
    const verdict = state.verdicts.get(agent.agentId);
    // A later word from the main transcript (set running again) outdates it.
    return verdict && verdict.since === agent.since ? verdict : undefined;
  };
  const confirm = adapter.subagentStillRunning;
  if (confirm && activeTurnPhase(session) === 'idle' && now - state.confirmedAt >= BACKGROUND_CONFIRM_MS) {
    state.confirmedAt = now;
    const ids = new Set(open.map((agent) => agent.agentId));
    for (const id of state.verdicts.keys()) if (!ids.has(id)) state.verdicts.delete(id);
    for (const agent of open) {
      // One seen ended stays ended until the main transcript says otherwise.
      if (verdictOf(agent)?.running === false) continue;
      const running = await confirm(binding.file, agent.agentId).catch(() => null);
      if (running === null) state.verdicts.delete(agent.agentId);
      else state.verdicts.set(agent.agentId, { since: agent.since, running });
    }
  }
  return open.filter((agent) => verdictOf(agent)?.running !== false).length;
}

/**
 * Whether the CLI is on a turn of its own while the app's is over: woken by
 * a background subagent's (or task's) result, it replies with no prompt
 * from anyone, so nothing moves the session out of idle (polling.ts
 * pollIdle only does that for a new user message; the reply is imported
 * once it settles). Only the end of the cached transcript is read.
 */
export async function readBackgroundTurn(session: ManagedSession, now: number = Date.now()): Promise<boolean> {
  if (deriveSessionActivity(session) !== 'idle' || activeTurnPhase(session) !== 'idle') return false;
  const binding = resolvedBinding(session);
  if (!binding?.adapter.openTurnAtEnd) return false;
  if (!await binding.adapter.openTurnAtEnd(binding.file).catch(() => null)) return false;
  const modified = await stat(binding.file).then((st) => st.mtimeMs, () => Number.NaN);
  return Number.isFinite(modified) && now - modified < BACKGROUND_TURN_QUIET_MS;
}

/** Writes only what changed: every write is pushed to clients. */
export async function refreshBackgroundAgents(session: ManagedSession, now: number = Date.now()): Promise<void> {
  const count = await countBackgroundAgents(session, now);
  const turn = await readBackgroundTurn(session, now);
  const patch: Partial<ManagedSession> = {};
  if ((session.backgroundAgents ?? 0) !== count) patch.backgroundAgents = count;
  if ((session.backgroundTurn ?? false) !== turn) patch.backgroundTurn = turn;
  if (Object.keys(patch).length === 0) return;
  await registry.updateSession(session.id, patch);
}

export function __resetBackgroundAgentChecksForTests(): void {
  checks.clear();
}
