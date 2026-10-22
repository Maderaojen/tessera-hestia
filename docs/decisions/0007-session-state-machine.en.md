# ADR 0007: Session state machine (CLI lifecycle × the phase of this turn)

- Status: Implemented
- Updated: 2026-10-15
- 中文: [0007-session-state-machine.md](0007-session-state-machine.md)

The user agreed to all four open points as proposed. All three parts are implemented: part 1 (the pure function); part 2 (splitting the data: `status` keeps only the lifecycle, a new `turnPhase`, migration on read, compatibility fields in the public API); part 3 (unifying the frontend: status lights follow `activity`, a new "possibly stuck" light, and the stop button and the resume-conversation confirmation text follow `turnPhase`).

## Context

`status` (`idle` / `launching` / `ready` / `waiting` / `needs_interaction` / `dead`) held two things at once:

- **The CLI itself**: not started yet, starting, alive, ended. Decided by launching, the `/clear` restart, resuming Claude, liveness checks and tmux reconciliation.
- **The phase of this turn**: idle, waiting for a reply, waiting for the user to confirm. Decided by sending messages and by what polling observes.

Add `pendingInteraction`, `lastError` (the stuck hint), `paneActivity` and `claudeClearPending`, each on its own, and the result was:

1. **Writes everywhere**: `status` was written directly in 20 places across `registry.ts`, `polling.ts` and `routes/messages.ts`, and none of them said which states may move to which.
2. **Every part of the screen reading something different**:
   - The status lights (Home, the chat title bar) read `status`.
   - The terminal button read the derived `activity`.
   - The stop button, the "generating" bubble and the resume-conversation confirmation text read `status`.

   For example, in `waiting` with the screen already idle, the button showed idle while the light said "replying", and the stop button was still there.
3. **One field, several uses**: `lastUserMessageAt` served delivery confirmation, the stuck timer and spotting new terminal messages, and had already caused a bug (pressing a control key led to a misjudgment).

## Decision

### 1. Split into two dimensions

**The CLI lifecycle `runtime`** (keeping the `status` field, but only its lifecycle values):

| Value | Meaning | Changed by |
|---|---|---|
| `idle` | tmux exists, no CLI started yet | Creating a session, after the CLI exits |
| `launching` | Starting / restarting for `/clear` / resuming | The launch, clear and resume flows |
| `ready` | The CLI is alive | A successful launch |
| `dead` | tmux has ended | tmux reconciliation, a failed resume |

**The phase of this turn `turn.phase`** (a new field, implemented as `ManagedSession.turnPhase`; meaningful only when `runtime === 'ready'`, every other lifecycle value counting as "no turn"; reset to `idle` every time `ready` is entered):

| Value | Meaning |
|---|---|
| `idle` | No turn in progress; a message can be sent |
| `replying` | Sent (or terminal input detected), waiting for the CLI to finish replying |
| `awaiting_approval` | The CLI is stopped at a permission prompt, waiting for the user to confirm |

"Possibly stuck" is not a phase but a hint flag during `replying`; "the CLI is busy / the screen is idle" is an observation (`paneActivity`), not a phase.

### 2. Phase transitions in one pure function

Each poll first gathers observations, then hands them to a pure function that decides the next phase and what to do:

```
nextTurn(current, observation) → { phase, effects[] }
```

- Observations: whether there is a new user message from the terminal, whether the transcript is quiet, whether this turn is finished (`isTurnComplete`), whether there is a permission prompt (transcript plus screen confirmation), whether the screen is busy / idle, how long it has been quiet, whether there are changes to import.
- Effects: import turns, set / clear the pending tool, set / clear the stuck hint, update `paneActivity`.
- Routes (send, stop, `/resume`) go through the same function too, as events, and no longer write `status` themselves.

Transition table:

| Current | Event / observation | Next | Effects |
|---|---|---|---|
| Any (see note below) | The app sends a message | `replying` | Record the send time and text |
| `idle` | A new, unfinished terminal message detected | `replying` | The same (with the transcript's time) |
| `idle` | A finished turn not yet imported | `idle` | Import |
| `idle` | The transcript ends on a turn still going that a person opened, and the transcript was written after the app ended the last turn (within 10 minutes) | `replying` | If that message was never recorded (typed in the terminal), record it like a terminal message; record an event |
| `idle` | The transcript ends on a turn still going (one the CLI opened itself), with something new | `idle` | Import what there is; it grows in place |
| `replying` | A permission prompt (confirmed by transcript and screen) | `awaiting_approval` | Set the pending tool |
| `awaiting_approval` | The prompt disappears | `replying` | Clear the pending tool |
| `replying` | Quiet + finished (or can't tell) + the latest send is in the turns | `idle` | Import, clear hints |
| `replying` | Quiet + unfinished + screen idle for 5 seconds straight + transcript quiet for 15 seconds | `idle` | Import what there is, clear hints; record an event |
| `replying` | Quiet + unfinished + part of the reply written | `replying` | Import what there is so far; it grows in place |
| `replying` | Something to import, but the latest send isn't in the turns yet (e.g. the turn before is still being written) | `replying` | Import it |
| `replying` | Quiet ≥ 30 seconds and the screen not busy | `replying` | Set the stuck hint |
| `replying` | The transcript changes again | `replying` | Clear the stuck hint |
| `replying` / `awaiting_approval` | Stop pressed | `idle` | Send Esc, import the interrupted turn in the background; record an event (whether the interrupt marker was seen) |
| `replying` / `awaiting_approval` | `/resume` (manual unlock) | `idle` | Clear the pending tool, clear hints |
| Any | `runtime` leaves `ready` | `idle` | Clear the pending tool, hints and observations |

Any combination not in the table makes no transition, and tests check each one.

Note (2026-10-15): whether a turn is going is decided by the main transcript; the screen readings and the app's own actions (a stop) are only hints. The stop's Esc may not interrupt the CLI (another screen the CLI has open can take it), and the screen can be misread as idle while it shows something else; the app has then ended the turn, but once the transcript shows that turn still being written, the two `idle` rows above take it back up.

Note: "the app sends a message" is accepted in every phase, not only `idle`. The input box is deliberately not locked by our own readiness judgment (see `routes/messages.ts`), because cases we can't detect (for example a slash command that writes nothing to the transcript) would leave it unusable for good. Part 1 is implemented this way.

### 3. One entry point for writes

`registry.applyTurnTransition(sessionId, conversationId, result)`: applies the function's result, writes once, pushes SSE once. Nothing else writes `turn.phase`, `pendingInteraction` or the stuck hint directly. Writes of `runtime` stay in the existing launch / clear / resume / reconciliation functions, but the allowed transitions are checked in one place.

Implementation (part 2): the write entry point is `applyTurnEffects` in `sync/turnEffects.ts` (`turnPhase` changes only through `enter_phase`); every write of `status` goes through `lifecycleTransition` in `registry.ts`, checked against `LIFECYCLE_TRANSITIONS`, and an unexpected transition only logs a warning and is applied anyway. `runtime_left_ready` is sent by `applyRuntimeLeftReady` when the CLI exits, when reconciliation finds tmux gone, and when `/clear` or a conversation switch begins.

### 4. Separate the uses of `lastUserMessageAt`

| Use | Now uses |
|---|---|
| Delivery confirmation; whether a terminal message is newer than the last send | `lastUserMessageAt` / `lastUserMessageText` as before (see note below) |
| The stuck timer | The in-memory times of the transcript's last change and the last key press (already in `sync/tracker.ts`) |

Note (part 2): since pressing a control key through `/respond` no longer writes `lastUserMessageAt` (it records `lastControlKeyAt` in `sync/tracker.ts` instead), these two fields are written only when the app sends or a terminal message is detected (the `record_sent` effect). They already are "the send time / the sent text", so they weren't renamed, and no separate `turn.sentAt` / `turn.sentText` was added.

### 5. The frontend reads one state

The backend keeps producing a single `activity` (`ended` / `starting` / `not_started` / `awaiting_approval` / `stalled` / `busy` / `idle`), and every indicator in the frontend reads it:

- Status lights (Home, the chat title bar, the light legend): `SESSION_STATUS_META` is keyed by `activity`, with a new "possibly stuck" light.
- The terminal button: unchanged (it already reads `activity`).
- The stop button, the "generating" bubble, the resume-conversation confirmation text: read `activity` (or `turn.phase`), no longer `status`.

### 6. Compatibility and migration

- **Existing data**: when the registry is read, `status: 'waiting'` becomes `status: 'ready'` + `turnPhase: 'replying'`, `needs_interaction` becomes `ready` + `awaiting_approval`, and records without `turnPhase` get `idle`; the `previousStatus` inside launch / clear / switch attempts in progress is split the same way into `previousStatus` + `previousTurnPhase`. It can run repeatedly, and needs no manual migration. (`lastUserMessageAt` doesn't move; see the note in §4.)
- **Old frontends** (PWA caches may still run an old version): the public API keeps a derived legacy `status` (computed from `runtime` + `turn.phase` back into the original six values) for at least one version, so old frontends don't break.

## Implemented in three parts (each can be merged and deployed on its own)

1. **The pure function and observations**: add `nextTurn` and transition-table tests; `polling.ts` becomes "gather observations → call `nextTurn` → apply the result", still writing the existing fields. Behavior is unchanged and every existing test passes as is.
2. **Splitting the data**: `turn.phase` / `turn.sentAt`, the single write entry point, migration on read, compatibility fields in the public API.
3. **Unifying the frontend**: lights, the stop button and bubbles read `activity`.

## Tests

- Table tests of `nextTurn` against the transition table: every "current × event" combination, including those not in the table, which should make no transition.
- The existing polling / route tests don't change at all in part 1, as proof that behavior is unchanged.
- Migration: how fields map after reading a registry in the old format.
- Compatibility: the public API's legacy `status`, computed back from the new fields, matches the old behavior.
- Frontend: for each `activity`, the light, buttons, stop button and bubble text agree.

## Confirmed (2026-09-24)

1. `status` stays as the CLI lifecycle field (`idle` / `launching` / `ready` / `dead`), not renamed.
2. "Possibly stuck" is a hint flag during `replying`, not a phase.
3. Status lights read `activity`, with a new "possibly stuck" light.
4. The public API keeps the derived legacy `status` for one version before removing it.
