import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FRONTEND_ORIGIN } from '../src/config.js';

// scripts/install.sh's path helpers, run for real in bash against a temp
// HOME (never the real one). Only the helper functions are sourced; the
// script's install steps never run.
const API_DIR = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(API_DIR, 'scripts', 'install.sh');
const BUILT = existsSync(path.join(API_DIR, 'dist', 'src', 'config.js'));
const BUILT_SCRIPTS = existsSync(path.join(API_DIR, 'dist', 'scripts', 'install-config.js'));
// What the script prints comes from scripts/i18n (msg.sh), sourced as the script does; no
// LANG in these runs, so it is the Chinese.
const I18N_DIR = path.join(API_DIR, 'scripts', 'i18n');
const MESSAGES = `HESTIA_I18N_DIR='${I18N_DIR}'\n. "$HESTIA_I18N_DIR/msg.sh"\n`;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'hestia-install-test-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function helper(call: string, env: Record<string, string> = {}): string {
  const functions = 'eval "$(sed -n \'/^default_state_dir() {/,/^}/p;/^resolved_paths() {/,/^}/p;/^local_api_url() {/,/^}/p;/^is_loopback_host() {/,/^}/p\' "$SCRIPT")"';
  const script = `set -euo pipefail\n${MESSAGES}${functions}\n${call}`;
  const base = { PATH: process.env.PATH ?? '', HOME: home, SCRIPT, API_DIR, ENV_FILE: path.join(home, 'no.env') };
  return execFileSync('bash', ['-c', script], { env: { ...base, ...env }, encoding: 'utf8' });
}

describe('install.sh path helpers', () => {
  it('writes only a loopback HOST (the API refuses any other)', () => {
    const loopback = (host: string) => helper(`is_loopback_host '${host}' && echo yes || echo no`).trim();
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(loopback(host)).toBe('yes');
    for (const host of ['0.0.0.0', '::', '192.168.1.5', '100.64.0.7', 'fd7a::1', '']) expect(loopback(host)).toBe('no');
  });

  // An older install's .env may still hold a wildcard or other HOST; its
  // serve is looked up by this address.
  it('connects to a wildcard HOST over loopback and to anything else as given', () => {
    const url = (host: string) => helper(`local_api_url '${host}' 4791`);
    expect(url('127.0.0.1')).toBe('http://127.0.0.1:4791');
    expect(url('0.0.0.0')).toBe('http://127.0.0.1:4791');
    expect(url('::')).toBe('http://[::1]:4791');
    expect(url('fd7a::1')).toBe('http://[fd7a::1]:4791');
    expect(url('[fd7a::1]')).toBe('http://[fd7a::1]:4791');
    expect(url('100.64.0.7')).toBe('http://100.64.0.7:4791');
  });

  it('defaults to the XDG state dir', () => {
    expect(helper('default_state_dir')).toBe(path.join(home, '.config', 'madera', 'hestia'));
    expect(helper('default_state_dir', { XDG_CONFIG_HOME: path.join(home, 'xdg') })).toBe(path.join(home, 'xdg', 'madera', 'hestia'));
  });

  it('puts the family MADERA_HOME first, as config.ts does, and ignores a relative one', () => {
    const xdg = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
    expect(helper('default_state_dir', { ...xdg, MADERA_HOME: path.join(home, 'm') })).toBe(path.join(home, 'm', 'hestia'));
    expect(helper('default_state_dir', { ...xdg, MADERA_HOME: 'relative' })).toBe(path.join(home, 'xdg', 'madera', 'hestia'));
  });

  describe.skipIf(!BUILT)('resolved_paths (needs npm run build)', () => {
    it('asks the built API, so a fresh install gets neutral names', () => {
      expect(helper('resolved_paths "" ""')).toBe(`${path.join(home, '.config', 'madera', 'hestia')}\nhestia-\n`);
    });

    it('reads .env, lets the given values win over it, and ignores this shell’s own variables', async () => {
      const envFile = path.join(home, '.env');
      await writeFile(envFile, `HESTIA_STATE_DIR=${path.join(home, 'from-env')}\nHESTIA_SESSION_PREFIX=fromenv-\n`);
      const shell = { ENV_FILE: envFile, HESTIA_STATE_DIR: '/ignored', HESTIA_SESSION_PREFIX: 'ignored-' };
      expect(helper('resolved_paths "" ""', shell)).toBe(`${path.join(home, 'from-env')}\nfromenv-\n`);
      expect(helper(`resolved_paths '${path.join(home, 'opt')}' second-`, shell)).toBe(`${path.join(home, 'opt')}\nsecond-\n`);
    });

    // The installer runs in the user's shell; the service later sees only
    // .env, where the install pins what it resolved here.
    it('follows MADERA_HOME from the installing shell, unless .env already pins a state dir', async () => {
      const madera = path.join(home, 'm');
      expect(helper('resolved_paths "" ""', { MADERA_HOME: madera })).toBe(`${path.join(madera, 'hestia')}\nhestia-\n`);
      const envFile = path.join(home, '.env');
      await writeFile(envFile, `HESTIA_STATE_DIR=${path.join(home, 'pinned')}\n`);
      expect(helper('resolved_paths "" ""', { MADERA_HOME: madera, ENV_FILE: envFile })).toBe(`${path.join(home, 'pinned')}\nhestia-\n`);
    });

    it('fails on a prefix tmux would misread', () => {
      expect(() => helper('resolved_paths "" "a.b" 2>/dev/null')).toThrow();
    });
  });
});

// Which frontends the install lets in: the CORS step, sourced like the
// helpers above, against a .env in the temp HOME.
async function corsChoice(envLines: string[] | null, optCors = ''): Promise<{ out: string; err: string }> {
  const pick = [
    '/^ENV_VERSION=/p', '/^note() /p', '/^warn() /p', '/^env_get() {/,/^}/p',
    '/^install_config() {/,/^}/p', '/^cors_defaults() {/,/^}/p', '/^choose_cors() {/,/^}/p',
  ].join(';');
  const envFile = path.join(home, '.env');
  const errFile = path.join(home, '.stderr');
  const script = `set -euo pipefail\n${MESSAGES}C_DIM= C_YELLOW= C_RESET=\neval "$(sed -n '${pick}' "$SCRIPT")"\nchoose_cors 2>"$ERR_FILE"`;
  if (envLines) await writeFile(envFile, `${envLines.join('\n')}\n`);
  const out = execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: home, SCRIPT, API_DIR, ENV_FILE: envFile, ERR_FILE: errFile, OPT_CORS: optCors },
    encoding: 'utf8',
  });
  return { out, err: readFileSync(errFile, 'utf8') };
}

describe.skipIf(!BUILT_SCRIPTS)('install.sh CORS step (needs npm run build)', () => {
  const OFFICIAL = DEFAULT_FRONTEND_ORIGIN;

  it('a fresh install leaves it blank: the API’s defaults, native app included', async () => {
    const { out, err } = await corsChoice(null);
    expect(out).toBe('');
    expect(err).toBe('');
  });

  it('takes an old installer’s default (the web frontend alone) back to the defaults, and says so', async () => {
    const { out, err } = await corsChoice([`CORS_ALLOWED_ORIGINS=${OFFICIAL}`]);
    expect(out).toBe('');
    expect(err).toContain('capacitor://localhost');
    expect(err).toContain('tauri://localhost');
    expect(err).toContain('http://tauri.localhost');
  });

  it('keeps that same value once this installer wrote it, warning that the app is shut out', async () => {
    const { out, err } = await corsChoice([`CORS_ALLOWED_ORIGINS=${OFFICIAL}`, 'HESTIA_ENV_VERSION=2']);
    expect(out).toBe(OFFICIAL);
    expect(err).toContain('App 會連不上');
    expect(err).toContain(`--cors-origins "${OFFICIAL},capacitor://localhost,https://localhost,tauri://localhost,http://tauri.localhost"`);
  });

  it('keeps a list someone wrote, warning only about the app origins it lacks', async () => {
    const list = `${OFFICIAL},http://localhost:5173,https://localhost`;
    const { out, err } = await corsChoice([`CORS_ALLOWED_ORIGINS=${list}`]);
    expect(out).toBe(list);
    expect(err).toContain('capacitor://localhost');
    expect(err).toContain('tauri://localhost');
    expect(err).toContain('http://tauri.localhost');

    const full = `https://mine.example,capacitor://localhost,https://localhost,tauri://localhost,http://tauri.localhost`;
    expect(await corsChoice([`CORS_ALLOWED_ORIGINS=${full}`])).toEqual({ out: full, err: '' });
  });

  it('--cors-origins wins over .env, and `default` means blank', async () => {
    expect((await corsChoice([`CORS_ALLOWED_ORIGINS=https://old.example`], 'https://new.example,capacitor://localhost,https://localhost,tauri://localhost,http://tauri.localhost')).out)
      .toBe('https://new.example,capacitor://localhost,https://localhost,tauri://localhost,http://tauri.localhost');
    expect(await corsChoice([`CORS_ALLOWED_ORIGINS=https://old.example`], 'default')).toEqual({ out: '', err: '' });
  });
});

// The --uninstall --purge guard and the install step that marks the state
// dir, sourced the same way and run only against folders under the temp
// HOME. The full --uninstall is deliberately not run: it would talk to the
// real systemd and tailscale serve.
function stateHelper(call: string): { out: string; err: string } {
  const pick = [
    '/^STATE_MARKER=/p', '/^SHARED_STATE_MARKER=/p', '/^warn() /p', '/^die() /p',
    '/^state_dir_is_ours() {/,/^}/p', '/^prepare_state_dir() {/,/^}/p', '/^canonical_dir() {/,/^}/p', '/^purge_allowed() {/,/^}/p',
  ].join(';');
  const errFile = path.join(home, '.stderr');
  const script = `set -euo pipefail\n${MESSAGES}C_YELLOW= C_RESET= C_BOLD= C_RED=\neval "$(sed -n '${pick}' "$SCRIPT")"\n{\n${call}\n} 2>"$ERR_FILE"`;
  const out = execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: home, SCRIPT, ERR_FILE: errFile },
    encoding: 'utf8',
  });
  return { out, err: readFileSync(errFile, 'utf8') };
}

function purgeVerdict(dir: string): string {
  return stateHelper(`if reason="$(purge_allowed '${dir}')"; then echo allowed; else echo "refused: $reason"; fi`).out.trim();
}

describe('install.sh --purge guard', () => {
  it('refuses /, HOME, any folder holding HOME, and any folder directly under HOME', async () => {
    await mkdir(path.join(home, 'work'), { recursive: true });
    await writeFile(path.join(home, 'work', 'registry.json'), '{}'); // even one that looks like state
    await mkdir(path.join(home, '.config'), { recursive: true });
    for (const dir of ['/', home, `${home}/`, path.dirname(home), path.join(home, 'work'), path.join(home, '.config'), path.join(home, 'not-there')]) {
      expect(purgeVerdict(dir), dir).toMatch(/^refused: /);
    }
    expect(purgeVerdict('')).toMatch(/^refused: /);
  });

  it('refuses a symlink that leads to HOME', async () => {
    await mkdir(path.join(home, '.config'), { recursive: true });
    await symlink(home, path.join(home, '.config', 'looks-fine'));
    expect(purgeVerdict(path.join(home, '.config', 'looks-fine'))).toMatch(/^refused: .*家目錄/);
  });

  it('refuses a deeper folder that does not look like a state dir', async () => {
    const dir = path.join(home, 'projects', 'important');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'thesis.tex'), 'years of work');
    expect(purgeVerdict(dir)).toMatch(/^refused: .*不是 Hestia 的狀態資料夾/);
  });

  it('allows a folder with the marker, or one that is already gone', async () => {
    const marked = path.join(home, '.config', 'madera', 'hestia');
    await mkdir(marked, { recursive: true });
    await writeFile(path.join(marked, '.hestia-state'), '');
    expect(purgeVerdict(marked)).toBe('allowed');

    expect(purgeVerdict(path.join(home, '.config', 'never-made'))).toBe('allowed');
  });

  it('refuses a folder holding API state but no marker', async () => {
    const unmarked = path.join(home, 'state', 'b');
    await mkdir(unmarked, { recursive: true });
    await writeFile(path.join(unmarked, 'registry.json'), '{}');
    await writeFile(path.join(unmarked, 'cli-token'), 'x');
    expect(purgeVerdict(unmarked)).toMatch(/^refused: .*\.hestia-state/);
  });
});

describe('install.sh state dir preparation', () => {
  it('creates a new state dir as 700 and marks it', async () => {
    const dir = path.join(home, '.config', 'madera', 'hestia');
    stateHelper(`prepare_state_dir '${dir}'`);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(dir, '.hestia-state'))).toBe(true);
    expect(purgeVerdict(dir)).toBe('allowed');
  });

  it('locks down an existing marked state dir, and locks down and marks an empty one', async () => {
    const existing = path.join(home, 'existing', 'state');
    await mkdir(existing, { recursive: true });
    await chmod(existing, 0o755);
    await writeFile(path.join(existing, '.hestia-state'), '');
    await writeFile(path.join(existing, 'registry.json'), '{}');
    stateHelper(`prepare_state_dir '${existing}'`);
    expect((await stat(existing)).mode & 0o777).toBe(0o700);

    const empty = path.join(home, 'empty', 'state');
    await mkdir(empty, { recursive: true });
    await chmod(empty, 0o755);
    stateHelper(`prepare_state_dir '${empty}'`);
    expect((await stat(empty)).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(empty, '.hestia-state'))).toBe(true);
  });

  it('leaves a folder with other things in it alone, warns, and keeps --purge away from it', async () => {
    const dir = path.join(home, 'shared', 'stuff');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await writeFile(path.join(dir, 'notes.txt'), 'mine');
    const { err } = stateHelper(`prepare_state_dir '${dir}'`);
    expect(err).toContain('不更改它的權限');
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect(existsSync(path.join(dir, '.hestia-state'))).toBe(false);
    // Later the API writes its state there; the folder still isn't ours.
    await writeFile(path.join(dir, 'registry.json'), '{}');
    expect(purgeVerdict(dir)).toMatch(/^refused: .*共用/);
  });
});

// Reading .env back: the same parser the service's --env-file uses, when a
// node is around; a plain last-KEY=-wins read when there is none.
function envGet(lines: string, key: string, env: Record<string, string> = {}): string {
  const envFile = path.join(home, 'read.env');
  const script = `set -euo pipefail\n${MESSAGES}eval "$(sed -n '/^env_get() {/,/^}/p' "$SCRIPT")"\nenv_get '${key}'`;
  execFileSync('bash', ['-c', `cat > '${envFile}'`], { input: lines });
  return execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: home, SCRIPT, ENV_FILE: envFile, ...env },
    encoding: 'utf8',
  });
}

describe('install.sh env_get', () => {
  const file = [
    'PLAIN=one',
    'PLAIN=two',
    'QUOTED="with spaces"',
    "SINGLE='a#b'",
    'export EXPORTED=yes',
    'COMMENTED=value # note',
    '',
  ].join('\n');

  it('reads a value as node --env-file does: quotes, export and comments included', () => {
    expect(envGet(file, 'PLAIN')).toBe('two');
    expect(envGet(file, 'QUOTED')).toBe('with spaces');
    expect(envGet(file, 'SINGLE')).toBe('a#b');
    expect(envGet(file, 'EXPORTED')).toBe('yes');
    expect(envGet(file, 'COMMENTED')).toBe('value');
    expect(envGet(file, 'MISSING')).toBe('');
  });

  it('falls back to the last KEY= line when no node can read it', () => {
    const noNode = { NODE_BIN: '/bin/false' };
    expect(envGet(file, 'PLAIN', noNode)).toBe('two');
    expect(envGet(file, 'MISSING', noNode)).toBe('');
  });
});

// The command's name in ~/.local/bin: --command-name, else .env, else hestia.
function commandName(envLines: string | null, option = ''): string {
  const envFile = path.join(home, 'name.env');
  if (envLines !== null) execFileSync('bash', ['-c', `cat > '${envFile}'`], { input: envLines });
  const pick = ['/^DEFAULT_COMMAND_NAME=/p', '/^die() /p', '/^env_get() {/,/^}/p', '/^command_name() {/,/^}/p'].join(';');
  const script = `set -euo pipefail\n${MESSAGES}C_BOLD= C_RED= C_RESET=\neval "$(sed -n '${pick}' "$SCRIPT")"\ncommand_name`;
  return execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: home, SCRIPT, ENV_FILE: envFile, OPT_COMMAND_NAME: option },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('install.sh --command-name', () => {
  it('is hestia unless named, and a re-run keeps the name .env holds', () => {
    expect(commandName(null)).toBe('hestia');
    expect(commandName('PORT=4792\n')).toBe('hestia');
    expect(commandName('HESTIA_COMMAND_NAME=hestia-dev\n')).toBe('hestia-dev');
    expect(commandName('HESTIA_COMMAND_NAME=hestia-dev\n', 'other')).toBe('other');
  });

  it('refuses anything but lowercase letters, digits and -', () => {
    for (const bad of ['Hestia', 'a b', '../x', 'a/b', 'a.b']) {
      expect(() => commandName(null, bad), bad).toThrow(/指令名稱/);
    }
    expect(() => commandName('HESTIA_COMMAND_NAME=../evil\n')).toThrow();
  });

  // The whole --uninstall, from a copy of the program in the temp HOME, on
  // the macOS module with stand-ins for launchctl and tailscale: it removes
  // the link .env names and leaves another backend's command alone.
  it('--uninstall removes the link of the name in .env, and only it', async () => {
    const app = path.join(home, 'app');
    await mkdir(path.join(app, 'scripts'), { recursive: true });
    await mkdir(path.join(app, 'bin'), { recursive: true });
    await writeFile(path.join(app, 'scripts', 'install.sh'), readFileSync(SCRIPT));
    await cp(path.join(API_DIR, 'scripts', 'install'), path.join(app, 'scripts', 'install'), { recursive: true });
    await cp(I18N_DIR, path.join(app, 'scripts', 'i18n'), { recursive: true });
    await writeFile(path.join(app, 'bin', 'hestia'), '#!/bin/sh\n');
    const state = path.join(home, 'state-dev');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(app, '.env'), `PORT=4999\nHESTIA_STATE_DIR=${state}\nHESTIA_COMMAND_NAME=hestia-dev\n`);
    const bin = path.join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    await symlink(path.join(app, 'bin', 'hestia'), path.join(bin, 'hestia-dev'));
    const other = path.join(home, 'other', 'bin', 'hestia');
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, '#!/bin/sh\n');
    await symlink(other, path.join(bin, 'hestia'));
    const PATH = await stubPath({ launchctl: 'exit 0', tailscale: 'echo "{}"' });
    const out = execFileSync('bash', [path.join(app, 'scripts', 'install.sh'), '--uninstall'], {
      env: { PATH, HOME: home, TMPDIR: home, HESTIA_INSTALL_PLATFORM: 'Darwin' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain(path.join(bin, 'hestia-dev'));
    expect(existsSync(path.join(bin, 'hestia-dev'))).toBe(false);
    expect(readlinkSync(path.join(bin, 'hestia'))).toBe(other);
    expect(existsSync(state)).toBe(true);
  });
});

// Where the settings go: DIR/.env in the state folder, with api/.env (here
// a stand-in in the temp HOME) a link to it.
function envHelper(envFile: string, call: string): { out: string; err: string } {
  const pick = ['/^die() /p', '/^place_env_file() {/,/^}/p'].join(';');
  const errFile = path.join(home, '.stderr');
  const script = `set -euo pipefail\n${MESSAGES}C_BOLD= C_RED= C_RESET=\neval "$(sed -n '${pick}' "$SCRIPT")"\n{\n${call}\n} 2>"$ERR_FILE"`;
  const out = execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: home, SCRIPT, ERR_FILE: errFile, ENV_FILE: envFile },
    encoding: 'utf8',
  });
  return { out, err: readFileSync(errFile, 'utf8') };
}

describe('install.sh keeps .env in the state folder', () => {
  let app: string;
  let envFile: string;
  let state: string;

  beforeEach(async () => {
    app = path.join(home, 'app');
    envFile = path.join(app, '.env');
    state = path.join(home, '.config', 'madera', 'hestia');
    await mkdir(app, { recursive: true });
    await mkdir(state, { recursive: true });
  });

  async function expectLinked(content: string): Promise<void> {
    expect(lstatSync(envFile).isSymbolicLink()).toBe(true);
    expect(readlinkSync(envFile)).toBe(path.join(state, '.env'));
    expect(readFileSync(path.join(state, '.env'), 'utf8')).toBe(content);
    expect((await stat(path.join(state, '.env'))).mode & 0o777).toBe(0o600);
  }

  it('a fresh install starts an empty .env there and links to it', async () => {
    envHelper(envFile, `place_env_file '${state}'`);
    await expectLinked('');
  });

  it('moves an older install’s api/.env there, settings and all', async () => {
    await writeFile(envFile, 'AUTH_USERNAME=me\n', { mode: 0o644 });
    envHelper(envFile, `place_env_file '${state}'`);
    await expectLinked('AUTH_USERNAME=me\n');
  });

  it('leaves a link that already leads there as it is', async () => {
    await writeFile(path.join(state, '.env'), 'AUTH_USERNAME=me\n', { mode: 0o600 });
    await symlink(path.join(state, '.env'), envFile);
    envHelper(envFile, `place_env_file '${state}'; place_env_file '${state}'`);
    await expectLinked('AUTH_USERNAME=me\n');
  });

  it('takes the settings along to a new state folder, keeping the old copy', async () => {
    const old = path.join(home, 'old-state');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, '.env'), 'AUTH_USERNAME=me\n');
    await symlink(path.join(old, '.env'), envFile);
    envHelper(envFile, `place_env_file '${state}'`);
    await expectLinked('AUTH_USERNAME=me\n');
    expect(existsSync(path.join(old, '.env'))).toBe(true);
  });

  it('refuses to choose between an api/.env file and one already in the state folder', async () => {
    await writeFile(envFile, 'AUTH_USERNAME=app\n');
    await writeFile(path.join(state, '.env'), 'AUTH_USERNAME=state\n');
    expect(() => envHelper(envFile, `place_env_file '${state}'`)).toThrow();
    expect(readFileSync(envFile, 'utf8')).toBe('AUTH_USERNAME=app\n');
    expect(readFileSync(path.join(state, '.env'), 'utf8')).toBe('AUTH_USERNAME=state\n');
  });
});

// A release bundle, as the one-line installer unpacks it: install.sh copied
// into a folder that has the marker and a prebuilt dist/, run with
// --deps-only --skip-build so nothing is fetched. It must stop there,
// writing nothing: no .env, no link, no unit.
describe('install.sh in a release bundle', () => {
  it('knows it is one, and --deps-only stops before any setup', async () => {
    const app = path.join(home, 'bundle');
    for (const dir of ['scripts', 'dist/src', 'dist/scripts', 'node_modules/express']) await mkdir(path.join(app, dir), { recursive: true });
    await writeFile(path.join(app, 'scripts', 'install.sh'), readFileSync(SCRIPT));
    // And its per-platform parts, which it sources (scripts/release-public.sh copies both).
    await cp(path.join(API_DIR, 'scripts', 'install'), path.join(app, 'scripts', 'install'), { recursive: true });
    // The bundle carries the script's text beside it (scripts/release-public.sh).
    await cp(I18N_DIR, path.join(app, 'scripts', 'i18n'), { recursive: true });
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ engines: { node: '>=18.0.0' } }));
    await writeFile(path.join(app, '.hestia-release'), 'v1.2.3\n');
    await writeFile(path.join(app, 'dist', 'src', 'main.js'), '');
    await writeFile(path.join(app, 'dist', 'scripts', 'write-env.js'), '');
    const out = execFileSync('bash', [path.join(app, 'scripts', 'install.sh'), '--deps-only', '--skip-build'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('版本 v1.2.3');
    expect(out).toContain('--deps-only');
    expect(execFileSync('bash', [path.join(app, 'scripts', 'install.sh'), '--help'], { env: { PATH: process.env.PATH ?? '', HOME: home, LANG: 'en_US.UTF-8' }, encoding: 'utf8' }))
      .toMatch(/^Usage: api\/scripts\/install\.sh \[options\]/);
    expect(existsSync(path.join(app, '.env'))).toBe(false);
    expect(existsSync(path.join(home, '.local', 'bin', 'hestia'))).toBe(false);
    expect(existsSync(path.join(home, '.config', 'systemd'))).toBe(false);
    expect(existsSync(path.join(home, 'Library', 'LaunchAgents'))).toBe(false);
  });
});

// The per-platform modules (scripts/install/platform-*.sh): which one is
// picked, and each one's pieces, sourced on their own with the helpers they
// lean on stubbed. Nothing here talks to the real systemd, launchd or
// Tailscale: the programs they call are stand-ins on PATH.
const PLATFORM_DIR = path.join(API_DIR, 'scripts', 'install');
const STUBS = 'have() { command -v "$1" >/dev/null 2>&1; }\ndie() { printf \'DIE %s\\n\' "$*"; exit 1; }\nwarn() { printf \'WARN %s\\n\' "$*"; }\nnote() { printf \'NOTE %s\\n\' "$*"; }\nok() { printf \'OK %s\\n\' "$*"; }\nsay() { printf \'%s\\n\' "$*"; }\nlink() { printf \'LINK %s\\n\' "$*"; }\nrun_quiet() { shift; "$@"; }\nUNIT_MARKER="# Written by Hestia scripts/install.sh"\n';

/** Puts executable stand-ins (name → script body) in a folder and returns a PATH starting with it. */
async function stubPath(stubs: Record<string, string>): Promise<string> {
  const dir = path.join(home, 'stub-bin');
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(dir, name), 0o755);
  }
  return `${dir}:${process.env.PATH ?? ''}`;
}

function platformShell(platform: 'linux' | 'darwin', call: string, env: Record<string, string> = {}): string {
  const script = `set -euo pipefail\n${MESSAGES}${STUBS}LOG_FILE="$HOME/install.log"\n. '${PLATFORM_DIR}/platform-${platform}.sh'\n${call}`;
  return execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', HOME: home, USER: 'me', ...env }, encoding: 'utf8' });
}

describe('install.sh picks one platform module', () => {
  const status = (system: string) => {
    try {
      execFileSync('bash', [SCRIPT, '--status'], { env: { PATH: process.env.PATH ?? '', HOME: home, LANG: 'en_US.UTF-8', HESTIA_INSTALL_PLATFORM: system }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return '';
    } catch (error) {
      return String((error as { stderr?: string }).stderr);
    }
  };

  it('sends native Windows to WSL, and names any other system it can’t run on', () => {
    expect(status('MINGW64_NT-10.0-26100')).toContain('Install WSL');
    expect(status('Windows_NT')).toContain('Install WSL');
    expect(status('SunOS')).toMatch(/This system \(.*\) isn't supported/);
  });

  it('has a module for Linux and for macOS defining the functions install.sh lists', () => {
    const lines = readFileSync(SCRIPT, 'utf8').split('\n');
    // The interface, listed once in install.sh's platform section.
    const listed = lines.flatMap((line) => /^#\s+(platform_[a-z0-9_]+)\s/.exec(line)?.[1] ?? []).sort();
    expect(listed.length).toBeGreaterThan(10);
    const defined = (platform: string) => readFileSync(path.join(PLATFORM_DIR, `platform-${platform}.sh`), 'utf8')
      .split('\n').flatMap((line) => /^(platform_[a-z0-9_]+)\(\) \{/.exec(line)?.[1] ?? []).sort();
    expect(defined('linux')).toEqual(listed);
    expect(defined('darwin')).toEqual(listed);
    // install.sh calls nothing outside the list.
    const called = new Set(lines.filter((line) => !/^\s*#/.test(line)).flatMap((line) => line.match(/\bplatform_[a-z0-9_]+/g) ?? []));
    expect(called.size).toBeGreaterThan(10);
    for (const name of called) expect(listed, name).toContain(name);
  });
});

describe('install.sh on Linux (platform-linux.sh)', () => {
  it('names the systemd unit after --service-name, and refuses a name systemd would not take', () => {
    expect(platformShell('linux', 'platform_service_configure hestia-api; printf "%s|%s" "$SERVICE_NAME" "$SERVICE_FILE"'))
      .toBe(`hestia-api.service|${path.join(home, '.config', 'systemd', 'user', 'hestia-api.service')}`);
    expect(platformShell('linux', 'platform_service_configure second.service; printf %s "$SERVICE_NAME"')).toBe('second.service');
    expect(() => platformShell('linux', 'platform_service_configure "a b"')).toThrow();
  });

  it('writes the unit as before: our marker, the absolute node, and KillMode=process', () => {
    const unit = platformShell('linux', `platform_service_configure hestia-api; API_DIR=/opt/hestia/api NODE_BIN='/n/node' PATH='/usr/bin:/bin'; write_unit; cat "$SERVICE_FILE"; printf 'WD=%s' "$(platform_service_working_dir)"`);
    expect(unit).toMatch(/^# Written by Hestia scripts\/install\.sh \(\/opt\/hestia\/api\/scripts\/install\.sh\)/);
    expect(unit).toContain('ExecStart="/n/node" --env-file=.env dist/src/main.js\n');
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"\n');
    expect(unit).toContain('KillMode=process\n');
    expect(unit).toContain('WD=/opt/hestia/api');
  });

  it('reads its log with journalctl and downloads the Linux Node.js', () => {
    expect(platformShell('linux', 'platform_service_configure x; platform_service_follow_command; echo; platform_node_os')).toBe('journalctl --user -u x.service -f\nlinux');
  });
});

describe('install.sh on macOS (platform-darwin.sh)', () => {
  it('names the LaunchAgent me.maderaojen.<name>, with its log under ~/Library/Logs', () => {
    expect(platformShell('darwin', 'platform_service_configure hestia-api; printf "%s|%s|%s" "$SERVICE_NAME" "$SERVICE_FILE" "$SERVICE_LOG"'))
      .toBe(`me.maderaojen.hestia-api|${path.join(home, 'Library', 'LaunchAgents', 'me.maderaojen.hestia-api.plist')}|${path.join(home, 'Library', 'Logs', 'Hestia', 'hestia-api.log')}`);
    expect(platformShell('darwin', 'platform_service_configure me.maderaojen.second.service; printf %s "$SERVICE_NAME"')).toBe('me.maderaojen.second');
    expect(() => platformShell('darwin', 'platform_service_configure "a b"')).toThrow();
  });

  it('writes a LaunchAgent that keeps the tmux server when it stops, escaped for XML', async () => {
    // plutil is macOS's; elsewhere a stand-in that accepts anything. A
    // function, not a stub on PATH: the call below sets PATH itself.
    const plutilStandIn = process.platform === 'darwin' ? '' : 'plutil() { return 0; }; ';
    const plist = platformShell('darwin', `${plutilStandIn}platform_service_configure hestia-api; API_DIR='/opt/a&b--c' NODE_BIN='/n/node' PATH='/usr/bin:/bin'; write_plist; cat "$SERVICE_FILE"`);
    expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!-- # Written by Hestia scripts\/install\.sh \(\/opt\/a&amp;b- -c\/scripts\/install\.sh\)/);
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<string>/opt/a&amp;b--c</string>');
    expect(plist).toContain('<string>/n/node</string>\n    <string>--env-file=.env</string>\n    <string>dist/src/main.js</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin</string>');
    // launchd gives an agent no locale (tmux would print a tab as "_"): the installer's UTF-8 one, else en_US.UTF-8.
    expect(plist).toMatch(/<key>LANG<\/key>\n {4}<string>[^<]*\.UTF-8<\/string>/i);
    expect(platformShell('darwin', 'LC_ALL=; LANG=zh_TW.UTF-8; service_lang')).toBe('zh_TW.UTF-8');
    expect(platformShell('darwin', 'LC_ALL=; LANG=C; service_lang')).toBe('en_US.UTF-8');
    if (process.platform === 'darwin') {
      // Valid (write_plist lints it), and read back unescaped.
      expect(platformShell('darwin', 'platform_service_configure hestia-api; printf %s "$(platform_service_working_dir)"')).toBe('/opt/a&b--c');
    }
  });

  // `launchctl print gui/<uid>/<label>` as macOS 26.7 prints it (trimmed).
  const printed = (state: string, last: string) => `gui/501/me.maderaojen.hestia-api = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/me.maderaojen.hestia-api.plist\n\ttype = LaunchAgent\n\tstate = ${state}\n\n\tprogram = /n/node\n\tlast exit code = ${last}\n\n\tspawn type = daemon (3)\n\tjobs = {\n\t\tstate = active\n\t}\n}`;

  it('reads the agent’s state from launchctl: missing, unloaded, running, stopped or failed', async () => {
    const state = async (launchctl: string, plist = true) => {
      const PATH = await stubPath({ launchctl });
      return platformShell('darwin', `platform_service_configure hestia-api; ${plist ? 'mkdir -p "${SERVICE_FILE%/*}"; : >"$SERVICE_FILE"; ' : ''}launchd_job_state`, { PATH });
    };
    expect(await state('exit 0', false)).toBe('missing');
    expect(await state('echo "Could not find service" >&2; exit 113')).toBe('unloaded');
    expect(await state(`cat <<'EOF'\n${printed('running', '(never exited)')}\nEOF`)).toBe('running');
    expect(await state(`cat <<'EOF'\n${printed('not running', '0')}\nEOF`)).toBe('stopped');
    expect(await state(`cat <<'EOF'\n${printed('not running', '78: EX_CONFIG')}\nEOF`)).toBe('failed');
  });

  it('installs by booting a loaded agent out and bootstrapping it again, never touching tmux', async () => {
    const log = path.join(home, 'launchctl.calls');
    // Loaded until booted out.
    const PATH = await stubPath({
      launchctl: `echo "$*" >>'${log}'\ncase "$1" in\n  print) [ -e '${log}.out' ] && exit 113; [ "$2" = gui/$(id -u) ] && exit 0; printf '\\tstate = running\\n' ;;\n  bootout) : >'${log}.out' ;;\nesac\nexit 0`,
      plutil: 'exit 0',
    });
    platformShell('darwin', 'platform_service_configure hestia-api; API_DIR=/opt/h NODE_BIN=/n/node; platform_service_install', { PATH });
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter((call) => !call.startsWith('print'));
    expect(calls).toEqual([
      `enable gui/${uid}/me.maderaojen.hestia-api`,
      `bootout gui/${uid}/me.maderaojen.hestia-api`,
      `bootstrap gui/${uid} ${path.join(home, 'Library', 'LaunchAgents', 'me.maderaojen.hestia-api.plist')}`,
    ]);
  });

  it('has no linger to turn on: it says how the Mac stays reachable instead', async () => {
    const PATH = await stubPath({ defaults: 'exit 1', fdesetup: 'echo true', pmset: "printf ' sleep                10\\n'" });
    const out = platformShell('darwin', 'LINGER=0 platform_keep_running', { PATH, LANG: 'en_US.UTF-8' });
    expect(out).toContain('FileVault is on');
    expect(out).toContain('sleeps after 10 minutes');
    const auto = await stubPath({ defaults: 'echo me', fdesetup: 'echo false', pmset: "printf ' sleep                0\\n'" });
    expect(platformShell('darwin', 'LINGER=1 platform_keep_running', { PATH: auto, LANG: 'en_US.UTF-8' })).toBe('OK Automatic login is on for me: after a restart the backend starts again by itself\n');
  });

  it('uses only the Tailscale app, and stops with what to install when there is none', async () => {
    const PATH = await stubPath({ tailscale: 'exit 0' });
    expect(platformShell('darwin', 'platform_tailscale_pick; printf %s "${TS_CMD[0]}"', { PATH })).toBe(path.join(home, 'stub-bin', 'tailscale'));
    // die (a stand-in here) exits the subshell: what it said is the output.
    expect(platformShell('darwin', 'TS_MAC_APP_CLI=/nonexistent; PATH=/usr/bin:/bin; platform_tailscale_pick || (platform_tailscale_provide) || true', { LANG: 'en_US.UTF-8' }))
      .toMatch(/^DIE Tailscale isn't installed\. On macOS, install the Tailscale app/);
  });

  it.skipIf(!existsSync('/usr/bin/shasum'))('checks downloads with shasum', async () => {
    await writeFile(path.join(home, 'f'), 'hi\n');
    const sum = execFileSync('shasum', ['-a', '256', path.join(home, 'f')], { encoding: 'utf8' }).split(' ')[0];
    expect(platformShell('darwin', `cd "$HOME"; printf '%s  f\\n' '${sum}' | platform_sha256_check && echo good`)).toBe('good\n');
    expect(() => platformShell('darwin', `cd "$HOME"; printf '%s  f\\n' '${'0'.repeat(64)}' | platform_sha256_check 2>/dev/null`)).toThrow();
  });
});
