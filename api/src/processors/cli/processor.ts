import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from '../../child-env.js';
import type { Processor, ProcessorRequest, ProcessorRunOptions } from '../../contract/processor.js';
import { getRuntimeDriver } from '../../runtimes/index.js';
import { profileCommand } from '../../runtimes/model-switch.js';
import type { LaunchProfileSnapshot } from '../../types.js';
import { claudePrintArgs, codexExecArgs } from './args.js';
import { checkAnswer, claudeDiagnostics, classifyClaudePrint, classifyCodexExec, codexDiagnostics, type CliOutcome } from './classify.js';
import { accountLimit, cliProcessorProfile } from './profiles.js';
import { isCliProcessorRuntimeId } from './runtimes.js';
import { emptyRunnerDir, run } from './spawn.js';

// The CLI processor: one request run
// once on a launch profile's account, in an empty folder of its own. What
// the CLI printed only ever goes to the server log.

export type CliRunTarget = { profile: LaunchProfileSnapshot; model: string; effort: string | null };

export type CliRunConfig = {
  // Emptied before every run; nothing should be left in it after.
  runnerDir: string;
  // Used when the request names none; past it the whole process group is killed.
  timeoutMs: number;
  // The server log's prefix, `[logTag]`.
  logTag: string;
  // Of the temporary folder Codex's schema and answer go in.
  tmpPrefix: string;
  now?: () => Date;
};

/** Runs one request on the profile's account; never throws, never pending. */
export async function runCli<T>(
  target: CliRunTarget,
  request: ProcessorRequest,
  config: CliRunConfig,
  options: ProcessorRunOptions<T> = {},
): Promise<CliOutcome<T>> {
  const { profile } = target;
  const { runnerDir, logTag } = config;
  const runtimeId = profile.runtimeId;
  if (!isCliProcessorRuntimeId(runtimeId)) {
    console.warn(`[${logTag}] ${profile.id}: runtime ${runtimeId ?? 'unknown'} can't run a CLI processor`);
    return { status: 'failed', code: 'runner_unavailable' };
  }
  let io: string | null = null;
  try {
    await emptyRunnerDir(runnerDir);
    let args: string[];
    let nativeEnv: Record<string, string> = {};
    let outputFile: string | null = null;
    if (runtimeId === 'codex-cli') {
      // The schema and the answer live outside the runner's folder, which stays empty.
      io = await mkdtemp(path.join(os.tmpdir(), config.tmpPrefix));
      const schemaFile = path.join(io, 'schema.json');
      outputFile = path.join(io, 'output.json');
      await writeFile(schemaFile, JSON.stringify(request.outputSchema));
      args = codexExecArgs({ model: target.model, effort: target.effort, runnerDir, schemaFile, outputFile });
      if (profile.home) nativeEnv = { CODEX_HOME: profile.home };
    } else {
      args = claudePrintArgs({ model: target.model, schema: JSON.stringify(request.outputSchema) });
    }
    const command = profileCommand(profile, args, nativeEnv, getRuntimeDriver(runtimeId)?.updateCheckOff?.env);
    if (!command) {
      console.warn(`[${logTag}] ${profile.id}: launch profile can't run its CLI`);
      return { status: 'failed', code: 'runner_unavailable' };
    }
    const env: NodeJS.ProcessEnv = { ...childEnv(), ...command.env };
    // A native account is the CLI with no override (claude-code.ts's nativeUnsetEnv).
    if (profile.source === 'native') for (const name of getRuntimeDriver(runtimeId)?.accountStatus?.nativeUnsetEnv ?? []) delete env[name];

    const started = Date.now();
    const exit = await run(command.argv, env, runnerDir, request.prompt, request.timeoutMs ?? config.timeoutMs);
    const label = `[${logTag}] ${profile.id} ${target.model}`;
    if (exit.error) {
      console.warn(`${label}: could not start ${command.argv[0]}: ${exit.error.code ?? exit.error.message}`);
      return { status: 'failed', code: 'runner_unavailable' };
    }
    if (exit.timedOut) {
      console.warn(`${label}: timed out after ${Date.now() - started}ms`);
      return { status: 'failed', code: 'run_timeout' };
    }
    const raw = runtimeId === 'codex-cli'
      ? classifyCodexExec({ code: exit.code, stderr: exit.stderr, output: outputFile ? await readFile(outputFile, 'utf-8').catch(() => null) : null })
      : classifyClaudePrint({ code: exit.code, stdout: exit.stdout, stderr: exit.stderr }, config.now?.() ?? new Date());
    const outcome = checkAnswer(raw, options.parse, logTag);
    if (outcome.status === 'failed') {
      const detail = runtimeId === 'codex-cli' ? `stderr: ${codexDiagnostics(exit.stderr)}` : claudeDiagnostics(exit.stdout, exit.stderr);
      console.warn(`${label}: ${outcome.code} (exit ${exit.code ?? exit.signal}, ${Date.now() - started}ms)\n${detail}`);
    }
    // Nothing should ever be written here; if something was, say so.
    const left = await readdir(runnerDir).catch(() => []);
    if (left.length) console.warn(`${label}: the run left files in ${runnerDir}: ${left.join(', ')}`);
    return outcome;
  } catch (err) {
    console.error(`[${logTag}] ${profile.id}: run failed`, err);
    return { status: 'failed', code: 'run_failed' };
  } finally {
    if (io) await rm(io, { recursive: true, force: true }).catch(() => {});
  }
}

export type CliProcessorOptions = Omit<CliRunConfig, 'now'> & {
  // The launch profile (account) it runs on, looked up on every call: it
  // may be gone or over its limit by then.
  profileId: string;
  model: string;
  effort: string | null;
};

/** The CLI processor as the contract's Processor. */
export function createCliProcessor(options: CliProcessorOptions): Processor {
  const { profileId, model, effort, ...config } = options;
  return {
    kind: 'cli',
    async availability() {
      const found = await cliProcessorProfile(profileId);
      if (!found) return { available: false };
      return { available: true, label: found.profile.label, limited: await accountLimit(found.snapshot) };
    },
    async run(request, runOptions) {
      const found = await cliProcessorProfile(profileId);
      if (!found) return { status: 'failed', code: 'profile_unavailable' };
      return runCli({ profile: found.snapshot, model, effort }, request, config, runOptions);
    },
  };
}
