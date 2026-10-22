import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATE_DIR } from '../src/config.js';
import type { FileGuardError } from '@maderaojen/fs-guard';
import { resolveInsideRoot } from '../src/files/repo-paths.js';

let root: string;
let elsewhere: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hestia-root-')));
  elsewhere = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hestia-elsewhere-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), 'a');
  symlinkSync(elsewhere, path.join(root, 'out'));
  symlinkSync(path.join(root, 'src'), path.join(root, 'in'));
  mkdirSync(STATE_DIR, { recursive: true });
  symlinkSync(STATE_DIR, path.join(root, 'state'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

async function code(relative: string, base = root): Promise<string> {
  try {
    await resolveInsideRoot(base, relative);
    return 'ok';
  } catch (error) {
    return (error as FileGuardError).code;
  }
}

describe('resolveInsideRoot', () => {
  it('answers a path under the root, normalised', async () => {
    expect(await resolveInsideRoot(root, 'src/./a.ts')).toEqual({ absolute: path.join(root, 'src/a.ts'), relative: 'src/a.ts', exists: true });
    expect(await resolveInsideRoot(root, 'build/')).toMatchObject({ relative: 'build', exists: false });
    expect(await resolveInsideRoot(root, '')).toMatchObject({ relative: '', exists: true });
  });

  it('a path that no longer exists is checked by what is left of it', async () => {
    expect(await resolveInsideRoot(root, 'src/deleted/deep.ts')).toMatchObject({ relative: 'src/deleted/deep.ts', exists: false });
    // …which still can't lead out through a symlink.
    expect(await code('out/deleted.ts')).toBe('outside');
  });

  it('refuses .., absolute paths, NUL, any .git, a symlink out', async () => {
    for (const relative of ['../x', 'src/../../x', '/etc/passwd', 'a\0b', '.git', 'src/.git/config', '.GIT/HEAD', 'out', 'out/file']) {
      expect([relative, await code(relative)]).toEqual([relative, 'outside']);
    }
    expect(await code('in/a.ts')).toBe('ok');
  });

  it('never reaches the backend\'s own state, by any route', async () => {
    // A project path that happens to hold the state folder: by name, and by
    // a symlink to it from inside the same project path.
    const parent = realpathSync(path.dirname(STATE_DIR));
    const alias = path.join(parent, `hestia-alias-${process.pid}`);
    symlinkSync(STATE_DIR, alias);
    try {
      expect(await code(path.join(path.basename(STATE_DIR), 'auth.json'), parent)).toBe('forbidden');
      expect(await code(path.join(path.basename(alias), 'auth.json'), parent)).toBe('forbidden');
    } finally {
      // The link itself: Node 24's rmSync refuses a link to a folder.
      unlinkSync(alias);
    }
    // From a project path elsewhere, a link to it just leads out.
    expect(await code('state/auth.json')).toBe('outside');
  });
});
