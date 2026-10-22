import { beforeEach, describe, expect, it } from 'vitest';
import { __setCodexSandboxForTests } from '../src/runtimes/codex-sandbox-state.js';
import { claudeCodeRuntime } from '../src/runtimes/claude-code.js';
import { codexCliRuntime } from '../src/runtimes/codex-cli.js';
import { agyRuntime } from '../src/runtimes/agy.js';
import { geminiCliRuntime } from '../src/runtimes/gemini-cli.js';
import {
  buildLaunchCommand, permissionModeRefusal, runtimeLaunchEnv, snapshotLaunchProfile, supportedPermissionModes, unavailablePermissionModes, usablePermissionModes,
} from '../src/runtimes/launch.js';
import { AGY_UPDATE_CHECK_OFF_ENV } from '../src/runtimes/agy-models.js';
import { profileCommand } from '../src/runtimes/model-switch.js';
import { recordedRuntime, recordedRuntimeId } from '../src/runtimes/resolve.js';
import type { ConversationSegment, LaunchProfileSnapshot, ManagedSession } from '../src/types.js';

const SID = 'a13782f4-715f-4abc-9233-2207319a1234';

const nativeCodex: LaunchProfileSnapshot = {
  id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native',
  home: '/home/test/.codex', conversationRoot: '/home/test/.codex/sessions', args: [],
  delegate: { kind: 'native', executable: 'codex' },
};
const janusCodex: LaunchProfileSnapshot = {
  id: 'janus:x', provider: 'codex', runtimeId: 'codex-cli', source: 'janus', profileName: 'work',
  home: '/home/test/.codex-work', conversationRoot: '/home/test/.codex-work/sessions',
  delegate: { kind: 'janus', executable: '/opt/janus' },
};
const nativeClaude: LaunchProfileSnapshot = {
  id: 'native:claude', provider: 'claude', runtimeId: 'claude-code', source: 'native',
  home: '/home/test/.claude', conversationRoot: '/home/test/.claude/projects', args: ['--dangerously-skip-permissions'],
  delegate: { kind: 'native', executable: '/usr/bin/claude' },
};

describe('buildLaunchCommand', () => {
  it('launches a native Codex with its snapshot home and without the shared daemon', () => {
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, '/p', { kind: 'fresh' })).toEqual({
      argv: ['env', 'CODEX_HOME=/home/test/.codex', 'codex', '-c', 'check_for_update_on_startup=false', '--no-daemon'], providerSessionId: null,
    });
  });

  it('does not repeat a flag the native profile already passes', () => {
    const command = buildLaunchCommand(codexCliRuntime, { ...nativeCodex, args: ['--no-daemon'] }, '/p', { kind: 'fresh' });
    expect(command?.argv).toEqual(['env', 'CODEX_HOME=/home/test/.codex', 'codex', '--no-daemon', '-c', 'check_for_update_on_startup=false']);
  });

  it('sets no environment when a native snapshot has no home', () => {
    expect(buildLaunchCommand(codexCliRuntime, { ...nativeCodex, home: undefined }, '/p', { kind: 'fresh' })?.argv).toEqual(['codex', '-c', 'check_for_update_on_startup=false', '--no-daemon']);
  });

  it('delegates Janus launches to `janus run <profile>` and lets Janus own the environment', () => {
    expect(buildLaunchCommand(codexCliRuntime, janusCodex, '/p', { kind: 'fresh' })?.argv).toEqual(['/opt/janus', 'run', 'work', '-c', 'check_for_update_on_startup=false', '--no-daemon']);
  });

  it('rejects an unsafe Janus profile name or mismatched delegate', () => {
    expect(buildLaunchCommand(codexCliRuntime, { ...janusCodex, profileName: '--help' }, '/p', { kind: 'fresh' })).toBeNull();
    expect(buildLaunchCommand(codexCliRuntime, { ...janusCodex, delegate: { kind: 'native', executable: 'codex' } }, '/p', { kind: 'fresh' })).toBeNull();
  });

  it('refuses a profile that belongs to a different runtime or provider', () => {
    expect(buildLaunchCommand(claudeCodeRuntime, nativeCodex, '/p', { kind: 'fresh' })).toBeNull();
    expect(buildLaunchCommand(codexCliRuntime, { ...nativeCodex, runtimeId: 'agy' }, '/p', { kind: 'fresh' })).toBeNull();
  });

  it('pins a fresh Claude session id and keeps native profile args first', () => {
    const command = buildLaunchCommand(claudeCodeRuntime, nativeClaude, '/p', { kind: 'fresh', name: 'demo' });
    expect(command?.argv.slice(0, 6)).toEqual(['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/usr/bin/claude', '--dangerously-skip-permissions', '--session-id']);
    expect(command?.argv.slice(7)).toEqual(['-n', 'demo']);
    expect(command?.providerSessionId).toBe(command?.argv[6]);
  });

  it('builds Claude resume for native and Janus profiles, and rejects an invalid id', () => {
    expect(buildLaunchCommand(claudeCodeRuntime, nativeClaude, '/p', { kind: 'resume', providerSessionId: SID })).toEqual({
      argv: ['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/usr/bin/claude', '--dangerously-skip-permissions', '--resume', SID], providerSessionId: SID,
    });
    const janusClaude = { ...janusCodex, id: 'janus:c', provider: 'claude' as const, runtimeId: 'claude-code' as const };
    expect(buildLaunchCommand(claudeCodeRuntime, janusClaude, '/p', { kind: 'resume', providerSessionId: SID })?.argv)
      .toEqual(['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/opt/janus', 'run', 'work', '--resume', SID]);
    expect(buildLaunchCommand(claudeCodeRuntime, nativeClaude, '/p', { kind: 'resume', providerSessionId: '--help' })).toBeNull();
  });

  it('resumes Codex without the shared daemon, pinned to the session folder, natively and through Janus', () => {
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, '/p', { kind: 'resume', providerSessionId: SID })).toEqual({
      argv: ['env', 'CODEX_HOME=/home/test/.codex', 'codex', 'resume', '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/p', SID], providerSessionId: SID,
    });
    expect(buildLaunchCommand(codexCliRuntime, janusCodex, '/p', { kind: 'resume', providerSessionId: SID })?.argv)
      .toEqual(['/opt/janus', 'run', 'work', 'resume', '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/p', SID]);
    expect(buildLaunchCommand(codexCliRuntime, { ...nativeCodex, args: ['--no-daemon'] }, '/p', { kind: 'resume', providerSessionId: SID })?.argv)
      // The profile's own flag stands; the plan's is not repeated.
      .toEqual(['env', 'CODEX_HOME=/home/test/.codex', 'codex', '--no-daemon', 'resume', '-c', 'check_for_update_on_startup=false', '-C', '/p', SID]);
  });

  it('refuses a Codex resume with an invalid id or a relative folder', () => {
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, '/p', { kind: 'resume', providerSessionId: '--help' })).toBeNull();
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, 'p', { kind: 'resume', providerSessionId: SID })).toBeNull();
  });

  it('forks a Claude conversation into a new pinned id, natively and through Janus, and rejects an invalid id', () => {
    const command = buildLaunchCommand(claudeCodeRuntime, nativeClaude, '/wt', { kind: 'fork', fromProviderSessionId: SID });
    expect(command?.argv.slice(0, 9)).toEqual([
      'env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/usr/bin/claude', '--dangerously-skip-permissions', '--resume', SID, '--fork-session', '--session-id',
    ]);
    expect(command?.providerSessionId).toBe(command?.argv[9]);
    expect(command?.providerSessionId).not.toBe(SID);
    const janusClaude = { ...janusCodex, id: 'janus:c', provider: 'claude' as const, runtimeId: 'claude-code' as const };
    expect(buildLaunchCommand(claudeCodeRuntime, janusClaude, '/wt', { kind: 'fork', fromProviderSessionId: SID })?.argv.slice(0, 10))
      .toEqual(['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/opt/janus', 'run', 'work', '--resume', SID, '--fork-session', '--session-id']);
    expect(buildLaunchCommand(claudeCodeRuntime, nativeClaude, '/wt', { kind: 'fork', fromProviderSessionId: '--help' })).toBeNull();
  });

  it('forks a Codex thread without the shared daemon, in the new folder, its id observed after start', () => {
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, '/wt', { kind: 'fork', fromProviderSessionId: SID })).toEqual({
      argv: ['env', 'CODEX_HOME=/home/test/.codex', 'codex', 'fork', '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/wt', SID], providerSessionId: null,
    });
    expect(buildLaunchCommand(codexCliRuntime, janusCodex, '/wt', { kind: 'fork', fromProviderSessionId: SID })?.argv)
      .toEqual(['/opt/janus', 'run', 'work', 'fork', '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/wt', SID]);
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, '/wt', { kind: 'fork', fromProviderSessionId: 'nope' })).toBeNull();
    expect(buildLaunchCommand(codexCliRuntime, nativeCodex, 'wt', { kind: 'fork', fromProviderSessionId: SID })).toBeNull();
  });

  it('has no fork for Agy or the legacy Gemini CLI', () => {
    const agyProfile: LaunchProfileSnapshot = { ...nativeCodex, id: 'native:agy', provider: 'gemini', runtimeId: 'agy', delegate: { kind: 'native', executable: 'agy' } };
    expect(buildLaunchCommand(agyRuntime, agyProfile, '/wt', { kind: 'fork', fromProviderSessionId: SID })).toBeNull();
    const geminiProfile: LaunchProfileSnapshot = { ...nativeCodex, id: 'native:gemini', provider: 'gemini', runtimeId: 'gemini-cli', delegate: { kind: 'native', executable: 'gemini' } };
    expect(buildLaunchCommand(geminiCliRuntime, geminiProfile, '/wt', { kind: 'fork', fromProviderSessionId: SID })).toBeNull();
  });

  it('has no resume for a runtime that does not support one', () => {
    const geminiProfile: LaunchProfileSnapshot = { ...nativeCodex, id: 'native:gemini', provider: 'gemini', runtimeId: 'gemini-cli', delegate: { kind: 'native', executable: 'gemini' } };
    expect(buildLaunchCommand(geminiCliRuntime, geminiProfile, '/p', { kind: 'resume', providerSessionId: SID })).toBeNull();
  });
});

describe('snapshotLaunchProfile', () => {
  it('records each native runtime\'s own home and conversation root', () => {
    const codex = snapshotLaunchProfile(codexCliRuntime, { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', label: 'Codex', source: 'native', executable: 'codex', args: ['-x'] });
    expect(codex).toMatchObject({ runtimeId: 'codex-cli', source: 'native', args: ['-x'], delegate: { kind: 'native', executable: 'codex' } });
    expect(codex.conversationRoot).toBe(codexCliRuntime.nativeLocations().conversationRoot);
    const agy = snapshotLaunchProfile(agyRuntime, { id: 'native:agy', provider: 'gemini', runtimeId: 'agy', label: 'Agy', source: 'native', executable: 'agy', args: [] });
    expect(agy.conversationRoot).toMatch(/\.gemini\/antigravity-cli\/conversations$/);
    expect(agy.home).toMatch(/\.gemini$/);
  });

  it('keeps Janus-resolved paths and the canonical Janus executable', () => {
    const snapshot = snapshotLaunchProfile(codexCliRuntime, {
      id: 'janus:x', provider: 'codex', runtimeId: 'codex-cli', label: 'codex · work', source: 'janus', profileName: 'work',
      home: '/j/home', conversationRoot: '/j/home/sessions', janusExecutable: '/opt/janus',
    });
    expect(snapshot).toEqual({
      id: 'janus:x', provider: 'codex', runtimeId: 'codex-cli', source: 'janus', profileName: 'work',
      home: '/j/home', conversationRoot: '/j/home/sessions', delegate: { kind: 'janus', executable: '/opt/janus' },
    });
  });
});

describe('recordedRuntime', () => {
  const session = { provider: 'claude', runtimeId: 'codex-cli', launchProfile: null } as unknown as ManagedSession;
  const claudeSegment = { provider: 'claude', runtimeId: 'claude-code', launchProfile: null } as unknown as ConversationSegment;

  it('prefers the conversation segment over a stale session binding', () => {
    expect(recordedRuntimeId(session, claudeSegment)).toBe('claude-code');
    expect(recordedRuntime(session, claudeSegment)?.runtimeId).toBe('claude-code');
  });

  it('never guesses a runtime from the provider and fails closed on a mismatch', () => {
    expect(recordedRuntime(session)).toBeUndefined(); // codex-cli runtime vs claude provider
    const unrecorded = { provider: 'gemini', runtimeId: null, launchProfile: null } as unknown as ConversationSegment;
    expect(recordedRuntime(session, unrecorded)).toBeUndefined();
  });

  it('falls back to the snapshot runtime when a segment has no runtime field', () => {
    const segment = { provider: 'gemini', launchProfile: { runtimeId: 'agy' } } as unknown as ConversationSegment;
    expect(recordedRuntime(session, segment)?.runtimeId).toBe('agy');
  });
});

describe('launch permission modes (ADR 0027)', () => {
  // Codex's auto needs its sandbox; the matrix assumes one that works.
  beforeEach(() => __setCodexSandboxForTests(true));
  const CLAUDE_YOLO = ['--permission-mode', 'bypassPermissions', '--settings', '{"skipDangerousModePermissionPrompt":true}'];
  const plainClaude: LaunchProfileSnapshot = { ...nativeClaude, args: [] };
  const janusClaude: LaunchProfileSnapshot = { ...janusCodex, id: 'janus:c', provider: 'claude', runtimeId: 'claude-code' };
  const agyProfile: LaunchProfileSnapshot = {
    ...nativeCodex, id: 'native:agy', provider: 'gemini', runtimeId: 'agy', home: undefined, delegate: { kind: 'native', executable: 'agy' },
  };
  const mode = (profile: LaunchProfileSnapshot, permissionMode: LaunchProfileSnapshot['permissionMode']) => ({ ...profile, permissionMode });
  const argv = (driver: Parameters<typeof buildLaunchCommand>[0], profile: LaunchProfileSnapshot, intent: Parameters<typeof buildLaunchCommand>[3]) =>
    buildLaunchCommand(driver, profile, '/p', intent)?.argv ?? null;
  const fresh = { kind: 'fresh' as const };
  const resume = { kind: 'resume' as const, providerSessionId: SID };
  const fork = { kind: 'fork' as const, fromProviderSessionId: SID };

  it('passes nothing for cli_default, as before modes existed', () => {
    expect(argv(codexCliRuntime, mode(nativeCodex, 'cli_default'), fresh)).toEqual(argv(codexCliRuntime, nativeCodex, fresh));
    expect(argv(codexCliRuntime, mode(nativeCodex, 'cli_default'), resume)).toEqual(argv(codexCliRuntime, nativeCodex, resume));
  });

  it.each([
    ['auto', ['--permission-mode', 'auto']],
    ['yolo', CLAUDE_YOLO],
  ] as const)('Claude %s: right after the executable, on fresh, resume and fork, native and Janus', (permissionMode, flags) => {
    expect(argv(claudeCodeRuntime, mode(plainClaude, permissionMode), fresh)?.slice(3, 4 + flags.length)).toEqual(['/usr/bin/claude', ...flags]);
    expect(argv(claudeCodeRuntime, mode(plainClaude, permissionMode), resume)).toEqual(['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/usr/bin/claude', ...flags, '--resume', SID]);
    expect(argv(claudeCodeRuntime, mode(plainClaude, permissionMode), fork)?.slice(3, 7 + flags.length)).toEqual(['/usr/bin/claude', ...flags, '--resume', SID, '--fork-session']);
    expect(argv(claudeCodeRuntime, mode(janusClaude, permissionMode), resume)).toEqual(['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/opt/janus', 'run', 'work', ...flags, '--resume', SID]);
    expect(argv(claudeCodeRuntime, mode(janusClaude, permissionMode), fork)?.slice(6, 8 + flags.length)).toEqual([...flags, '--resume', SID]);
  });

  it.each([
    ['auto', '--approve-for-me'],
    ['yolo', '--dangerously-bypass-approvals-and-sandbox'],
  ] as const)('Codex %s: after the subcommand of resume and fork, native and Janus', (permissionMode, flag) => {
    const native = mode(nativeCodex, permissionMode);
    const janus = mode(janusCodex, permissionMode);
    expect(argv(codexCliRuntime, native, fresh)).toEqual(['env', 'CODEX_HOME=/home/test/.codex', 'codex', flag, '-c', 'check_for_update_on_startup=false', '--no-daemon']);
    expect(argv(codexCliRuntime, native, resume)).toEqual(['env', 'CODEX_HOME=/home/test/.codex', 'codex', 'resume', flag, '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/p', SID]);
    expect(argv(codexCliRuntime, native, fork)).toEqual(['env', 'CODEX_HOME=/home/test/.codex', 'codex', 'fork', flag, '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/p', SID]);
    expect(argv(codexCliRuntime, janus, fresh)).toEqual(['/opt/janus', 'run', 'work', flag, '-c', 'check_for_update_on_startup=false', '--no-daemon']);
    expect(argv(codexCliRuntime, janus, resume)).toEqual(['/opt/janus', 'run', 'work', 'resume', flag, '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/p', SID]);
    expect(argv(codexCliRuntime, janus, fork)).toEqual(['/opt/janus', 'run', 'work', 'fork', flag, '-c', 'check_for_update_on_startup=false', '--no-daemon', '-C', '/p', SID]);
  });

  it('Agy: yolo only; auto has no flags and is refused', () => {
    expect(argv(agyRuntime, mode(agyProfile, 'yolo'), fresh)).toEqual(['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy', '--dangerously-skip-permissions']);
    expect(argv(agyRuntime, mode(agyProfile, 'auto'), fresh)).toBeNull();
    expect(permissionModeRefusal(agyRuntime, mode(agyProfile, 'auto'))).toBe('permission_mode_unsupported');
    expect(supportedPermissionModes(agyRuntime)).toEqual(['cli_default', 'yolo']);
    expect(supportedPermissionModes(geminiCliRuntime)).toEqual(['cli_default']);
    expect(supportedPermissionModes(claudeCodeRuntime)).toEqual(['cli_default', 'auto', 'yolo']);
  });

  it('refuses a mode when a native profile\'s own args already decide permissions, instead of passing both', () => {
    // nativeClaude passes --dangerously-skip-permissions itself.
    expect(permissionModeRefusal(claudeCodeRuntime, mode(nativeClaude, 'auto'))).toBe('permission_mode_conflict');
    expect(argv(claudeCodeRuntime, mode(nativeClaude, 'auto'), fresh)).toBeNull();
    expect(argv(claudeCodeRuntime, mode(nativeClaude, 'yolo'), resume)).toBeNull();
    // Its own args are fine with cli_default.
    expect(permissionModeRefusal(claudeCodeRuntime, mode(nativeClaude, 'cli_default'))).toBeNull();
    // --settings only clashes with yolo, which passes its own.
    const withSettings = mode({ ...plainClaude, args: ['--settings', '/x.json'] }, 'auto');
    expect(permissionModeRefusal(claudeCodeRuntime, withSettings)).toBeNull();
    expect(permissionModeRefusal(claudeCodeRuntime, { ...withSettings, permissionMode: 'yolo' })).toBe('permission_mode_conflict');
    expect(permissionModeRefusal(codexCliRuntime, mode({ ...nativeCodex, args: ['--sandbox=read-only'] }, 'auto'))).toBe('permission_mode_conflict');
    expect(permissionModeRefusal(codexCliRuntime, mode({ ...nativeCodex, args: ['-a', 'never'] }, 'yolo'))).toBe('permission_mode_conflict');
  });

  it('refuses Codex auto where Codex\'s sandbox can\'t start (or hasn\'t been probed yet); yolo is unaffected', () => {
    for (const state of [false, null]) {
      __setCodexSandboxForTests(state);
      expect(permissionModeRefusal(codexCliRuntime, mode(nativeCodex, 'auto'))).toBe('permission_mode_unavailable');
      expect(argv(codexCliRuntime, mode(nativeCodex, 'auto'), fresh)).toBeNull();
      expect(argv(codexCliRuntime, mode(nativeCodex, 'yolo'), fresh)).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(supportedPermissionModes(codexCliRuntime)).toEqual(['cli_default', 'auto', 'yolo']);
      expect(usablePermissionModes(codexCliRuntime)).toEqual(['cli_default', 'yolo']);
      expect(unavailablePermissionModes(codexCliRuntime)).toEqual({ auto: 'sandbox_unavailable' });
    }
    __setCodexSandboxForTests(true);
    expect(unavailablePermissionModes(codexCliRuntime)).toEqual({});
    expect(unavailablePermissionModes(claudeCodeRuntime)).toEqual({});
  });

  it('freezes the mode into the snapshot, leaving cli_default out', () => {
    const profile = { id: 'native:codex', provider: 'codex' as const, runtimeId: 'codex-cli' as const, label: 'Codex', source: 'native' as const, executable: 'codex', args: [] };
    expect(snapshotLaunchProfile(codexCliRuntime, profile, 'yolo').permissionMode).toBe('yolo');
    expect(snapshotLaunchProfile(codexCliRuntime, profile, 'cli_default')).not.toHaveProperty('permissionMode');
    expect(snapshotLaunchProfile(codexCliRuntime, profile)).not.toHaveProperty('permissionMode');
  });
});

describe('the CLI\'s own update check is off on every launch (ADR 0030)', () => {
  beforeEach(() => __setCodexSandboxForTests(true));
  const janusClaude: LaunchProfileSnapshot = { ...janusCodex, id: 'janus:c', provider: 'claude', runtimeId: 'claude-code' };
  const plainClaude: LaunchProfileSnapshot = { ...nativeClaude, args: [] };
  const agyProfile: LaunchProfileSnapshot = {
    ...nativeCodex, id: 'native:agy', provider: 'gemini', runtimeId: 'agy', home: undefined, delegate: { kind: 'native', executable: 'agy' },
  };
  const janusAgy: LaunchProfileSnapshot = { ...janusCodex, id: 'janus:a', provider: 'gemini', runtimeId: 'agy' };
  const argv = (driver: Parameters<typeof buildLaunchCommand>[0], profile: LaunchProfileSnapshot, intent: Parameters<typeof buildLaunchCommand>[3]) =>
    buildLaunchCommand(driver, profile, '/p', intent)?.argv ?? null;
  const intents = [
    { kind: 'fresh' as const },
    { kind: 'resume' as const, providerSessionId: SID },
    { kind: 'fork' as const, fromProviderSessionId: SID },
  ];
  const CODEX_OFF = ['-c', 'check_for_update_on_startup=false'];

  it('Codex: `-c check_for_update_on_startup=false` after the subcommand, native and Janus, with any permission mode', () => {
    for (const intent of intents) {
      for (const profile of [nativeCodex, janusCodex, { ...nativeCodex, permissionMode: 'yolo' as const }, { ...janusCodex, permissionMode: 'auto' as const }]) {
        const command = argv(codexCliRuntime, profile, intent)!;
        const at = command.indexOf('-c');
        expect(command.slice(at, at + 2), `${profile.id} ${intent.kind}`).toEqual(CODEX_OFF);
        // Before the runtime's own options, after the subcommand and the mode's flags.
        expect(command.indexOf('--no-daemon')).toBeGreaterThan(at);
        if (intent.kind !== 'fresh') expect(command.indexOf(intent.kind)).toBeLessThan(at);
      }
    }
    expect(argv(codexCliRuntime, { ...nativeCodex, permissionMode: 'yolo' }, intents[0]!))
      .toEqual(['env', 'CODEX_HOME=/home/test/.codex', 'codex', '--dangerously-bypass-approvals-and-sandbox', ...CODEX_OFF, '--no-daemon']);
    expect(argv(codexCliRuntime, janusCodex, intents[1]!)).toEqual(['/opt/janus', 'run', 'work', 'resume', ...CODEX_OFF, '--no-daemon', '-C', '/p', SID]);
  });

  it('Claude Code: DISABLE_AUTOUPDATER=1 in the environment, native and Janus', () => {
    for (const intent of intents) {
      for (const profile of [plainClaude, janusClaude, { ...plainClaude, permissionMode: 'yolo' as const }]) {
        const command = argv(claudeCodeRuntime, profile, intent)!;
        expect(command[0]).toBe('env');
        expect(command).toContain('DISABLE_AUTOUPDATER=1');
      }
    }
    expect(argv(claudeCodeRuntime, janusClaude, intents[1]!))
      .toEqual(['env', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1', 'DISABLE_AUTOUPDATER=1', '/opt/janus', 'run', 'work', '--resume', SID]);
  });

  it('Agy: AGY_CLI_DISABLE_AUTO_UPDATE=true (its updater ignores "1"), native and Janus', () => {
    expect(argv(agyRuntime, agyProfile, intents[0]!)).toEqual(['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy']);
    expect(argv(agyRuntime, { ...agyProfile, permissionMode: 'yolo' }, intents[0]!)).toEqual(['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy', '--dangerously-skip-permissions']);
    expect(argv(agyRuntime, janusAgy, intents[0]!)).toEqual(['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', '/opt/janus', 'run', 'work']);
  });

  it('the legacy Gemini CLI declares nothing (未處理)', () => {
    expect(geminiCliRuntime.updateCheckOff).toBeUndefined();
  });

  it('a CLI subcommand run as the profile (`agy models`, a processor) carries the same environment, native and Janus', () => {
    const env = AGY_UPDATE_CHECK_OFF_ENV;
    expect(profileCommand(agyProfile, ['models'], {}, env)?.env).toMatchObject({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    expect(profileCommand(janusAgy, ['models'], {}, env)).toMatchObject({ argv: ['/opt/janus', 'run', 'work', 'models'], env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } });
    expect(runtimeLaunchEnv(claudeCodeRuntime)).toEqual({ CLAUDE_CODE_DISABLE_AGENT_VIEW: '1', DISABLE_AUTOUPDATER: '1' });
  });
});
