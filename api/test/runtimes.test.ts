import { describe, expect, it } from 'vitest';
import { agyRuntime } from '../src/runtimes/agy.js';
import { getRuntimeDriver, getRuntimeDriverForProvider, nativeLaunchArgs } from '../src/runtimes/index.js';
import { type ConversationSegment } from '../src/types.js';
import { conversationForkBlocked } from '../src/runtimes/conversation-blocks.js';

describe('nativeLaunchArgs', () => {
  it('passes a runtime flag once even when the native profile already sets it', () => {
    const plan = getRuntimeDriver('codex-cli')!.buildLaunch('/tmp/project').argv.slice(1);
    expect(nativeLaunchArgs([], plan)).toEqual(['--no-daemon']);
    expect(nativeLaunchArgs(['--no-daemon'], plan)).toEqual(['--no-daemon']);
    expect(nativeLaunchArgs(['-m', 'gpt-5'], plan)).toEqual(['-m', 'gpt-5', '--no-daemon']);
  });

  it('never drops a plan flag that carries a value', () => {
    expect(nativeLaunchArgs(['--session-id'], ['--session-id', 'abc', '-n', 'x'])).toEqual(['--session-id', '--session-id', 'abc', '-n', 'x']);
  });
});

describe('runtime driver registry', () => {
  it('keeps four runtime entries while preserving Gemini as Agy provider', () => {
    expect(getRuntimeDriver('claude-code')?.provider).toBe('claude');
    expect(getRuntimeDriver('codex-cli')?.provider).toBe('codex');
    expect(getRuntimeDriver('gemini-cli')?.provider).toBe('gemini');
    expect(getRuntimeDriver('agy')?.provider).toBe('gemini');
    expect(getRuntimeDriverForProvider('gemini').runtimeId).toBe('gemini-cli');
  });

  it('fails closed for unvalidated Agy transcript identity and parser support', async () => {
    expect(agyRuntime.buildLaunch('/tmp/project')).toEqual({ argv: ['agy'], providerSessionId: null });
    // No observed ID yet is pending (not a conflict); a malformed one is ambiguous.
    expect((await agyRuntime.locateSessionFile({ cwd: '/tmp/project', providerSessionId: null, launchedAfter: new Date().toISOString() })).status).toBe('pending');
    expect((await agyRuntime.locateSessionFile({ cwd: '/tmp/project', providerSessionId: 'not-a-uuid', launchedAfter: new Date().toISOString() })).status).toBe('ambiguous');
    expect(await agyRuntime.parseMessages('/tmp/not-a-real-agy-db')).toEqual([]);
    expect(await agyRuntime.buildExitPlan()).toEqual({ status: 'supported', kind: 'text', text: '/exit' });
    expect(await getRuntimeDriver('codex-cli')?.buildExitPlan()).toEqual({ status: 'supported', kind: 'control', key: 'C-c' });
  });
});

describe('conversationForkBlocked', () => {
  const segment = (patch: Partial<ConversationSegment> = {}): ConversationSegment => ({
    provider: 'claude',
    runtimeId: 'claude-code',
    providerSessionId: 'a13782f4-715f-4abc-9233-2207319a1234',
    launchProfile: { id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native', delegate: { kind: 'native', executable: 'claude' } },
    transcript: { state: 'resolved', file: '/home/test/.claude/projects/p/a.jsonl', identity: 'pinned' },
    ...patch,
  }) as unknown as ConversationSegment;

  it('lets a Claude or Codex conversation with its id, profile and transcript be forked', () => {
    expect(conversationForkBlocked(segment())).toBeNull();
    expect(conversationForkBlocked(segment({
      provider: 'codex', runtimeId: 'codex-cli',
      launchProfile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', delegate: { kind: 'native', executable: 'codex' } },
    }))).toBeNull();
  });

  it('says why one can\'t: no verified fork in its runtime, or what the segment lacks', () => {
    expect(conversationForkBlocked(segment({ provider: 'gemini', runtimeId: 'agy' }))).toBe('runtime_unsupported');
    expect(conversationForkBlocked(segment({ providerSessionId: null }))).toBe('conversation_unforkable');
    expect(conversationForkBlocked(segment({ launchProfile: null }))).toBe('conversation_unforkable');
    expect(conversationForkBlocked(segment({ transcript: { state: 'pending', file: null } as unknown as ConversationSegment['transcript'] }))).toBe('conversation_unforkable');
  });
});
