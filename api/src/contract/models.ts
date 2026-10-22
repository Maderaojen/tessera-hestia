import type { RuntimeId } from './runtimes.js';

// Switching the model a running CLI uses (GET /sessions/:id/models,
// POST /sessions/:id/model), for a runtime with the `model_switch`
// capability. The switch is typed into the CLI itself, so it also becomes
// that account's default for new sessions of that CLI; already running
// ones keep theirs (verified per CLI in docs/reference/cli-version-alignment.md).

/** One model the CLI can be switched to. */
export type ModelOption = {
  // What the API passes to the CLI (e.g. `sonnet`, `gpt-6-sol`,
  // `gemini-3.7-flash-high`).
  id: string;
  label: string;
  // Reasoning efforts to choose from along with this model, in the CLI's
  // order; empty when none is chosen separately (Agy's ids carry theirs).
  efforts: string[];
  defaultEffort: string | null;
  // The CLI's own recommended model.
  isDefault: boolean;
};

/** What the app last switched a conversation to. */
export type ModelChoice = {
  model: string;
  // The name the CLI confirmed the switch with.
  label: string;
  effort: string | null;
  at: string;
};

/** GET /sessions/:id/models. */
export type ModelCatalog = {
  runtimeId: RuntimeId;
  // 'account': the CLI listed what this account can use. 'builtin': a
  // fixed list the CLI accepts by name; whether the account may use a
  // given one is only known when switching.
  source: 'account' | 'builtin';
  options: ModelOption[];
  // Null until the app has switched this conversation's model: the CLI is
  // then on whatever it started with.
  current: ModelChoice | null;
  fetchedAt: string;
};
