import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts reads the environment once at import, so each case re-imports
// it with the variable already in place.
async function loadConfig(host: string | undefined) {
  vi.resetModules();
  if (host === undefined) delete process.env.HOST;
  else process.env.HOST = host;
  return import('../src/config.js');
}

const originalHost = process.env.HOST;
afterEach(() => {
  if (originalHost === undefined) delete process.env.HOST;
  else process.env.HOST = originalHost;
});

describe('HOST', () => {
  it('binds to loopback when unset, so a fresh install is never on the network', async () => {
    expect((await loadConfig(undefined)).HOST).toBe('127.0.0.1');
  });

  it('treats an empty value (a blank line in .env) as unset rather than "all interfaces"', async () => {
    expect((await loadConfig('')).HOST).toBe('127.0.0.1');
  });

  it('reads an explicit address as given, for main.ts to check', async () => {
    expect((await loadConfig('::1')).HOST).toBe('::1');
  });

  it('accepts only loopback addresses, so the API is never on the network (main.ts refuses the rest)', async () => {
    const { isLoopbackHost } = await loadConfig(undefined);
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.5', '100.64.0.7', 'fd7a::1', 'example.com', '']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('resolveHostPaths', () => {
  // Pure: every case gets its own temp "home", never the real one.
  let home: string;
  let resolveHostPaths: typeof import('../src/config.js').resolveHostPaths;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'hestia-config-test-'));
    ({ resolveHostPaths } = await import('../src/config.js'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('gives a fresh install neutral names under the XDG config dir', () => {
    const paths = resolveHostPaths({}, home);
    expect(paths).toMatchObject({
      stateDir: path.join(home, '.config', 'madera', 'hestia'), stateDirSource: 'default',
      sessionPrefix: 'hestia-', sessionPrefixSource: 'default',
      dialogueRoot: path.join(home, '.config', 'madera', 'hestia', 'dialogue'), dialogueRootSource: 'default',
      userBinDir: path.join(home, '.local', 'bin'),
    });
  });

  it('follows an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
    const xdg = path.join(home, 'xdg');
    expect(resolveHostPaths({ XDG_CONFIG_HOME: xdg }, home).stateDir).toBe(path.join(xdg, 'madera', 'hestia'));
    expect(resolveHostPaths({ XDG_CONFIG_HOME: 'relative' }, home).stateDir).toBe(path.join(home, '.config', 'madera', 'hestia'));
  });

  it('follows the family MADERA_HOME before XDG_CONFIG_HOME, and ignores a relative one', () => {
    const madera = path.join(home, 'madera-root');
    const xdg = path.join(home, 'xdg');
    expect(resolveHostPaths({ MADERA_HOME: madera, XDG_CONFIG_HOME: xdg }, home)).toMatchObject({
      stateDir: path.join(madera, 'hestia'), stateDirSource: 'default', dialogueRoot: path.join(madera, 'hestia', 'dialogue'),
    });
    expect(resolveHostPaths({ MADERA_HOME: 'relative', XDG_CONFIG_HOME: xdg }, home).stateDir).toBe(path.join(xdg, 'madera', 'hestia'));
    expect(resolveHostPaths({ MADERA_HOME: '' }, home).stateDir).toBe(path.join(home, '.config', 'madera', 'hestia'));
  });

  it('lets HESTIA_STATE_DIR win over MADERA_HOME (an install pins it in .env)', () => {
    const stateDir = path.join(home, 'pinned');
    expect(resolveHostPaths({ HESTIA_STATE_DIR: stateDir, MADERA_HOME: path.join(home, 'madera-root') }, home))
      .toMatchObject({ stateDir, stateDirSource: 'env' });
  });

  it('archives under the state dir HESTIA_STATE_DIR names', () => {
    const stateDir = path.join(home, 'elsewhere');
    expect(resolveHostPaths({ HESTIA_STATE_DIR: stateDir }, home)).toMatchObject({
      stateDir, stateDirSource: 'env', sessionPrefix: 'hestia-', dialogueRoot: path.join(stateDir, 'dialogue'),
    });
  });

  it('lets each variable override its default independently', () => {
    const paths = resolveHostPaths({
      HESTIA_SESSION_PREFIX: 'second-',
      HESTIA_DIALOGUE_ROOT: path.join(home, 'mnemo'),
      HESTIA_USER_BIN_DIR: path.join(home, 'bin'),
    }, home);
    expect(paths).toMatchObject({
      stateDir: path.join(home, '.config', 'madera', 'hestia'), stateDirSource: 'default',
      sessionPrefix: 'second-', sessionPrefixSource: 'env',
      dialogueRoot: path.join(home, 'mnemo'), dialogueRootSource: 'env',
      userBinDir: path.join(home, 'bin'),
    });
  });

  it('treats blank values (KEY= in .env) as unset', () => {
    const paths = resolveHostPaths({ HESTIA_STATE_DIR: '', HESTIA_SESSION_PREFIX: ' ', HESTIA_DIALOGUE_ROOT: '' }, home);
    expect(paths).toMatchObject({ stateDirSource: 'default', sessionPrefix: 'hestia-', dialogueRootSource: 'default' });
  });

  it('refuses a prefix tmux would read as target syntax', () => {
    expect(() => resolveHostPaths({ HESTIA_SESSION_PREFIX: 'a.b:' }, home)).toThrow(/HESTIA_SESSION_PREFIX/);
  });

  it("follows CODEX_HOME and GEMINI_CLI_HOME, but not an inherited CLAUDE_CONFIG_DIR", () => {
    expect(resolveHostPaths({}, home).providerHomes).toEqual({
      claude: path.join(home, '.claude'), codex: path.join(home, '.codex'), gemini: path.join(home, '.gemini'),
    });
    expect(resolveHostPaths({ CODEX_HOME: '/c', GEMINI_CLI_HOME: '/g', CLAUDE_CONFIG_DIR: '/x' }, home).providerHomes).toEqual({
      claude: path.join(home, '.claude'), codex: '/c', gemini: path.join('/g', '.gemini'),
    });
  });

  it('puts worktrees where HESTIA_WORKTREES_DIR says, else falls back under the XDG data dir, never the state dir', () => {
    expect(resolveHostPaths({}, home)).toMatchObject({ worktreesDir: null, worktreesFallbackDir: path.join(home, '.local', 'share', 'madera', 'hestia', 'worktrees') });
    const data = path.join(home, 'data');
    expect(resolveHostPaths({ XDG_DATA_HOME: data, HESTIA_WORKTREES_DIR: path.join(home, 'trees') }, home)).toMatchObject({
      worktreesDir: path.join(home, 'trees'), worktreesFallbackDir: path.join(data, 'madera', 'hestia', 'worktrees'),
    });
    expect(resolveHostPaths({ XDG_DATA_HOME: 'relative', HESTIA_WORKTREES_DIR: 'relative' }, home)).toMatchObject({
      worktreesDir: null, worktreesFallbackDir: path.join(home, '.local', 'share', 'madera', 'hestia', 'worktrees'),
    });
  });

  it('describes each choice and where it came from', async () => {
    const { describeHostPaths } = await import('../src/config.js');
    const stateDir = path.join(home, 'state');
    expect(describeHostPaths(resolveHostPaths({ HESTIA_STATE_DIR: stateDir }, home))).toEqual([
      `state dir: ${stateDir} (from env)`,
      'tmux session prefix: hestia- (default)',
      `dialogue archive: ${path.join(stateDir, 'dialogue')} (default)`,
    ]);
  });
});

describe('localApiOrigin', () => {
  it('reaches a wildcard bind over loopback and an explicit address directly', async () => {
    const { localApiOrigin } = await import('../src/config.js');
    expect(localApiOrigin('127.0.0.1', 4791)).toBe('http://127.0.0.1:4791');
    expect(localApiOrigin('0.0.0.0', 4791)).toBe('http://127.0.0.1:4791');
    expect(localApiOrigin('::', 4791)).toBe('http://[::1]:4791');
    expect(localApiOrigin('100.64.0.7', 5000)).toBe('http://100.64.0.7:5000');
    expect(localApiOrigin('fd7a::1', 5000)).toBe('http://[fd7a::1]:5000');
    expect(localApiOrigin('localhost', 5000)).toBe('http://localhost:5000');
  });
});
