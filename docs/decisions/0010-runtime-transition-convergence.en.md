# ADR 0010: One confirmation rule for CLI launch transitions

- Status: Implemented
- Updated: 2026-09-24
- 中文: [0010-runtime-transition-convergence.md](0010-runtime-transition-convergence.md)

On 2026-09-24 the user agreed to finish converging the runtimes as "stage one → stage two → stage three, writing the ADR before implementing it". Prerequisite: each CLI's clear flow had already been unified. Stages one and two moved assembling the launch command (`runtimes/launch.ts`) and the CLI lifecycle and session identity (`RuntimeDriver`) into the runtime drivers; this ADR handles what was left: how to confirm a launch afterwards.

## Context

The same tmux goes through four transitions of the kind "send one CLI launch command, then confirm it came up":

| Transition | Stored field | Sent by | Confirmed by (before) | How `dead` was decided (before) |
|---|---|---|---|---|
| New launch | `launchPending` | The `POST /launch` route | The route looked once after `waitForPaneStable`; the poller looked too | Route: rolled back on seeing it once after the screen settled; poller: **rolled back on seeing it once, with no grace period and no local owner protection** |
| The app's `/clear` restart | `clearPending` (`operation: 'clear'`) | The poller | The poller | A 30-second grace period after sending + dead on 2 consecutive polls |
| Switching to an earlier Claude conversation | `clearPending` (`operation: 'conversation_switch'`) | The poller | The poller | Same as `/clear` |
| Resuming Claude in an ended tmux | `resumePending` | The `POST /recover-claude` route | The route looked once; the poller looked too | Route: rolled back on seeing it once after the screen settled; poller: 30-second grace period + a stability period |

Problems:

1. **A new launch had a real race** (proven by a test). The route persisted `launchPending` before sending the command; the poller scans every 800 ms, and if it happened to look between "pending written" and "the shell actually forks the CLI" (about 100–200 ms, including the 100 ms before `sendText` sends Enter) and saw the pane still a shell, it immediately rolled back to idle and showed "the chosen launch has exited". The CLI then started as usual, but the registry no longer knew it, leaving an orphan CLI; the route's later commit failed too, because the pending was already cleared.
2. The same judgment, "the CLI hasn't come up yet vs. it has exited", had three sets of rules; the route's one-off judgment and the poller's could run at the same time and disagree.
3. The generic functions and types used by `/clear` and switching were still called `*ClaudeClear*`, and the local owner set was named after Claude too, at odds with a runtime-neutral design.

## Decision

1. **One launch confirmation rule.** A new `sync/startup.ts`; after sending the launch command, every transition uses the same judgment:
   - `alive` → confirmed (commit).
   - `unknown` → keep waiting; no state change.
   - `dead` → failure only when "`RUNTIME_STARTUP_GRACE_MS` (30 seconds) have passed since sending" **and** "dead has been observed continuously for `RUNTIME_DEAD_STABILITY_MS` (two poll intervals)"; otherwise keep waiting.
   The constants keep the values already proven for `/clear` and resume, only renamed to be runtime-neutral.
2. **Routes only claim and dispatch; confirming is always the poller's.** `POST /launch` and `POST /recover-claude` persist the claim, send the command once, and return `202` with the current (`launching`) state; they no longer `waitForPaneStable` or reach a liveness conclusion inside the request. If sending the command fails, the claim is kept and marked uncertain, and the command is never resent (the same as `/clear`). The frontend's existing "confirming the launch" state and SSE updates take care of the screen from there.
3. **Every transition shares process-local dispatch ownership.** From writing the claim until the command has been sent, the request that started it owns the attempt; the poller doesn't judge an attempt this process owns. After a service restart the ownership is simply gone, and the poller takes over from the persisted state.
4. **The three stored fields stay; they aren't merged into one union.** `launchPending`, `resumePending` and `clearPending` differ in preconditions, in what a commit does (a new segment / reopening an old segment / recovering the same segment) and in what a rollback means, and existing migrations and the public projection each use them. What converges is the confirmation rule and the owner mechanism, not the storage format. `launchPending.providerLaunchedAt` is set just before the command is sent and serves directly as the start of the grace period: no new field, no migration.
5. **Generic clear / switch functions and types get neutral names** (for example `beginPendingClear`, `PendingClearAttempt`). Resuming Claude (`recover-claude`, `resumePending`) still supports only Claude, per its spec, and keeps the Claude names to describe the capability truthfully.

## Alternatives

- **Only add owner protection to the poller's launch loop, keeping the route's synchronous confirmation**: rejected. It would stop the current race, but there would still be two judges and two sets of rules; the route's "roll back on seeing dead once after the screen settles" misjudges slow-starting CLIs just the same.
- **Shorten the grace period (for example to 3 seconds) so failures show sooner**: not for now. 30 seconds is the value proven in production for `/clear` and resume; shortening it would bring back the risk of "slow start judged a failure → the user retries → two CLIs". Adjusting it later means changing only `sync/startup.ts`.
- **Merge the three pending fields into one `transition` union**: rejected. It needs a registry migration and public DTO changes, and only buys uniformity of form; what was actually inconsistent was the confirmation rule, which decisions 1–3 settle.

## Consequences

- Normal launches are as fast as before (committed on the poller's next poll, ≤ 800 ms); **a failed launch (for example a missing executable) takes about 30 seconds to show its error**, in exchange for never misjudging a slow start.
- On success, `POST /launch` changes from `200 + ready session` to `202 + launching session`; `POST /recover-claude` changes to `202` likewise. The frontend already handles the `starting` state, so the UI doesn't change.
- The route's "CLI did not settle before timeout" hint is removed (it was only a guess from the screen settling, not a state).
- Tests must cover: a launch just sent that looks dead within the grace period is not rolled back; after the grace period, only a stable dead rolls back; an attempt being owned is not judged by the poller; routes no longer confirm synchronously.
