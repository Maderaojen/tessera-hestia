import { randomUUID } from 'node:crypto';
import { RECAP_RUNNER_DIR } from '../config.js';
import { PROCESSOR_CONTRACT_VERSION, type ProcessorParse, type ProcessorRequest } from '../contract/processor.js';
import { claudePrintArgs, codexExecArgs } from '../processors/cli/args.js';
import { checkAnswer, classifyClaudePrint, classifyCodexExec, type CliOutcome } from '../processors/cli/classify.js';
import { runCli } from '../processors/cli/processor.js';
import type { LaunchProfileSnapshot } from '../types.js';
import { isRecapRuntimeId, RECAP_RUN_TIMEOUT_MS } from './constants.js';
import type { RecapRunResult } from './ports.js';
import { parseRecapOutput, RECAP_OUTPUT_JSON_SCHEMA, type RecapOutput } from './schema.js';

// One recap batch: a request to the
// CLI processor (processors/cli), the
// first task to use it. The conversation it is given is untrusted; how
// the CLI is held to no tools, no writes and no record is the processor's.

export { CODEX_DISABLED_FEATURES } from '../processors/cli/args.js';
export { claudeDiagnostics, codexDiagnostics } from '../processors/cli/classify.js';

export const codexRecapArgs = codexExecArgs;
export const claudeRecapArgs = claudePrintArgs;

const parseRecap: ProcessorParse<RecapOutput> = (raw) => {
  const parsed = parseRecapOutput(raw);
  return parsed.ok ? { ok: true, value: parsed.output } : parsed;
};

function toRecapResult(outcome: CliOutcome<RecapOutput>): RecapRunResult {
  if (outcome.status === 'done') return { ok: true, output: outcome.output };
  return { ok: false, code: outcome.code, ...('until' in outcome ? { until: outcome.until } : {}), ...(outcome.params ? { params: outcome.params } : {}) };
}

/** A finished `codex exec` run, as a recap: see processors/cli/classify.ts. */
export function classifyCodexRun(run: { code: number | null; stderr: string; output: string | null }): RecapRunResult {
  return toRecapResult(checkAnswer(classifyCodexExec(run), parseRecap, 'recap'));
}

/** A finished `claude -p` run, as a recap: see processors/cli/classify.ts. */
export function classifyClaudeRun(run: { code: number | null; stdout: string; stderr: string }, now: Date = new Date()): RecapRunResult {
  return toRecapResult(checkAnswer(classifyClaudePrint(run, now), parseRecap, 'recap'));
}

export type RecapRunTarget = { profile: LaunchProfileSnapshot; model: string; effort: string | null; prompt: string };

/** Runs one batch on the profile's account; never throws. */
export async function runRecapBatch(
  target: RecapRunTarget,
  options: { runnerDir?: string; timeoutMs?: number; now?: () => Date } = {},
): Promise<RecapRunResult> {
  const { profile } = target;
  if (!isRecapRuntimeId(profile.runtimeId)) {
    console.warn(`[recap] ${profile.id}: runtime ${profile.runtimeId ?? 'unknown'} can't run recaps`);
    return { ok: false, code: 'runner_unavailable' };
  }
  const request: ProcessorRequest = {
    contractVersion: PROCESSOR_CONTRACT_VERSION,
    jobId: randomUUID(),
    task: { kind: 'conversation-recap', outputVersion: 1 },
    prompt: target.prompt,
    outputSchema: RECAP_OUTPUT_JSON_SCHEMA,
    timeoutMs: options.timeoutMs ?? RECAP_RUN_TIMEOUT_MS,
  };
  const outcome = await runCli(
    { profile, model: target.model, effort: target.effort },
    request,
    { runnerDir: options.runnerDir ?? RECAP_RUNNER_DIR, timeoutMs: RECAP_RUN_TIMEOUT_MS, logTag: 'recap', tmpPrefix: 'hestia-recap-', now: options.now },
    { parse: parseRecap },
  );
  return toRecapResult(outcome);
}
