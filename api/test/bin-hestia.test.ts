import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile, chmod, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// bin/hestia, the command's launcher, run for real in sh from a stand-in
// program folder: which settings it loads and which node it runs. The
// "node" here is a script that prints how it was called.
const LAUNCHER = path.resolve(import.meta.dirname, '..', 'bin', 'hestia');
const I18N_DIR = path.resolve(import.meta.dirname, '..', 'scripts', 'i18n');

let tmp: string;
let api: string;
let fakeNode: string;

beforeEach(async () => {
  // Real path: bin/hestia resolves its own (macOS's tmpdir is behind /var -> /private/var).
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hestia-bin-test-')));
  api = path.join(tmp, 'api');
  await mkdir(path.join(api, 'bin'), { recursive: true });
  await copyFile(LAUNCHER, path.join(api, 'bin', 'hestia'));
  await chmod(path.join(api, 'bin', 'hestia'), 0o755);
  // Its words, as a program folder has them.
  await cp(I18N_DIR, path.join(api, 'scripts', 'i18n'), { recursive: true });
  fakeNode = path.join(tmp, 'node-22');
  await writeFile(fakeNode, '#!/bin/sh\necho "ran $0 $*"\n');
  await chmod(fakeNode, 0o755);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function run(...args: string[]) {
  return runIn({}, ...args);
}

function runIn(env: Record<string, string>, ...args: string[]) {
  return spawnSync(path.join(api, 'bin', 'hestia'), args, { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
}

describe('bin/hestia', () => {
  it('runs the node named in the settings, with those settings loaded', async () => {
    const state = path.join(tmp, 'state');
    await mkdir(state);
    await writeFile(path.join(state, '.env'), `PORT=4791\nHESTIA_NODE_BIN=${fakeNode}\n`);
    await symlink(path.join(state, '.env'), path.join(api, '.env'));
    const result = run('pair');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`ran ${fakeNode} --env-file=${api}/bin/../.env ${api}/bin/../dist/src/cli/main.js pair`);
  });

  it('falls back to an older install’s .node-bin', async () => {
    await writeFile(path.join(api, '.env'), 'PORT=4791\n');
    await writeFile(path.join(api, '.node-bin'), `${fakeNode}\n`);
    expect(run().stdout).toMatch(/^ran .*node-22 --env-file=/);
  });

  it('refuses to run without settings, and says so', () => {
    const result = run('pair');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('找不到設定');
  });

  it('says so in the command\'s language: HESTIA_LOCALE, else the POSIX locale', () => {
    expect(runIn({ LANG: 'en_US.UTF-8' }, 'pair').stderr).toBe(`hestia: no settings at ${api}/bin/../.env. Run ${api}/bin/../scripts/install.sh first.\n`);
    expect(runIn({ HESTIA_LOCALE: 'zh-TW', LC_ALL: 'en_US.UTF-8' }, 'pair').stderr).toContain('找不到設定');
    expect(runIn({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }, 'pair').stderr).toContain('no settings at');
  });

  it('names the missing file when the settings link leads nowhere', async () => {
    await symlink(path.join(tmp, 'gone', '.env'), path.join(api, '.env'));
    const result = run('pair');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(tmp, 'gone', '.env'));
    expect(result.stderr).toContain('不見了');
  });
});
