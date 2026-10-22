import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { janusProfileId, parseJanusProfiles, type JanusDescriptor } from '../src/launch-profiles.js';

describe('Janus profile catalogue parsing', () => {
  it('uses an unambiguous ID even when names contain separators', () => {
    expect(janusProfileId('codex', 'a/b')).not.toBe(janusProfileId('codex', 'a:b'));
    expect(janusProfileId('codex', 'a/b')).toMatch(/^janus:/);
  });

  it('accepts supported ready profiles and retains other valid registrations as records', async () => {
    const descriptors: JanusDescriptor[] = [
      { source: 'janus', provider: 'codex', name: 'work.team', state: 'ready', home: '/tmp/janus/work', conversation_root: '/tmp/janus/work/sessions', janusExecutable: '/usr/local/bin/janus' },
      { source: 'janus', provider: 'gemini', name: 'later', state: 'disabled', home: '/tmp/janus/gemini', conversation_root: '/tmp/janus/gemini/sessions', janusExecutable: '/usr/local/bin/janus' },
    ];
    const result = await parseJanusProfiles(descriptors, {
      janusExecutable: '/usr/local/bin/janus',
      canonicalize: async (value) => value,
      isReadableDirectory: async () => true,
    });
    expect(result.records).toHaveLength(2);
    expect(result.profiles.map((profile) => profile.provider)).toEqual(['codex']);
    expect(result.profiles[0].janusExecutable).toBe('/usr/local/bin/janus');
  });

  it('accepts Janus paths rows that omit source and state, validating readiness from the directories', async () => {
    const result = await parseJanusProfiles([
      { name: 'work', provider: 'codex', home: '/tmp/janus/work', conversation_root: '/tmp/janus/work/sessions' },
    ], {
      janusExecutable: '/usr/local/bin/janus',
      canonicalize: async (value) => value,
      isReadableDirectory: async () => true,
    });
    expect(result.profiles).toHaveLength(1);
    expect(result.records[0]).toEqual({
      source: 'janus', provider: 'codex', name: 'work', state: 'ready',
      home: '/tmp/janus/work', conversation_root: '/tmp/janus/work/sessions', janusExecutable: '/usr/local/bin/janus',
    });
  });

  it('rejects roots that do not match the provider-specific expected directory', async () => {
    const result = await parseJanusProfiles([
      { source: 'janus', provider: 'codex', name: 'work', state: 'ready', home: '/tmp/janus/work', conversation_root: '/tmp/other' },
    ], {
      janusExecutable: '/usr/local/bin/janus',
      canonicalize: async (value) => value,
      isReadableDirectory: async () => true,
    });
    expect(result.profiles).toEqual([]);
    expect(result.rejected).toBe(1);
  });

  it('rejects a profile home that is not a readable directory', async () => {
    const result = await parseJanusProfiles([
      { name: 'work', provider: 'codex', home: '/tmp/janus/work', conversation_root: '/tmp/janus/work/sessions' },
    ], {
      janusExecutable: '/usr/local/bin/janus',
      canonicalize: async (value) => value,
      isReadableDirectory: async (value) => value !== '/tmp/janus/work',
    });
    expect(result.profiles).toEqual([]);
    expect(result.rejected).toBe(1);
  });

  it('rejects a conversation root that is not a readable directory', async () => {
    const result = await parseJanusProfiles([
      { name: 'work', provider: 'codex', home: '/tmp/janus/work', conversation_root: '/tmp/janus/work/sessions' },
    ], {
      janusExecutable: '/usr/local/bin/janus',
      canonicalize: async (value) => value,
      isReadableDirectory: async (value) => value !== '/tmp/janus/work/sessions',
    });
    expect(result.profiles).toEqual([]);
    expect(result.rejected).toBe(1);
  });
});

describe('Janus discovery integration', () => {
  let root: string;
  let janusPath: string;
  let home: string;
  let service: typeof import('../src/launch-profiles.js');

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(path.join(os.tmpdir(), 'launch-profiles-test-'));
    janusPath = path.join(root, 'bin', 'janus');
    home = path.join(root, 'profiles', 'work', 'codex');
    await mkdir(path.join(home, 'sessions'), { recursive: true });
    await mkdir(path.dirname(janusPath), { recursive: true });
    process.env.HESTIA_STATE_DIR = path.join(root, 'state');
    process.env.HESTIA_JANUS_BIN = janusPath;
    service = await import('../src/launch-profiles.js');
  });

  afterEach(async () => {
    delete process.env.HESTIA_STATE_DIR;
    delete process.env.HESTIA_JANUS_BIN;
    await rm(root, { recursive: true, force: true });
  });

  it('discovers via canonical executable and retains stale registrations without making them launchable', async () => {
    const writeJanus = async (output: string) => {
      await writeFile(janusPath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, 'utf8');
      await chmod(janusPath, 0o755);
    };
    const payload = JSON.stringify([{ name: 'work', provider: 'codex', home, conversation_root: path.join(home, 'sessions') }]);
    await writeJanus(payload);
    const found = await service.getLaunchProfileCatalog(true);
    expect(found.profiles.some((profile) => profile.id === service.janusProfileId('codex', 'work'))).toBe(true);
    const storedBefore = JSON.parse(await readFile(path.join(root, 'state', 'launch-profiles.json'), 'utf8')) as { janus: { profiles: unknown[] } };
    expect(storedBefore.janus.profiles).toHaveLength(1);

    await writeJanus('not-json');
    const failed = await service.getLaunchProfileCatalog(true);
    expect(failed.profiles.map((profile) => profile.id)).toEqual(['native:claude', 'native:codex', 'native:gemini', 'native:agy']);
    expect(failed.profiles.find((profile) => profile.id === 'native:gemini')).toMatchObject({ provider: 'gemini', runtimeId: 'gemini-cli', executable: 'gemini' });
    expect(failed.profiles.find((profile) => profile.id === 'native:agy')).toMatchObject({ provider: 'gemini', runtimeId: 'agy', executable: 'agy' });
    expect(failed.janus.error?.code).toBe('invalid_output');
    expect(JSON.stringify(failed)).not.toContain(janusPath);
    const storedAfter = JSON.parse(await readFile(path.join(root, 'state', 'launch-profiles.json'), 'utf8')) as { janus: { profiles: unknown[] } };
    expect(storedAfter.janus.profiles).toEqual(storedBefore.janus.profiles);
  });

  it('keeps all native choices when Janus is absent', async () => {
    process.env.HESTIA_JANUS_BIN = path.join(root, 'missing-janus');
    const found = await service.getLaunchProfileCatalog(true);
    expect(found.profiles.map((profile) => profile.id)).toEqual(['native:claude', 'native:codex', 'native:gemini', 'native:agy']);
    expect(found.janus.error?.code).toBe('not_found');
  });
});
