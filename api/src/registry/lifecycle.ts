import type { ManagedSession, SessionStatus, TurnPhase } from '../types.js';

// Allowed CLI lifecycle moves (docs/decisions/0007-session-state-machine.md §1), taken
// from what the paths below actually do:
// - idle → launching: a launch, or a conversation switch started from a bare shell
// - ready → launching: a launch over a legacy provider-less record, /clear, a switch
// - dead → launching: a Claude resume, or a switch started from a dead tmux
// - launching → ready: any commit (launch, /clear, switch, resume, runtime
//   recovery), or a rollback to a 'ready' previous status
// - launching → idle / dead: a failed /clear or switch, a rolled-back launch
//   or resume, the tmux gone, a legacy launching record whose CLI exited
// - ready → idle: the CLI exited
// - idle / launching / ready → dead: reconcile found the tmux gone
// Staying put is always allowed.
export const LIFECYCLE_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['launching', 'dead'],
  launching: ['ready', 'idle', 'dead'],
  ready: ['launching', 'idle', 'dead'],
  dead: ['launching'],
};

// Every lifecycle `status` write goes through here; the result is spread
// into that path's own single write. Entering 'ready' starts the turn over
// at 'idle', so a stale 'replying' never survives a relaunch — unless it's
// a rollback returning to the same running CLI, which passes the phase it
// had (`restoreTurnPhase`). The stuck hint belongs to the turn it was
// raised in, so any real move drops it, except that same rollback. An
// unexpected move is logged and still applied: the table documents today's
// paths, it must never wedge a session.
export function lifecycleTransition(
  current: ManagedSession,
  to: SessionStatus,
  restoreTurnPhase?: TurnPhase,
): Pick<ManagedSession, 'status' | 'turnPhase' | 'stuckSince'> {
  const from = current.status;
  if (from !== to && !LIFECYCLE_TRANSITIONS[from]?.includes(to)) {
    console.warn(`[registry] unexpected lifecycle transition ${from} → ${to} for session ${current.id}`);
  }
  const keepsTurn = from === to || restoreTurnPhase !== undefined;
  return {
    status: to,
    turnPhase: to === 'ready' ? (restoreTurnPhase ?? 'idle') : current.turnPhase,
    stuckSince: keepsTurn ? (current.stuckSince ?? null) : null,
  };
}
