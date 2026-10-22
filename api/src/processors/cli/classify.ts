import { parseResetText } from '../../account-status/reset-time.js';
import type { ProcessorOutcome, ProcessorParse } from '../../contract/processor.js';

// What a finished CLI run means: the raw answer, or why there is none.
// Recognized from what Codex 0.160.0 and Claude Code 2.1.289 printed.

/** A CLI run's outcome: a processor in this process never waits. */
export type CliOutcome<T = unknown> = Exclude<ProcessorOutcome<T>, { status: 'pending' }>;

const LOG_CHARS = 2_000;

export const tail = (text: string) => (text.length > LOG_CHARS ? `…${text.slice(-LOG_CHARS)}` : text).trim();

// What of a run goes to the server log. Never the input: Codex echoes the
// whole prompt to stderr (after a `user` line), and Claude's `result` is
// the model's text, which may quote it.

const DIAGNOSTIC_LINE = /^(ERROR|Error|error|WARNING|Warning|warning):/;
const MAX_DIAGNOSTIC_LINES = 60;

/**
 * Codex's own diagnostics from its stderr: the `ERROR:` / `warning:` lines,
 * each with the JSON block an `ERROR: {` opens (0.160.0). Nothing else:
 * not the header, the echoed prompt, the answer or `tokens used`. The
 * prompt's lines never start like this (its turns are one JSON line each).
 */
export function codexDiagnostics(stderr: string): string {
  const kept: string[] = [];
  let depth = 0;
  for (const line of stderr.split('\n')) {
    if (kept.length >= MAX_DIAGNOSTIC_LINES) break;
    if (depth === 0 && !DIAGNOSTIC_LINE.test(line)) continue;
    kept.push(line);
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
    }
  }
  return tail(kept.join('\n'));
}

/** Claude's outer JSON, only the fields that say how the run ended, and its stderr. */
export function claudeDiagnostics(stdout: string, stderr: string): string {
  const outer = parseJson(stdout.trim()) as Record<string, unknown> | undefined;
  const fields = outer && typeof outer === 'object'
    ? JSON.stringify({ subtype: outer.subtype, is_error: outer.is_error, api_error_status: outer.api_error_status, terminal_reason: outer.terminal_reason })
    : `not JSON (${stdout.length} chars)`;
  return `${fields}\nstderr: ${tail(stderr)}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The raw answer checked against what the task expects: a misfit is
 * invalid_output, logged with where it doesn't fit, never what it said.
 */
export function checkAnswer<T>(outcome: CliOutcome, parse: ProcessorParse<T> | undefined, logTag: string): CliOutcome<T> {
  if (outcome.status !== 'done' || !parse) return outcome as CliOutcome<T>;
  const parsed = parse(outcome.output);
  if (parsed.ok) return { status: 'done', output: parsed.value };
  console.warn(`[${logTag}] the answer doesn't fit the schema: ${tail(parsed.reason)}`);
  return { status: 'failed', code: 'invalid_output' };
}

/**
 * A finished `codex exec` run: its exit code, stderr, and the -o file
 * (null when it wasn't written).
 */
export function classifyCodexExec(run: { code: number | null; stderr: string; output: string | null }): CliOutcome {
  if (run.code === 0) {
    if (run.output === null) return { status: 'failed', code: 'run_failed' };
    // The answer itself, with a space after it.
    const raw = parseJson(run.output.trim());
    return raw === undefined ? { status: 'failed', code: 'invalid_output' } : { status: 'done', output: raw };
  }
  if (/invalid_request_error/.test(run.stderr) && /model is not supported/i.test(run.stderr)) return { status: 'failed', code: 'model_rejected' };
  // Not seen from `codex exec` yet: the word its rollouts use (providers/codex-limit.ts).
  if (/usage_limit_exceeded|You've hit your usage limit/i.test(run.stderr)) return { status: 'failed', code: 'account_limited', until: null };
  return { status: 'failed', code: 'run_failed' };
}

/**
 * A finished `claude -p --output-format json` run. stdout is one JSON
 * object (type "result") whose structured_output is the answer; is_error
 * is what tells a failure, since subtype stays "success" on an unknown
 * model (2.1.289).
 */
export function classifyClaudePrint(run: { code: number | null; stdout: string; stderr: string }, now: Date = new Date()): CliOutcome {
  const outer = parseJson(run.stdout.trim()) as Record<string, unknown> | undefined;
  const result = outer && typeof outer === 'object' ? outer : null;
  if (run.stderr.includes('[claude-code:unrecognized_model]') || result?.api_error_status === 404) return { status: 'failed', code: 'model_rejected' };
  const text = typeof result?.result === 'string' ? result.result : '';
  // Not seen from `claude -p` yet: what its transcripts say (providers/claude-limit.ts).
  if (result?.api_error_status === 429 || /\brate_limit\b/.test(run.stderr) || (result?.is_error === true && /hit your .*limit/i.test(text))) {
    const resets = /\bresets\s+(.+?)\s*$/i.exec(text)?.[1];
    return { status: 'failed', code: 'account_limited', until: resets ? parseResetText(`Resets ${resets}`, now) : null };
  }
  if (!result || result.type !== 'result' || result.is_error === true || run.code !== 0) return { status: 'failed', code: 'run_failed' };
  return { status: 'done', output: result.structured_output };
}
