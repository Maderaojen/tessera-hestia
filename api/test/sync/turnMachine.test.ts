import { describe, expect, it } from 'vitest';
import { STUCK_HINT_MS } from '../../src/config.js';
import { nextTurn, turnStateOf, type TurnEffect, type TurnEvent, type TurnState } from '../../src/sync/turnMachine.js';
import type { TurnChanges } from '../../src/sync/turns.js';
import { statusForPhase, turnPhaseOf, type PendingInteraction, type LegacySessionStatus, type Turn, type TurnPhase } from '../../src/types.js';

const turn = (n: number, reply = `reply ${n}`): Turn => ({
  index: n,
  user: { text: `q${n}`, at: `2026-01-01T00:00:0${n}Z` },
  assistant: { text: reply, at: `2026-01-01T00:00:0${n}Z` },
});

const NONE: TurnChanges = { newTurns: [], grownLast: null };
const NEW: TurnChanges = { newTurns: [turn(2)], grownLast: null };
const GROWN: TurnChanges = { newTurns: [], grownLast: turn(1, 'reply 1, longer') };
const PROMPT: PendingInteraction = { kind: 'tool_permission', toolUseId: 't1', toolName: 'Write', input: {}, detectedAt: 'x' };
const OTHER_PROMPT: PendingInteraction = { ...PROMPT, toolUseId: 't2' };

function state(phase: TurnPhase | null, overrides: Partial<TurnState> = {}): TurnState {
  return { phase, pendingToolUseId: null, lastError: null, stuck: false, paneActivity: 'unknown', ...overrides };
}

const FINISH: TurnEffect[] = [
  { kind: 'restart_turn_watch' },
  { kind: 'enter_phase', phase: 'idle' },
  { kind: 'clear_last_error' },
  { kind: 'set_pane_activity', value: 'unknown' },
];
const UNLOCK: TurnEffect[] = [{ kind: 'enter_phase', phase: 'idle' }, { kind: 'clear_pending' }, { kind: 'clear_last_error' }];

type Row = { name: string; current: TurnState; event: TurnEvent; phase: TurnPhase | null; effects: TurnEffect[] };

// One entry per row of docs/decisions/0007-session-state-machine.md §2 (a row with
// several "目前" values or observation variants gets one entry for each).
const TABLE: Row[] = [
  {
    name: 'idle + app send → replying, records the send',
    current: state('idle'),
    event: { type: 'send', text: 'hi', at: 'T' },
    phase: 'replying',
    effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'record_sent', at: 'T', text: 'hi' }],
  },
  {
    name: 'idle + unfinished terminal message → replying, records it (and clears lastError)',
    current: state('idle', { lastError: 'old' }),
    event: { type: 'terminal_message', text: 'typed', at: 'T' },
    phase: 'replying',
    effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'record_sent', at: 'T', text: 'typed', fromTerminal: true }, { kind: 'clear_last_error' }],
  },
  {
    name: 'idle + a turn a person opened still being written → replying',
    current: state('idle', { lastError: 'old' }),
    event: { type: 'open_turn', message: null },
    phase: 'replying',
    effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'clear_last_error' }],
  },
  {
    name: 'idle + such a turn whose message was typed in the terminal and never recorded → replying, records it',
    current: state('idle'),
    event: { type: 'open_turn', message: { text: 'typed', at: 'T' } },
    phase: 'replying',
    effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'record_sent', at: 'T', text: 'typed', fromTerminal: true }, { kind: 'clear_last_error' }],
  },
  {
    name: 'idle + a turn still going (the CLI\'s own) → idle, imports what is written so far',
    current: state('idle'),
    event: { type: 'transcript_settled', turnComplete: false, awaitedLanded: false, paneIdleLongEnough: false, changes: GROWN, turnOpen: true },
    phase: 'idle',
    effects: [{ kind: 'import_turns', changes: GROWN }],
  },
  {
    name: 'idle + completed unimported turns → idle, imports',
    current: state('idle'),
    event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: true, paneIdleLongEnough: false, changes: NEW },
    phase: 'idle',
    effects: [{ kind: 'import_turns', changes: NEW }],
  },
  {
    name: 'idle + completion unknown, unimported turns → idle, imports',
    current: state('idle'),
    event: { type: 'transcript_settled', turnComplete: null, awaitedLanded: false, paneIdleLongEnough: false, changes: GROWN },
    phase: 'idle',
    effects: [{ kind: 'import_turns', changes: GROWN }],
  },
  {
    name: 'replying + confirmed permission prompt → awaiting_approval, sets the pending tool',
    current: state('replying', { stuck: true, paneActivity: 'busy' }),
    event: { type: 'permission_prompt', interaction: PROMPT },
    phase: 'awaiting_approval',
    effects: [
      { kind: 'restart_turn_watch' },
      { kind: 'enter_phase', phase: 'awaiting_approval' },
      { kind: 'set_pending', interaction: PROMPT },
      { kind: 'clear_last_error' },
      { kind: 'set_pane_activity', value: 'unknown' },
    ],
  },
  {
    name: 'awaiting_approval + prompt gone → replying, clears the pending tool',
    current: state('awaiting_approval', { pendingToolUseId: 't1' }),
    event: { type: 'prompt_gone' },
    phase: 'replying',
    effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'clear_pending' }],
  },
  {
    name: 'replying + quiet + complete + new turn → idle, imports and clears the hint',
    current: state('replying', { stuck: true }),
    event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: true, paneIdleLongEnough: false, changes: NEW },
    phase: 'idle',
    effects: [...FINISH, { kind: 'import_turns', changes: NEW }],
  },
  {
    name: 'replying + quiet + completion unknown + new turn → idle, imports',
    current: state('replying'),
    event: { type: 'transcript_settled', turnComplete: null, awaitedLanded: true, paneIdleLongEnough: false, changes: NEW },
    phase: 'idle',
    effects: [...FINISH, { kind: 'import_turns', changes: NEW }],
  },
  {
    name: 'replying + quiet + incomplete + pane idle long enough → idle, imports what exists',
    current: state('replying', { paneActivity: 'idle' }),
    event: { type: 'transcript_settled', turnComplete: false, awaitedLanded: false, paneIdleLongEnough: true, changes: NONE },
    phase: 'idle',
    effects: [...FINISH, { kind: 'import_turns', changes: NONE }],
  },
  {
    name: 'replying + unfinished turn with text so far → replying, imports it',
    current: state('replying'),
    event: { type: 'transcript_settled', turnComplete: false, awaitedLanded: true, paneIdleLongEnough: false, changes: NEW },
    phase: 'replying',
    effects: [{ kind: 'import_turns', changes: NEW }],
  },
  {
    name: 'replying + the turn stored as it went is now complete → idle, imports the rest',
    current: state('replying'),
    event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: true, paneIdleLongEnough: false, changes: GROWN },
    phase: 'idle',
    effects: [...FINISH, { kind: 'import_turns', changes: GROWN }],
  },
  {
    name: 'replying + complete, already all stored → idle',
    current: state('replying'),
    event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: true, paneIdleLongEnough: false, changes: NONE },
    phase: 'idle',
    effects: [...FINISH, { kind: 'import_turns', changes: NONE }],
  },
  {
    name: 'replying + only the last stored reply grew → replying, updates that turn',
    current: state('replying'),
    event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: false, paneIdleLongEnough: false, changes: GROWN },
    phase: 'replying',
    effects: [{ kind: 'import_turns', changes: GROWN }],
  },
  {
    name: 'replying + quiet ≥ STUCK_HINT_MS and pane not busy → replying, sets the stuck hint',
    current: state('replying'),
    event: { type: 'transcript_watch', changed: false, quietMs: STUCK_HINT_MS, paneActivity: 'idle' },
    phase: 'replying',
    effects: [{ kind: 'set_stuck_hint' }],
  },
  {
    name: 'replying + transcript changed again → replying, clears the stuck hint',
    current: state('replying', { stuck: true }),
    event: { type: 'transcript_watch', changed: true, quietMs: 0, paneActivity: 'busy' },
    phase: 'replying',
    effects: [{ kind: 'clear_stuck_hint' }],
  },
  { name: 'replying + stop → idle', current: state('replying', { stuck: true }), event: { type: 'stop' }, phase: 'idle', effects: UNLOCK },
  { name: 'awaiting_approval + stop → idle', current: state('awaiting_approval', { pendingToolUseId: 't1' }), event: { type: 'stop' }, phase: 'idle', effects: UNLOCK },
  { name: 'replying + manual resume → idle', current: state('replying'), event: { type: 'manual_resume' }, phase: 'idle', effects: UNLOCK },
  { name: 'awaiting_approval + manual resume → idle', current: state('awaiting_approval', { pendingToolUseId: 't1' }), event: { type: 'manual_resume' }, phase: 'idle', effects: UNLOCK },
  ...(['idle', 'replying', 'awaiting_approval', null] as const).map((phase): Row => ({
    name: `${phase ?? 'no turn'} + runtime left ready → idle, clears what the turn left behind`,
    current: state(phase, { pendingToolUseId: 't1', stuck: true, lastError: 'launch failed', paneActivity: 'busy' }),
    event: { type: 'runtime_left_ready' },
    phase: 'idle',
    // A lifecycle error in lastError is kept; only the turn's hint goes.
    effects: [{ kind: 'clear_pending' }, { kind: 'clear_stuck_hint' }, { kind: 'set_pane_activity', value: 'unknown' }],
  })),
];

describe('nextTurn: the ADR transition table', () => {
  it.each(TABLE)('$name', ({ current, event, phase, effects }) => {
    expect(nextTurn(current, event)).toEqual({ phase, effects });
  });
});

// Outside the ADR table, kept so phase 1 changes no behavior: the composer
// is never gated on readiness (routes/messages.ts), and the pane observation
// is reset whenever a tick doesn't sample it.
describe('nextTurn: phase-1 behavior outside the table', () => {
  it.each(['replying', 'awaiting_approval', null] as const)('a send from %s still moves to replying', (phase) => {
    expect(nextTurn(state(phase, { pendingToolUseId: 't1' }), { type: 'send', text: 'hi', at: 'T' })).toEqual({
      phase: 'replying',
      effects: [{ kind: 'enter_phase', phase: 'replying' }, { kind: 'record_sent', at: 'T', text: 'hi' }],
    });
  });

  it('a new tool_use while already awaiting approval re-publishes the card', () => {
    const result = nextTurn(state('awaiting_approval', { pendingToolUseId: 't1' }), { type: 'permission_prompt', interaction: OTHER_PROMPT });
    expect(result.phase).toBe('awaiting_approval');
    expect(result.effects).toContainEqual({ kind: 'set_pending', interaction: OTHER_PROMPT });
  });

  it('a pane sample while replying is written only when it changes', () => {
    expect(nextTurn(state('replying', { paneActivity: 'idle' }), { type: 'pane_observed', activity: 'busy' }))
      .toEqual({ phase: 'replying', effects: [{ kind: 'set_pane_activity', value: 'busy' }] });
    expect(nextTurn(state('replying', { paneActivity: 'busy' }), { type: 'pane_observed', activity: 'busy' }))
      .toEqual({ phase: 'replying', effects: [] });
  });

  it.each(['idle', 'awaiting_approval', null] as const)('an unsampled tick resets a stale pane reading (%s)', (phase) => {
    expect(nextTurn(state(phase, { paneActivity: 'busy' }), { type: 'pane_unsampled' }))
      .toEqual({ phase, effects: [{ kind: 'set_pane_activity', value: 'unknown' }] });
    expect(nextTurn(state(phase), { type: 'pane_unsampled' })).toEqual({ phase, effects: [] });
  });

  it('the interrupted reply found after a stop is imported while idle', () => {
    expect(nextTurn(state('idle'), { type: 'interrupted_reply', changes: NEW }))
      .toEqual({ phase: 'idle', effects: [{ kind: 'import_turns', changes: NEW }] });
  });

  it('runtime_left_ready keeps a lifecycle error and clears nothing that isn\'t there', () => {
    expect(nextTurn(state(null, { lastError: 'tmux ended' }), { type: 'runtime_left_ready' })).toEqual({ phase: 'idle', effects: [] });
  });
});

// Every combination the table doesn't list: no transition, no effects.
const NO_TRANSITION: { name: string; current: TurnState; event: TurnEvent }[] = [
  { name: 'permission prompt while idle', current: state('idle'), event: { type: 'permission_prompt', interaction: PROMPT } },
  { name: 'permission prompt with no turn', current: state(null), event: { type: 'permission_prompt', interaction: PROMPT } },
  { name: 'the same prompt while already awaiting approval', current: state('awaiting_approval', { pendingToolUseId: 't1' }), event: { type: 'permission_prompt', interaction: PROMPT } },
  { name: 'prompt gone while replying', current: state('replying'), event: { type: 'prompt_gone' } },
  { name: 'prompt gone while idle', current: state('idle'), event: { type: 'prompt_gone' } },
  { name: 'prompt gone with no turn', current: state(null), event: { type: 'prompt_gone' } },
  { name: 'stop while idle', current: state('idle'), event: { type: 'stop' } },
  { name: 'stop with no turn', current: state(null), event: { type: 'stop' } },
  { name: 'manual resume while idle', current: state('idle'), event: { type: 'manual_resume' } },
  { name: 'manual resume with no turn', current: state(null), event: { type: 'manual_resume' } },
  { name: 'terminal message while replying', current: state('replying'), event: { type: 'terminal_message', text: 'x', at: 'T' } },
  { name: 'terminal message while awaiting approval', current: state('awaiting_approval'), event: { type: 'terminal_message', text: 'x', at: 'T' } },
  { name: 'terminal message with no turn', current: state(null), event: { type: 'terminal_message', text: 'x', at: 'T' } },
  { name: 'open turn while replying', current: state('replying'), event: { type: 'open_turn', message: null } },
  { name: 'open turn while awaiting approval', current: state('awaiting_approval'), event: { type: 'open_turn', message: null } },
  { name: 'open turn with no turn', current: state(null), event: { type: 'open_turn', message: null } },
  { name: 'idle: a turn still going with nothing new written', current: state('idle'), event: { type: 'transcript_settled', turnComplete: false, awaitedLanded: false, paneIdleLongEnough: false, changes: NONE, turnOpen: true } },
  { name: 'idle: settled but nothing to import', current: state('idle'), event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: false, paneIdleLongEnough: false, changes: NONE } },
  { name: 'idle: settled but the turn is unfinished', current: state('idle'), event: { type: 'transcript_settled', turnComplete: false, awaitedLanded: true, paneIdleLongEnough: true, changes: NEW } },
  { name: 'replying: settled, complete, nothing new', current: state('replying'), event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: false, paneIdleLongEnough: false, changes: NONE } },
  { name: 'replying: unfinished, nothing written yet', current: state('replying'), event: { type: 'transcript_settled', turnComplete: false, awaitedLanded: false, paneIdleLongEnough: false, changes: NONE } },
  { name: 'replying: complete but the awaited reply has not landed, nothing new', current: state('replying'), event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: false, paneIdleLongEnough: false, changes: NONE } },
  { name: 'awaiting approval: settled', current: state('awaiting_approval'), event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: true, paneIdleLongEnough: false, changes: NEW } },
  { name: 'no turn: settled', current: state(null), event: { type: 'transcript_settled', turnComplete: true, awaitedLanded: true, paneIdleLongEnough: false, changes: NEW } },
  { name: 'replying: quiet but under STUCK_HINT_MS', current: state('replying'), event: { type: 'transcript_watch', changed: false, quietMs: STUCK_HINT_MS - 1, paneActivity: 'idle' } },
  { name: 'replying: quiet long enough but the pane is busy', current: state('replying'), event: { type: 'transcript_watch', changed: false, quietMs: STUCK_HINT_MS, paneActivity: 'busy' } },
  { name: 'replying: quiet long enough but another message is shown', current: state('replying', { lastError: 'other' }), event: { type: 'transcript_watch', changed: false, quietMs: STUCK_HINT_MS, paneActivity: 'idle' } },
  { name: 'replying: hint already shown and still quiet', current: state('replying', { stuck: true }), event: { type: 'transcript_watch', changed: false, quietMs: STUCK_HINT_MS * 2, paneActivity: 'idle' } },
  { name: 'replying: transcript changed with no hint shown', current: state('replying'), event: { type: 'transcript_watch', changed: true, quietMs: 0, paneActivity: 'idle' } },
  { name: 'replying: transcript changed under another message', current: state('replying', { lastError: 'other' }), event: { type: 'transcript_watch', changed: true, quietMs: 0, paneActivity: 'idle' } },
  { name: 'idle: transcript watch', current: state('idle'), event: { type: 'transcript_watch', changed: false, quietMs: STUCK_HINT_MS, paneActivity: 'idle' } },
  { name: 'awaiting approval: transcript watch', current: state('awaiting_approval', { stuck: true }), event: { type: 'transcript_watch', changed: true, quietMs: 0, paneActivity: 'idle' } },
  { name: 'idle: pane observed', current: state('idle'), event: { type: 'pane_observed', activity: 'busy' } },
  { name: 'awaiting approval: pane observed', current: state('awaiting_approval'), event: { type: 'pane_observed', activity: 'busy' } },
  { name: 'replying: pane unsampled', current: state('replying', { paneActivity: 'busy' }), event: { type: 'pane_unsampled' } },
  { name: 'replying: interrupted reply', current: state('replying'), event: { type: 'interrupted_reply', changes: NEW } },
  { name: 'awaiting approval: interrupted reply', current: state('awaiting_approval'), event: { type: 'interrupted_reply', changes: NEW } },
  { name: 'idle: interrupted reply with nothing to import', current: state('idle'), event: { type: 'interrupted_reply', changes: NONE } },
];

describe('nextTurn: combinations not in the table', () => {
  it.each(NO_TRANSITION)('$name → no transition, no effects', ({ current, event }) => {
    expect(nextTurn(current, event)).toEqual({ phase: current.phase, effects: [] });
  });
});

describe('legacy status mapping', () => {
  it.each([
    ['ready', 'idle'], ['waiting', 'replying'], ['needs_interaction', 'awaiting_approval'],
    ['idle', null], ['launching', null], ['dead', null],
  ] as [LegacySessionStatus, TurnPhase | null][])('%s ↔ %s', (status, phase) => {
    expect(turnPhaseOf(status)).toBe(phase);
    if (phase) expect(statusForPhase(phase)).toBe(status);
  });

  it('turnStateOf reads the fields nextTurn needs', () => {
    expect(turnStateOf({ status: 'ready', turnPhase: 'awaiting_approval', pendingInteraction: PROMPT, lastError: 'x', stuckSince: 'T', paneActivity: undefined }))
      .toEqual({ phase: 'awaiting_approval', pendingToolUseId: 't1', lastError: 'x', stuck: true, paneActivity: 'unknown' });
  });
});
