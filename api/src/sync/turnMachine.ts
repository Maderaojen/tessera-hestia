import { STUCK_HINT_MS } from '../config.js';
import { activeTurnPhase, type ManagedSession, type PaneActivity, type PendingInteraction, type TurnPhase } from '../types.js';
import type { TurnChanges } from './turns.js';
import type { PastedTextMark } from '../pastedText.js';

// What nextTurn needs to know about the session. `phase` is null while the
// CLI lifecycle isn't 'ready' (idle / launching / dead): no turn exists then.
export type TurnState = {
  phase: TurnPhase | null;
  pendingToolUseId: string | null;
  lastError: string | null;
  // The stuck hint is showing (ManagedSession.stuckSince).
  stuck: boolean;
  paneActivity: PaneActivity;
};

export type TurnEvent =
  // Routes.
  // pastes: the parts of `text` sent as pasted text (pastedText.ts).
  | { type: 'send'; text: string; at: string; pastes?: PastedTextMark[] }
  | { type: 'stop' }
  | { type: 'manual_resume' }
  | { type: 'runtime_left_ready' }
  // Poller observations. Each is only raised once its own gate (stability,
  // pane idle clock, freshness of a terminal message …) has passed.
  // A real user message typed straight into the pane whose reply isn't done.
  | { type: 'terminal_message'; text: string; at: string }
  // The transcript ends on a turn a person opened that is still being
  // written, after the app had ended its own (a stop the CLI didn't take, a
  // pane misread as idle). `message`: that turn's message when it was never
  // recorded as sent (typed in the terminal), else null.
  | { type: 'open_turn'; message: { text: string; at: string } | null }
  // A pending tool_use the pane also shows as a prompt (or the pane couldn't
  // be read, in which case the transcript alone decides).
  | { type: 'permission_prompt'; interaction: PendingInteraction }
  // This poll found no confirmed prompt.
  | { type: 'prompt_gone' }
  // The pane sampled while replying.
  | { type: 'pane_observed'; activity: PaneActivity }
  // A tick that doesn't sample the pane (anything but replying): whatever
  // it last saw belongs to a turn that is over.
  | { type: 'pane_unsampled' }
  // The transcript watch while replying: did the file change since the last
  // poll, and how long has everything been quiet.
  | { type: 'transcript_watch'; changed: boolean; quietMs: number; paneActivity: PaneActivity }
  // The transcript has gone quiet. turnComplete: the adapter's structural
  // signal (null: it can't tell). paneIdleLongEnough: the pane has shown the
  // CLI's input box continuously for PANE_IDLE_FINALIZE_MS.
  // awaitedLanded: the turn of the latest send is in the transcript (sync/turns.ts awaitedTurnLanded).
  // turnOpen: the transcript ends on a turn still going (TranscriptAdapter.openTurnAtEnd);
  // while idle, what it has written so far is imported all the same.
  | { type: 'transcript_settled'; turnComplete: boolean | null; paneIdleLongEnough: boolean; awaitedLanded: boolean; changes: TurnChanges; turnOpen?: boolean }
  // After a stop: the interrupted reply is in the transcript (or the wait
  // for its marker timed out).
  | { type: 'interrupted_reply'; changes: TurnChanges };

// Plain data; sync/turnEffects.ts applyTurnEffects performs them.
export type TurnEffect =
  // Writes turnPhase — the only thing that ever changes it.
  | { kind: 'enter_phase'; phase: TurnPhase }
  // fromTerminal: typed in the terminal, not sent by the app.
  | { kind: 'record_sent'; at: string; text: string; fromTerminal?: true; pastes?: PastedTextMark[] }
  | { kind: 'import_turns'; changes: TurnChanges }
  | { kind: 'set_pending'; interaction: PendingInteraction }
  | { kind: 'clear_pending' }
  | { kind: 'set_stuck_hint' }
  | { kind: 'clear_stuck_hint' }
  // Clears whatever is shown: lastError and the stuck hint.
  | { kind: 'clear_last_error' }
  | { kind: 'set_pane_activity'; value: PaneActivity }
  // The watched turn is over: its stability and pane idle clocks restart.
  | { kind: 'restart_turn_watch' };

export type TurnResult = { phase: TurnPhase | null; effects: TurnEffect[] };

export function turnStateOf(
  session: Pick<ManagedSession, 'status' | 'turnPhase' | 'pendingInteraction' | 'lastError' | 'stuckSince' | 'paneActivity'>,
): TurnState {
  return {
    phase: activeTurnPhase(session),
    pendingToolUseId: session.pendingInteraction?.toolUseId ?? null,
    lastError: session.lastError,
    stuck: !!session.stuckSince,
    paneActivity: session.paneActivity ?? 'unknown',
  };
}

// A reply that's over: import what's there and unlock.
const FINISH_TURN: TurnEffect[] = [
  { kind: 'restart_turn_watch' },
  { kind: 'enter_phase', phase: 'idle' },
  { kind: 'clear_last_error' },
  { kind: 'set_pane_activity', value: 'unknown' },
];

// The transition table of docs/decisions/0007-session-state-machine.md §2. Every
// combination not handled below leaves the phase alone and does nothing.
export function nextTurn(current: TurnState, event: TurnEvent): TurnResult {
  const { phase } = current;
  const stay: TurnResult = { phase, effects: [] };
  const hasChanges = (changes: TurnChanges) => changes.newTurns.length > 0 || changes.grownLast !== null;

  switch (event.type) {
    case 'send':
      // Accepted in every phase, not only idle: the composer is deliberately
      // never gated on our own readiness detection (see routes/messages.ts).
      return {
        phase: 'replying',
        effects: [
          { kind: 'enter_phase', phase: 'replying' },
          { kind: 'record_sent', at: event.at, text: event.text, ...(event.pastes?.length ? { pastes: event.pastes } : {}) },
        ],
      };

    case 'terminal_message':
      if (phase !== 'idle') return stay;
      return {
        phase: 'replying',
        effects: [
          { kind: 'enter_phase', phase: 'replying' },
          { kind: 'record_sent', at: event.at, text: event.text, fromTerminal: true },
          { kind: 'clear_last_error' },
        ],
      };

    case 'open_turn':
      if (phase !== 'idle') return stay;
      return {
        phase: 'replying',
        effects: [
          { kind: 'enter_phase', phase: 'replying' },
          ...(event.message ? [{ kind: 'record_sent' as const, at: event.message.at, text: event.message.text, fromTerminal: true as const }] : []),
          { kind: 'clear_last_error' },
        ],
      };

    case 'permission_prompt':
      if (phase !== 'replying' && phase !== 'awaiting_approval') return stay;
      // Arrow-key navigation within an open menu keeps the same tool_use
      // pending; re-publishing an identical card every tick is just noise.
      if (phase === 'awaiting_approval' && current.pendingToolUseId === event.interaction.toolUseId) return stay;
      return {
        phase: 'awaiting_approval',
        effects: [
          { kind: 'restart_turn_watch' },
          { kind: 'enter_phase', phase: 'awaiting_approval' },
          { kind: 'set_pending', interaction: event.interaction },
          { kind: 'clear_last_error' },
          { kind: 'set_pane_activity', value: 'unknown' },
        ],
      };

    case 'prompt_gone':
      if (phase !== 'awaiting_approval') return stay;
      return { phase: 'replying', effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'clear_pending' }] };

    case 'pane_observed':
      if (phase !== 'replying' || event.activity === current.paneActivity) return stay;
      return { phase, effects: [{ kind: 'set_pane_activity', value: event.activity }] };

    case 'pane_unsampled':
      if (phase === 'replying' || current.paneActivity === 'unknown') return stay;
      return { phase, effects: [{ kind: 'set_pane_activity', value: 'unknown' }] };

    case 'transcript_watch':
      if (phase !== 'replying') return stay;
      if (event.changed && current.stuck) return { phase, effects: [{ kind: 'clear_stuck_hint' }] };
      // Only a hint, and never over an error already shown.
      if (!current.stuck && !current.lastError && event.quietMs >= STUCK_HINT_MS && event.paneActivity !== 'busy') {
        return { phase, effects: [{ kind: 'set_stuck_hint' }] };
      }
      return stay;

    case 'transcript_settled':
      if (phase === 'idle') {
        // A turn still going shows as it is written, whoever opened it.
        if ((event.turnComplete === false && !event.turnOpen) || !hasChanges(event.changes)) return stay;
        return { phase, effects: [{ kind: 'import_turns', changes: event.changes }] };
      }
      if (phase !== 'replying') return stay;
      {
        const imports: TurnEffect[] = [{ kind: 'import_turns', changes: event.changes }];
        // Over when the transcript says so (or can't say, and quiescence
        // stands in) once the reply being waited on has landed — not on an
        // earlier turn growing — or when a transcript that never says
        // "done" (e.g. a tool interrupted before its tool_result) is settled
        // by the pane.
        const over = event.turnComplete === false ? event.paneIdleLongEnough : event.awaitedLanded;
        if (over) return { phase: 'idle', effects: [...FINISH_TURN, ...imports] };
        // Still replying: what is written so far shows already (a CLI's
        // progress notes, text between tool calls), and keeps growing in place.
        return hasChanges(event.changes) ? { phase, effects: imports } : stay;
      }

    case 'interrupted_reply':
      if (phase !== 'idle' || !hasChanges(event.changes)) return stay;
      return { phase, effects: [{ kind: 'import_turns', changes: event.changes }] };

    case 'stop':
      if (phase !== 'replying' && phase !== 'awaiting_approval') return stay;
      return {
        phase: 'idle',
        effects: [{ kind: 'enter_phase', phase: 'idle' }, { kind: 'clear_pending' }, { kind: 'clear_last_error' }],
      };

    case 'manual_resume':
      if (phase !== 'replying' && phase !== 'awaiting_approval') return stay;
      return {
        phase: 'idle',
        effects: [{ kind: 'enter_phase', phase: 'idle' }, { kind: 'clear_pending' }, { kind: 'clear_last_error' }],
      };

    case 'runtime_left_ready': {
      // No enter_phase: with the CLI not 'ready' there is no turn whatever
      // turnPhase holds, and the next entry into 'ready' starts it over (see
      // registry.ts lifecycleTransition). Only what the ended turn left
      // behind is cleared; a lifecycle error message in lastError is kept.
      const effects: TurnEffect[] = [];
      if (current.pendingToolUseId !== null) effects.push({ kind: 'clear_pending' });
      if (current.stuck) effects.push({ kind: 'clear_stuck_hint' });
      if (current.paneActivity !== 'unknown') effects.push({ kind: 'set_pane_activity', value: 'unknown' });
      return { phase: 'idle', effects };
    }
  }
}
