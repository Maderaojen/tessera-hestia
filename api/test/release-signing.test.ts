import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const release = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'release-public.sh');
let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(path.join(os.tmpdir(), 'hestia-signing-')); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });
function run(env: Record<string, string> = {}) {
  return spawnSync('bash', [release, 'v9.8.7', '--publish', '--out', path.join(scratch, 'out')], {
    env: { PATH: process.env.PATH, HOME: scratch, ...env }, encoding: 'utf8', timeout: 5000,
  });
}
describe.skipIf(!existsSync(release))('release signing preflight', () => {
  it('fails before exporting or publishing without a protected signing key', () => {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HESTIA_RELEASE_SIGNING_KEY');
    expect(existsSync(path.join(scratch, 'out'))).toBe(false);
  });
  it('fails before exporting or publishing if signer differs from trusted root', async () => {
    const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePath = path.join(scratch, 'private.pem');
    const publicPath = path.join(scratch, 'public.pem');
    await writeFile(privatePath, first.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(publicPath, second.publicKey.export({ format: 'pem', type: 'spki' }));
    const result = run({ HESTIA_RELEASE_SIGNING_KEY: privatePath, HESTIA_RELEASE_PUBLIC_KEY: publicPath });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('簽章公私鑰不相符');
    expect(existsSync(path.join(scratch, 'out'))).toBe(false);
  });
});
