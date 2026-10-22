// The runtimes a CLI processor may run on. Agy isn't one: it keeps the
// conversation and its tools can't be turned off (2026-10-05 validation,
// docs/reference/cli-version-alignment.md).
export const CLI_PROCESSOR_RUNTIME_IDS = ['codex-cli', 'claude-code'] as const;
export type CliProcessorRuntimeId = (typeof CLI_PROCESSOR_RUNTIME_IDS)[number];

export function isCliProcessorRuntimeId(value: unknown): value is CliProcessorRuntimeId {
  return typeof value === 'string' && (CLI_PROCESSOR_RUNTIME_IDS as readonly string[]).includes(value);
}
