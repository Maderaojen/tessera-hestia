// The processor contract v1: what a
// caller hands a processor — a CLI run here, a person pasting an answer
// back, or a Harness over HTTP — and what it gets back. A processor only
// proposes; checking, merging and scheduling stay with the caller.
// This file imports nothing, so another implementation can copy it as it is
// (eslint/module-boundaries.js).

export const PROCESSOR_CONTRACT_VERSION = 1;

// v1 keeps recap's names (contract/recap.ts RECAP_ERROR_CODES) word for
// word, so recap maps onto it one to one and its files' lastError stays.
export const PROCESSOR_FAILURE_CODES = [
  'invalid_output', 'run_failed', 'run_timeout', 'account_limited', 'model_rejected', 'profile_unavailable', 'runner_unavailable',
] as const;
export type ProcessorFailureCode = (typeof PROCESSOR_FAILURE_CODES)[number];

// A JSON Schema in the strict form both CLIs accept (recap/schema.ts).
export type JsonSchemaObject = { readonly [key: string]: unknown };

/** A piece of the input; a proposal points back at it through sourceRefs. */
export type SourceFragment = { id: string; at: string | null; source: { system: string; ref: string }; text: string };

export type ProcessorRequest = {
  contractVersion: typeof PROCESSOR_CONTRACT_VERSION;
  jobId: string;
  // What is asked and the version of the answer's shape:
  // e.g. 'conversation-recap'/1.
  task: { kind: string; outputVersion: number };
  // The whole instruction with its data; what a CLI or a person is given.
  prompt: string;
  outputSchema: JsonSchemaObject;
  // The data on its own, for a processor that writes its own prompt (a
  // Harness). A CLI or a person doesn't read it.
  input?: { fragments: SourceFragment[]; existing: unknown[] };
  timeoutMs?: number;
};

export type ProcessorOutcome<T = unknown> =
  | { status: 'done'; output: T }
  // `until`: for account_limited, when the limit resets, if known.
  | { status: 'failed'; code: ProcessorFailureCode; until?: string | null; params?: Record<string, string> }
  // Waiting for a person (manual) or a remote job (Harness); the caller
  // keeps the job and asks again. A CLI never answers this.
  | { status: 'pending'; jobId: string; waitingFor: 'human' | 'remote'; checkAfter: string | null };

export type ProcessorAvailability =
  | { available: false }
  // `limited`: the account behind it is over its usage limit (`until` it resets, when known).
  | { available: true; label: string; limited: null | { until: string | null } };

// The proposal v1, for the tasks that propose items.
// Recap's own output keeps its shape for now.
export type ProposalItemV1 = { id: string | null; title: string; status: string; category: string | null; sourceRefs: string[]; mergedFrom: string[] };
export type ProposalV1 = { items: ProposalItemV1[] };

// The running side: what the caller holds and calls. Not on the wire; here
// so every processor and every caller share one definition.

export type ProcessorParse<T> = (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string };

export type ProcessorRunOptions<T> = {
  // For a processor in this process only: the answer is checked as soon as
  // it arrives, so a misfit is logged with the run that gave it. A remote
  // or manual answer is checked by the caller with the same function
  // once it comes back.
  parse?: ProcessorParse<T>;
};

export type Processor = {
  readonly kind: 'cli' | 'manual' | 'remote';
  availability(): Promise<ProcessorAvailability>;
  run<T>(request: ProcessorRequest, options?: ProcessorRunOptions<T>): Promise<ProcessorOutcome<T>>;
};
