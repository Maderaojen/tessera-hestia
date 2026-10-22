// The tunable numbers of conversation recaps.
// The idle wait, the batch size and the cut lengths are first guesses, to
// be adjusted once real batches show their cost, delay and quality.

// How long a conversation must have been quiet before it is recapped, so a
// run of quick follow-ups is recapped once, after the last.
export const RECAP_IDLE_MS = 3 * 60_000;
// At most this many turns go to the model at once.
export const RECAP_BATCH_TURNS = 20;
// Each turn's user text (follow-ups included) is cut to this many
// characters, keeping the start…
export const RECAP_TURN_USER_CHARS = 2_000;
// …and its reply to this many, keeping the start and the end (where the
// conclusion usually is), half each.
export const RECAP_TURN_ASSISTANT_CHARS = 3_000;
// One CLI run; past it the whole process group is killed.
export const RECAP_RUN_TIMEOUT_MS = 180_000;
// A recap with more items than this is an invalid answer.
export const RECAP_MAX_ITEMS = 80;
// Longer titles are cut, ending in '…'.
export const RECAP_TITLE_MAX_CHARS = 40;
// How long a conversation waits after its 1st, 2nd, 3rd failure in a row;
// the last applies to every one after.
export const RECAP_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
// An account over its limit with no known reset time is looked at again
// this often (the account-status schedule's own interval).
export const RECAP_LIMIT_RECHECK_MS = 15 * 60_000;

// The runtimes a recap may run on: the CLI processor's (processors/cli/runtimes.ts).
export {
  CLI_PROCESSOR_RUNTIME_IDS as RECAP_RUNTIME_IDS, isCliProcessorRuntimeId as isRecapRuntimeId, type CliProcessorRuntimeId as RecapRuntimeId,
} from '../processors/cli/runtimes.js';

/** The wait before trying a conversation again after `failures` failures in a row (1 or more). */
export function recapBackoffMs(failures: number): number {
  return RECAP_BACKOFF_MS[Math.min(Math.max(failures, 1), RECAP_BACKOFF_MS.length) - 1]!;
}
