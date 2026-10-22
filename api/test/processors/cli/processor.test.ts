import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessorRequest } from '../../../src/contract/processor.js';
import type { LaunchProfileSnapshot } from '../../../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const { runCli } = await import('../../../src/processors/cli/processor.js');

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

const claude: LaunchProfileSnapshot = {
  id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', home: '/home/u/.claude',
  conversationRoot: '/home/u/.claude/projects', args: [], delegate: { kind: 'native', executable: 'claude' },
};
const codex: LaunchProfileSnapshot = {
  id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/home/u/.codex',
  conversationRoot: '/home/u/.codex/sessions', args: [], delegate: { kind: 'native', executable: '/usr/bin/codex' },
};
// Not recap's: the processor passes any task's schema through as it is.
const SCHEMA = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } };
const request = (overrides: Partial<ProcessorRequest> = {}): ProcessorRequest => ({
  contractVersion: 1, jobId: 'job-1', task: { kind: 'example-task', outputVersion: 1 }, prompt: 'split these notes', outputSchema: SCHEMA, ...overrides,
});

let dir: string;
let stdout: string;
let argvs: string[][];
let codexSchema: string | null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cli-processor-'));
  argvs = [];
  codexSchema = null;
  stdout = JSON.stringify({ type: 'result', is_error: false, structured_output: { items: ['a', 'b'] } });
  spawnMock.mockReset();
  spawnMock.mockImplementation((command: string, args: string[]) => {
    argvs.push([command, ...args]);
    const child = Object.assign(new EventEmitter(), { pid: 77, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as FakeChild;
    child.stdin.resume();
    child.stdin.on('end', () => {
      if (args[0] === 'exec') codexSchema = readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf-8');
      child.stdout.end(stdout);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  });
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const config = () => ({ runnerDir: path.join(dir, 'runner'), timeoutMs: 1_000, logTag: 'example', tmpPrefix: 'hestia-example-' });

describe('CLI processor', () => {
  it('gives the CLI the task\'s own schema and returns its answer', async () => {
    const outcome = await runCli({ profile: claude, model: 'haiku', effort: null }, request(), config());
    expect(outcome).toEqual({ status: 'done', output: { items: ['a', 'b'] } });
    const argv = argvs[0]!;
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]!)).toEqual(SCHEMA);
  });

  it('writes the schema to the file Codex is given', async () => {
    await runCli({ profile: codex, model: 'gpt-6-luna', effort: 'low' }, request(), config());
    expect(JSON.parse(codexSchema!)).toEqual(SCHEMA);
  });

  it('checks the answer with the task\'s parse: a misfit is invalid_output, logged under its own tag', async () => {
    const parse = (raw: unknown) => (Array.isArray((raw as { items?: unknown }).items) && (raw as { items: unknown[] }).items.length > 5
      ? { ok: true as const, value: raw }
      : { ok: false as const, reason: 'items: too_small' });
    const outcome = await runCli({ profile: claude, model: 'haiku', effort: null }, request(), config(), { parse });
    expect(outcome).toEqual({ status: 'failed', code: 'invalid_output' });
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toBe('[example] the answer doesn\'t fit the schema: items: too_small');
  });

  it('never answers pending, even when the run fails', async () => {
    stdout = 'not json';
    const outcome = await runCli({ profile: claude, model: 'haiku', effort: null }, request(), config());
    expect(outcome).toEqual({ status: 'failed', code: 'run_failed' });
  });

  it('a runtime that can\'t be a CLI processor is runner_unavailable, with nothing run', async () => {
    const outcome = await runCli({ profile: { ...claude, runtimeId: 'agy' }, model: 'x', effort: null }, request(), config());
    expect(outcome).toEqual({ status: 'failed', code: 'runner_unavailable' });
    expect(argvs).toEqual([]);
  });
});
