import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
const profiles = vi.hoisted(() => ({ cliProcessorProfile: vi.fn(), accountLimit: vi.fn() }));
vi.mock('../../../src/processors/cli/profiles.js', () => profiles);

const { createCliProcessor } = await import('../../../src/processors/cli/processor.js');

const claude: LaunchProfileSnapshot = {
  id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', home: '/home/u/.claude',
  conversationRoot: '/home/u/.claude/projects', args: [], delegate: { kind: 'native', executable: 'claude' },
};
const request: ProcessorRequest = {
  contractVersion: 1, jobId: 'job-1', task: { kind: 'example-task', outputVersion: 1 }, prompt: 'split these notes',
  outputSchema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'create-cli-processor-'));
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 77, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.resume();
    child.stdin.on('end', () => {
      child.stdout.end(JSON.stringify({ type: 'result', is_error: false, structured_output: { items: ['a'] } }));
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  });
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  profiles.cliProcessorProfile.mockResolvedValue({ profile: { label: 'Claude (原生)' }, driver: {}, snapshot: claude });
  profiles.accountLimit.mockResolvedValue(null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const make = () => createCliProcessor({ profileId: 'native:claude', model: 'haiku', effort: null, runnerDir: path.join(dir, 'runner'), timeoutMs: 5_000, logTag: 'example', tmpPrefix: 'hestia-example-' });

describe('createCliProcessor', () => {
  it('runs the request on the profile\'s account in its own empty folder', async () => {
    await expect(make().run(request)).resolves.toEqual({ status: 'done', output: { items: ['a'] } });
    expect(profiles.cliProcessorProfile).toHaveBeenCalledWith('native:claude');
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: path.join(dir, 'runner') });
    expect(await readdir(path.join(dir, 'runner'))).toEqual([]);
  });

  it('says what account it is on and whether that account is over its limit', async () => {
    profiles.accountLimit.mockResolvedValue({ until: '2026-10-07T12:00:00.000Z' });
    await expect(make().availability()).resolves.toEqual({ available: true, label: 'Claude (原生)', limited: { until: '2026-10-07T12:00:00.000Z' } });
  });

  it('a profile that is gone is unavailable, and running on it fails without running anything', async () => {
    profiles.cliProcessorProfile.mockResolvedValue(null);
    await expect(make().availability()).resolves.toEqual({ available: false });
    await expect(make().run(request)).resolves.toEqual({ status: 'failed', code: 'profile_unavailable' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
