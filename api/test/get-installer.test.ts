import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The one-line installer (install.sh at the repo root), run for real in sh
// against a release served from a temp folder over file://. The bundles
// here are stand-ins: their scripts/install.sh only records how it was
// called, so nothing is installed and no network is used.
const GET = path.resolve(import.meta.dirname, '..', '..', 'install.sh');
const VERSION = 'v9.8.7';
const NAME = `hestia-${VERSION}`;

const signingPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
let trustedKey: string;
let tmp: string;
let mirror: string;
let home: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'hestia-get-test-'));
  trustedKey = path.join(tmp, 'trusted-release.pem');
  await writeFile(trustedKey, signingPair.publicKey.export({ type: 'spki', format: 'pem' }));
  mirror = path.join(tmp, 'mirror');
  home = path.join(tmp, 'hestia-home');
  await mkdir(path.join(mirror, VERSION), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const STUB_INSTALLER = `#!/usr/bin/env bash
dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
printf '%s|%s\\n' "$dir" "$*" >>"$CALLS"
printf '%s\\n' "\${HESTIA_HOME:-}" >>"$CALLS.home"
[ "$1" = --deps-only ] && [ -n "\${FAIL_DEPS:-}" ] && exit 1
[ "$1" = --deps-only ] && mkdir -p "$dir/node_modules/express"
exit 0
`;

/** Packs a bundle (optionally doctored) and writes SHA256SUMS for it. */
async function publish(options: { extra?: (root: string) => Promise<void>; marker?: string; sums?: (hash: string) => string; alsoPack?: string[] } = {}): Promise<void> {
  const src = path.join(tmp, 'src');
  const root = path.join(src, NAME);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'install.sh'), STUB_INSTALLER);
  await chmod(path.join(root, 'scripts', 'install.sh'), 0o755);
  await writeFile(path.join(root, '.hestia-release'), `${options.marker ?? VERSION}\n`);
  await writeFile(path.join(root, 'package.json'), '{}\n');
  await options.extra?.(root);
  const bundle = path.join(mirror, VERSION, `${NAME}.tar.gz`);
  execFileSync('tar', ['-czf', bundle, '-C', src, NAME, ...(options.alsoPack ?? [])]);
  const hash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  await writeFile(path.join(mirror, VERSION, 'SHA256SUMS'), options.sums ? options.sums(hash) : `${hash}  ${NAME}.tar.gz\n`);
  await writeFile(path.join(mirror, VERSION, 'SHA256SUMS.sig'), sign('sha256', readFileSync(path.join(mirror, VERSION, 'SHA256SUMS')), signingPair.privateKey));
}

function get(args: string[] = [], env: Record<string, string> = {}) {
  const calls = path.join(tmp, 'calls');
  const result = spawnSync('sh', [GET, ...args], {
    env: {
      PATH: process.env.PATH ?? '', HOME: tmp, TMPDIR: tmp,
      HESTIA_RELEASE_PUBLIC_KEY: trustedKey, HESTIA_VERSION: VERSION, HESTIA_DOWNLOAD_BASE: `file://${mirror}`, HESTIA_HOME: home, CALLS: calls,
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  return { status: result.status, out: result.stdout, err: result.stderr, calls: recorded };
}

describe.skipIf(!existsSync(GET))('the one-line installer', () => {
  it('verifies, prepares in a staging folder, switches over, then runs the bundle’s installer with the options given', async () => {
    await publish();
    const run = get(['--tailscale', '--bundled-node']);
    expect(run.err).toBe('');
    expect(run.status).toBe(0);
    const app = path.join(home, 'app');
    expect(run.calls).toEqual([
      `${home}/app.new|--deps-only --bundled-node`,
      `${app}|--skip-build --tailscale --bundled-node`,
    ]);
    expect(readFileSync(path.join(app, '.hestia-release'), 'utf8').trim()).toBe(VERSION);
    expect(existsSync(path.join(home, 'app.new'))).toBe(false);
    expect(existsSync(path.join(home, 'app.old'))).toBe(false);
  });

  it('an upgrade keeps the install’s .env and .node-bin', async () => {
    await publish();
    const app = path.join(home, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(path.join(app, '.env'), 'AUTH_USERNAME=me\n');
    await writeFile(path.join(app, '.node-bin'), '/opt/node/bin/node\n');
    await writeFile(path.join(app, 'stale.js'), 'from the old version');
    expect(get([], { HESTIA_NO_SETUP: '1' }).status).toBe(0);
    expect(readFileSync(path.join(app, '.env'), 'utf8')).toBe('AUTH_USERNAME=me\n');
    expect(readFileSync(path.join(app, '.node-bin'), 'utf8')).toBe('/opt/node/bin/node\n');
    expect(existsSync(path.join(app, 'stale.js'))).toBe(false);
  });

  it('an upgrade carries .env over as the link into the state folder it is, not as a copy', async () => {
    await publish();
    const app = path.join(home, 'app');
    const state = path.join(tmp, 'state');
    await mkdir(app, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, '.env'), 'AUTH_USERNAME=me\n');
    await symlink(path.join(state, '.env'), path.join(app, '.env'));
    expect(get([], { HESTIA_NO_SETUP: '1' }).status).toBe(0);
    expect(lstatSync(path.join(app, '.env')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(app, '.env'))).toBe(path.join(state, '.env'));
    expect(readFileSync(path.join(app, '.env'), 'utf8')).toBe('AUTH_USERNAME=me\n');
  });

  it('hands HESTIA_HOME on to the bundle’s installer, which puts a downloaded Node.js there too', async () => {
    await publish();
    expect(get().status).toBe(0);
    expect(readFileSync(path.join(tmp, 'calls.home'), 'utf8').trim().split('\n')).toEqual([home, home]);
  });

  it('HESTIA_NO_SETUP=1 stops before the bundle’s installer sets anything up', async () => {
    await publish();
    const run = get(['--tailscale'], { HESTIA_NO_SETUP: '1' });
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toContain('--deps-only');
  });

  describe('refuses, leaving the current install alone', () => {
    async function withCurrentInstall(): Promise<string> {
      const app = path.join(home, 'app');
      await mkdir(app, { recursive: true });
      await writeFile(path.join(app, '.hestia-release'), 'v1.0.0\n');
      return app;
    }

    it('a substituted checksum even when the attacker also changed the bundle', async () => {
      await publish();
      await writeFile(path.join(mirror, VERSION, 'SHA256SUMS'), `${'0'.repeat(64)}  ${NAME}.tar.gz\n`);
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('發布簽章驗證失敗');
      expect(run.calls).toEqual([]);
    });

    it('a missing detached signature', async () => {
      await publish();
      await rm(path.join(mirror, VERSION, 'SHA256SUMS.sig'));
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('下載發布簽章失敗');
      expect(run.calls).toEqual([]);
    });

    it('a signature made by a different signer', async () => {
      await publish();
      const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
      await writeFile(path.join(mirror, VERSION, 'SHA256SUMS.sig'), sign('sha256', readFileSync(path.join(mirror, VERSION, 'SHA256SUMS')), wrongKey.privateKey));
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('發布簽章驗證失敗');
      expect(run.calls).toEqual([]);
    });

    it('missing independently provisioned trust root', async () => {
      await publish();
      const run = get([], { HESTIA_RELEASE_PUBLIC_KEY: path.join(tmp, 'missing.pem') });
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('缺少可信任');
      expect(run.calls).toEqual([]);
    });

    it('a bundle whose SHA-256 does not match', async () => {
      await publish({ sums: () => `${'0'.repeat(64)}  ${NAME}.tar.gz\n` });
      const app = await withCurrentInstall();
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('SHA-256 不符');
      expect(run.calls).toEqual([]);
      expect(readFileSync(path.join(app, '.hestia-release'), 'utf8')).toBe('v1.0.0\n');
    });

    it('SHA256SUMS without the bundle in it', async () => {
      await publish({ sums: (hash) => `${hash}  something-else.tar.gz\n` });
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('SHA256SUMS 裡沒有');
    });

    it('a bundle with a link in it', async () => {
      await publish({ extra: (root) => symlink('/etc/passwd', path.join(root, 'passwd')) });
      const app = await withCurrentInstall();
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('連結');
      expect(readFileSync(path.join(app, '.hestia-release'), 'utf8')).toBe('v1.0.0\n');
    });

    it('a bundle with anything outside its top folder', async () => {
      await publish({
        extra: async () => {
          await mkdir(path.join(tmp, 'src', 'elsewhere'), { recursive: true });
          await writeFile(path.join(tmp, 'src', 'elsewhere', 'x'), 'x');
        },
        alsoPack: ['elsewhere'],
      });
      const app = await withCurrentInstall();
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain(`不在 ${NAME}/ 底下`);
      expect(readFileSync(path.join(app, '.hestia-release'), 'utf8')).toBe('v1.0.0\n');
    });

    it('a bundle that is not the version asked for', async () => {
      await publish({ marker: 'v0.0.1' });
      const run = get();
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('不是 Hestia');
    });

    it('a failed dependency install', async () => {
      await publish();
      const app = await withCurrentInstall();
      const run = get([], { FAIL_DEPS: '1' });
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('原本的安裝沒有變動');
      expect(readFileSync(path.join(app, '.hestia-release'), 'utf8')).toBe('v1.0.0\n');
    });

    it('a version that is not vX.Y.Z', () => {
      const run = get([], { HESTIA_VERSION: '../../etc' });
      expect(run.status).not.toBe(0);
      expect(run.err).toContain('vX.Y.Z');
    });
  });
});
