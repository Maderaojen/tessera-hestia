import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchProfileSnapshot } from '../../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const { SECRET_ENV_NAMES } = await import('../../src/child-env.js');
const {
  CODEX_DISABLED_FEATURES, classifyClaudeRun, classifyCodexRun, claudeRecapArgs, codexDiagnostics, codexRecapArgs, runRecapBatch,
} = await import('../../src/recap/runner.js');
const { RECAP_OUTPUT_JSON_SCHEMA } = await import('../../src/recap/schema.js');

const FIXTURES = path.join(import.meta.dirname, '../fixtures/recap');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf-8');
const SCHEMA = JSON.stringify(RECAP_OUTPUT_JSON_SCHEMA);

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; input: Promise<string> };
type Behavior = (child: FakeChild, argv: string[]) => void | Promise<void>;

let dir: string;
let runnerDir: string;
let spawned: { command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown } }[];
let behavior: Behavior;
let kills: [number, string][];

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as FakeChild;
  child.input = new Promise((resolve) => {
    let text = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => { text += chunk; });
    child.stdin.on('end', () => resolve(text));
  });
  return child;
}

// The CLI finishing: what it printed, then its exit.
function exits(code: number, output: { stdout?: string; stderr?: string } = {}): Behavior {
  return async (child) => {
    await child.input;
    child.stdout.end(output.stdout ?? '');
    child.stderr.end(output.stderr ?? '');
    setImmediate(() => child.emit('close', code, null));
  };
}

const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]!;

const codexNative: LaunchProfileSnapshot = {
  id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home: '/home/u/.codex',
  conversationRoot: '/home/u/.codex/sessions', args: ['--yolo'], delegate: { kind: 'native', executable: '/usr/bin/codex' },
};
const codexJanus: LaunchProfileSnapshot = {
  id: 'janus:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'janus', profileName: 'codex-personal',
  home: '/home/u/.codex-personal', conversationRoot: '/home/u/.codex-personal/sessions', delegate: { kind: 'janus', executable: '/home/u/.local/bin/janus' },
};
const claudeNative: LaunchProfileSnapshot = {
  id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', home: '/home/u/.claude',
  conversationRoot: '/home/u/.claude/projects', args: [], delegate: { kind: 'native', executable: 'claude' },
};
const claudeJanus: LaunchProfileSnapshot = {
  id: 'janus:claude', provider: 'claude', runtimeId: 'claude-code', source: 'janus', profileName: 'claude-personal',
  home: '/home/u/.claude-personal', conversationRoot: '/home/u/.claude-personal/projects', delegate: { kind: 'janus', executable: '/home/u/.local/bin/janus' },
};
const PROMPT = '你是整理對話重點的工具。\n<<<對話內容>>>\n[]\n<<<對話內容結束>>>\n';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'recap-runner-'));
  runnerDir = path.join(dir, 'recap-runner');
  spawned = [];
  kills = [];
  behavior = exits(0);
  spawnMock.mockReset();
  spawnMock.mockImplementation((command: string, args: string[], options: (typeof spawned)[number]['options']) => {
    spawned.push({ command, args, options });
    const child = fakeChild();
    void behavior(child, [command, ...args]);
    return child;
  });
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
    kills.push([pid, signal]);
    return true;
  }) as typeof process.kill);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const name of SECRET_ENV_NAMES) vi.stubEnv(name, `secret-${name}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('the Codex command', () => {
  it('is the validated one, every flag', () => {
    expect(codexRecapArgs({ model: 'gpt-6-luna', effort: 'low', runnerDir: '/r', schemaFile: '/io/s.json', outputFile: '/io/o.json' })).toEqual([
      'exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low', '-c', 'web_search="disabled"', '-c', 'agents.enabled=false',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins', '--disable', 'image_generation',
      '--disable', 'multi_agent', '--disable', 'goals', '--disable', 'hooks', '--disable', 'browser_use', '--disable', 'browser_use_external',
      '--disable', 'computer_use', '--disable', 'view_image', '--disable', 'sleep_tool', '--disable', 'code_mode_host', '--disable', 'tool_suggest',
      '--disable', 'skill_search', '--disable', 'in_app_browser', '--disable', 'remote_plugin', '--disable', 'shell_snapshot',
      '--disable', 'realtime_conversation', '--disable', 'skill_mcp_dependency_install', '--disable', 'workspace_dependencies',
      '--disable', 'tool_call_mcp_elicitation', '--disable', 'auth_elicitation',
      '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check',
      '-C', '/r', '--output-schema', '/io/s.json', '-o', '/io/o.json', '-',
    ]);
    expect(CODEX_DISABLED_FEATURES).toHaveLength(24);
  });

  it('leaves the effort to the CLI for a model without one', () => {
    expect(codexRecapArgs({ model: 'm', effort: null, runnerDir: '/r', schemaFile: '/s', outputFile: '/o' }).join(' ')).not.toContain('model_reasoning_effort');
  });
});

describe('the Claude command', () => {
  it('is the validated one, every flag', () => {
    expect(claudeRecapArgs({ model: 'haiku', schema: SCHEMA })).toEqual([
      '-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--safe-mode', '--strict-mcp-config',
      '--output-format', 'json', '--json-schema', SCHEMA,
    ]);
  });
});

describe('runRecapBatch', () => {
  it('runs Codex on a native account: CODEX_HOME, the empty runner folder, the prompt on stdin', async () => {
    let input = '';
    behavior = async (child, argv) => {
      input = await child.input;
      await writeFile(after(argv, '-o'), fixture('codex.output.0.160.0.json'));
      child.stdout.end();
      child.stderr.end(fixture('codex.ok.0.160.0.stderr'));
      setImmediate(() => child.emit('close', 0, null));
    };
    const result = await runRecapBatch({ profile: codexNative, model: 'gpt-6-luna', effort: 'low', prompt: PROMPT }, { runnerDir });
    expect(result).toMatchObject({ ok: true, output: { items: [{ title: '將登入頁改為深色主題' }, {}, { status: 'planned' }] } });

    const [call] = spawned;
    expect(call!.command).toBe('/usr/bin/codex');
    const argv = call!.args;
    expect(argv).toEqual(codexRecapArgs({ model: 'gpt-6-luna', effort: 'low', runnerDir, schemaFile: after(argv, '--output-schema'), outputFile: after(argv, '-o') }));
    // The profile's own launch args are the interactive CLI's, not these.
    expect(argv).not.toContain('--yolo');
    expect(argv.join('\n')).not.toContain('對話內容');
    expect(input).toBe(PROMPT);
    expect(call!.options).toMatchObject({ cwd: runnerDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(call!.options.env.CODEX_HOME).toBe('/home/u/.codex');
    for (const name of SECRET_ENV_NAMES) expect(call!.options.env).not.toHaveProperty(name);
    // The schema and the answer are written outside the runner folder, and cleaned up.
    expect(path.dirname(after(argv, '-o')).startsWith(runnerDir)).toBe(false);
    expect(existsSync(path.dirname(after(argv, '-o')))).toBe(false);
    expect(await readdir(runnerDir)).toEqual([]);
    expect(kills).toEqual([[-4242, 'SIGTERM']]);
  });

  it('the schema file Codex is given is the strict schema', async () => {
    let schema = '';
    behavior = async (child, argv) => {
      schema = readFileSync(after(argv, '--output-schema'), 'utf-8');
      await exits(1)(child, argv);
    };
    await runRecapBatch({ profile: codexNative, model: 'gpt-6-luna', effort: 'low', prompt: PROMPT }, { runnerDir });
    expect(JSON.parse(schema)).toEqual(RECAP_OUTPUT_JSON_SCHEMA);
  });

  it('runs Codex on a Janus account through janus run, leaving its home to Janus', async () => {
    behavior = exits(1, { stderr: fixture('codex.model-not-supported.0.160.0.stderr') });
    const result = await runRecapBatch({ profile: codexJanus, model: 'gpt-no-such-model', effort: 'low', prompt: PROMPT }, { runnerDir });
    expect(result).toEqual({ ok: false, code: 'model_rejected' });
    const [call] = spawned;
    expect([call!.command, ...call!.args.slice(0, 5)]).toEqual(['/home/u/.local/bin/janus', 'run', 'codex-personal', 'exec', '-m', 'gpt-no-such-model']);
    expect(call!.options.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });

  it('runs Claude, with the schema inline and no CLAUDE_CONFIG_DIR for the native account', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/somewhere/else');
    let input = '';
    behavior = async (child, argv) => {
      input = await child.input;
      await exits(0, { stdout: fixture('claude.result.2.1.289.json') })(child, argv);
    };
    const result = await runRecapBatch({ profile: claudeNative, model: 'haiku', effort: null, prompt: PROMPT }, { runnerDir });
    expect(result).toMatchObject({ ok: true, output: { items: [{ title: '登入頁面改為深色主題' }, {}, {}] } });
    const [call] = spawned;
    expect([call!.command, ...call!.args]).toEqual(['claude', ...claudeRecapArgs({ model: 'haiku', schema: SCHEMA })]);
    expect(input).toBe(PROMPT);
    expect(call!.options.cwd).toBe(runnerDir);
    expect(call!.options.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    for (const name of SECRET_ENV_NAMES) expect(call!.options.env).not.toHaveProperty(name);
  });

  it('runs Claude on a Janus account through janus run', async () => {
    behavior = exits(1, { stdout: fixture('claude.unrecognized-model.2.1.289.json'), stderr: fixture('claude.unrecognized-model.2.1.289.stderr') });
    const result = await runRecapBatch({ profile: claudeJanus, model: 'no-such-model', effort: null, prompt: PROMPT }, { runnerDir });
    expect(result).toEqual({ ok: false, code: 'model_rejected' });
    expect([spawned[0]!.command, ...spawned[0]!.args.slice(0, 3)]).toEqual(['/home/u/.local/bin/janus', 'run', 'claude-personal', '-p']);
  });

  it('empties the runner folder before each run', async () => {
    await mkdir(path.join(runnerDir, 'left', 'behind'), { recursive: true });
    await writeFile(path.join(runnerDir, 'canary.txt'), 'x');
    let seen: string[] = ['not looked'];
    behavior = async (child, argv) => {
      seen = await readdir(runnerDir);
      await exits(0, { stdout: fixture('claude.result.2.1.289.json') })(child, argv);
    };
    await runRecapBatch({ profile: claudeNative, model: 'haiku', effort: null, prompt: PROMPT }, { runnerDir });
    expect(seen).toEqual([]);
  });

  it('kills the whole process group when it takes too long', async () => {
    behavior = (child) => {
      // Ends only once killed.
      vi.mocked(process.kill).mockImplementation(((pid: number, signal: string) => {
        kills.push([pid, signal]);
        setImmediate(() => child.emit('close', null, signal));
        return true;
      }) as typeof process.kill);
    };
    const result = await runRecapBatch({ profile: claudeNative, model: 'haiku', effort: null, prompt: PROMPT }, { runnerDir, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, code: 'run_timeout' });
    expect(kills[0]).toEqual([-4242, 'SIGTERM']);
  });

  it('a CLI that can\'t be started is runner_unavailable', async () => {
    behavior = (child) => {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    };
    expect(await runRecapBatch({ profile: claudeNative, model: 'haiku', effort: null, prompt: PROMPT }, { runnerDir })).toEqual({ ok: false, code: 'runner_unavailable' });
  });

  it.each([
    ['Agy', { ...claudeNative, id: 'native:agy', provider: 'gemini', runtimeId: 'agy' } as LaunchProfileSnapshot],
    ['Gemini CLI', { ...claudeNative, id: 'native:gemini', provider: 'gemini', runtimeId: 'gemini-cli' } as LaunchProfileSnapshot],
    ['a profile without a runtime', { ...claudeNative, runtimeId: undefined }],
  ])('never runs %s', async (_name, profile) => {
    expect(await runRecapBatch({ profile, model: 'x', effort: null, prompt: PROMPT }, { runnerDir })).toEqual({ ok: false, code: 'runner_unavailable' });
    expect(spawned).toEqual([]);
  });
});

describe('reading a Codex run', () => {
  it.each([
    ['the answer, with its trailing space', { code: 0, stderr: fixture('codex.ok.0.160.0.stderr'), output: fixture('codex.output.0.160.0.json') }, 'ok'],
    ['an answer off the schema', { code: 0, stderr: '', output: '{"items":[{"id":null}]}' }, 'invalid_output'],
    ['an answer that isn\'t JSON', { code: 0, stderr: '', output: 'Sure! Here is the list:' }, 'invalid_output'],
    ['a clean exit without the -o file', { code: 0, stderr: '', output: null }, 'run_failed'],
    ['a model the account can\'t use', { code: 1, stderr: fixture('codex.model-not-supported.0.160.0.stderr'), output: null }, 'model_rejected'],
    ['a schema Codex refuses', { code: 1, stderr: fixture('codex.invalid-schema.0.160.0.stderr'), output: null }, 'run_failed'],
    ['a feature name it doesn\'t know', { code: 1, stderr: 'Error: Unknown feature flag: shell_tool', output: null }, 'run_failed'],
    ['the usage limit', { code: 1, stderr: 'ERROR: {"codex_error_info":"usage_limit_exceeded"}', output: null }, 'account_limited'],
  ])('%s', (_name, run, expected) => {
    const result = classifyCodexRun(run);
    expect(result.ok ? 'ok' : result.code).toBe(expected);
  });

  it('the code-mode notice on every start is not a failure', () => {
    const stderr = 'warning: Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed\n';
    expect(classifyCodexRun({ code: 0, stderr, output: fixture('codex.output.0.160.0.json') }).ok).toBe(true);
  });
});

describe('reading a Claude run', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  it.each([
    ['structured_output', { code: 0, stdout: fixture('claude.result.2.1.289.json'), stderr: '' }, 'ok'],
    ['an unknown model: is_error with subtype success', { code: 1, stdout: fixture('claude.unrecognized-model.2.1.289.json'), stderr: fixture('claude.unrecognized-model.2.1.289.stderr') }, 'model_rejected'],
    ['an unknown model, stdout alone', { code: 1, stdout: fixture('claude.unrecognized-model.2.1.289.json'), stderr: '' }, 'model_rejected'],
    ['an answer to its own idea of the schema', { code: 0, stdout: fixture('claude.loose-schema.2.1.289.json'), stderr: '' }, 'invalid_output'],
    ['no JSON at all', { code: 1, stdout: '', stderr: 'boom' }, 'run_failed'],
    ['is_error on a clean exit', { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 500, result: 'API Error' }), stderr: '' }, 'run_failed'],
    ['a rate limit', { code: 1, stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'x' }), stderr: '' }, 'account_limited'],
  ])('%s', (_name, run, expected) => {
    const result = classifyClaudeRun(run, now);
    expect(result.ok ? 'ok' : result.code).toBe(expected);
  });

  it('reads the reset time of a limit it names', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 11:30pm (Asia/Taipei)" });
    expect(classifyClaudeRun({ code: 1, stdout, stderr: '' }, now)).toEqual({ ok: false, code: 'account_limited', until: '2026-10-05T15:30:00.000Z' });
  });
});

// The conversation never goes to the server log: not from Codex's echo of
// the prompt, Claude's result text, or an answer that doesn't fit.
describe('what a failed run logs', () => {
  const SECRET = '機密對話內容-7f3a';
  const prompt = `你是整理對話重點的工具。\n<<<對話內容>>>\n[{"index":0,"user":"${SECRET}","followUps":[],"assistant":"${SECRET}"}]\n<<<對話內容結束>>>\n`;
  // Codex's stderr as 0.160.0 writes it: the header, the prompt after `user`, then the error.
  const codexStderr = (error: string) => `${fixture('codex.ok.0.160.0.stderr').split('\nuser\n')[0]}\nuser\n${prompt}\nwarning: Codex's Linux sandbox uses bubblewrap\n${error}`;

  const logged = () => [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls].map((call) => call.map(String).join(' ')).join('\n');

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each([
    ['a refused model', fixture('codex.model-not-supported.0.160.0.stderr').split('\n').filter((line) => /^(ERROR|warning):/.test(line)).join('\n'), 'not supported when using Codex'],
    ['a refused schema', fixture('codex.invalid-schema.0.160.0.stderr').slice(fixture('codex.invalid-schema.0.160.0.stderr').indexOf('ERROR:')), 'invalid_json_schema'],
    ['an unknown error', 'boom', null],
  ])('Codex, %s: its diagnostics, not the echoed prompt', async (_name, error, expected) => {
    behavior = exits(1, { stdout: `${SECRET}\n`, stderr: codexStderr(error) });
    const result = await runRecapBatch({ profile: codexNative, model: 'gpt-6-luna', effort: 'low', prompt }, { runnerDir });
    expect(result.ok).toBe(false);
    expect(logged()).not.toContain(SECRET);
    expect(logged()).not.toContain('對話內容');
    if (expected) expect(logged()).toContain(expected);
  });

  it('Codex diagnostics keep each ERROR line\'s JSON block whole, and nothing else', () => {
    const stderr = fixture('codex.invalid-schema.0.160.0.stderr');
    const kept = codexDiagnostics(stderr);
    expect(kept.match(/^ERROR: \{$/gm)).toHaveLength(2);
    expect(kept).toContain('"status": 400\n}');
    expect(kept).not.toContain('這是工具能力測試');
    expect(kept).not.toMatch(/^(model|workdir|session id):/m);
  });

  it('Codex, an answer off the schema: where it doesn\'t fit, not what it said', async () => {
    behavior = async (child, argv) => {
      await child.input;
      await writeFile(after(argv, '-o'), JSON.stringify({ items: [{ id: null, title: SECRET, status: SECRET, turns: { from: 0, to: 0 }, mergedFrom: [] }], [SECRET]: SECRET }));
      await exits(0, { stderr: codexStderr('') })(child, argv);
    };
    expect(await runRecapBatch({ profile: codexNative, model: 'gpt-6-luna', effort: 'low', prompt }, { runnerDir })).toEqual({ ok: false, code: 'invalid_output' });
    expect(logged()).toContain('items.0.status');
    expect(logged()).not.toContain(SECRET);
  });

  it('Claude: how the run ended and its stderr, not the result or the answer', async () => {
    const stdout = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 500, terminal_reason: 'api_error',
      result: `API Error while reading: ${SECRET}`, structured_output: { items: [{ title: SECRET }] },
    });
    behavior = exits(1, { stdout, stderr: 'some diagnostic\n' });
    expect(await runRecapBatch({ profile: claudeNative, model: 'haiku', effort: null, prompt }, { runnerDir })).toEqual({ ok: false, code: 'run_failed' });
    expect(logged()).toContain('"terminal_reason":"api_error"');
    expect(logged()).toContain('some diagnostic');
    expect(logged()).not.toContain(SECRET);
  });

  it('Claude, an answer off the schema', async () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: SECRET, structured_output: { [SECRET]: SECRET } });
    behavior = exits(0, { stdout });
    expect(await runRecapBatch({ profile: claudeNative, model: 'haiku', effort: null, prompt }, { runnerDir })).toEqual({ ok: false, code: 'invalid_output' });
    expect(logged()).not.toContain(SECRET);
  });
});
