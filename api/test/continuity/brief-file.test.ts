import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_BRIEF_MAX_BYTES } from '../../src/contract/continuity.js';
import { readHandoffBrief, wholeCharacters } from '../../src/continuity/brief-file.js';

let cwd: string;
let outside: string;
const dir = () => path.join(cwd, '.hestia', 'handoffs');
const NAME = '20261010-073000Z-1a2b3c4d.md';

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'brief-file-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'brief-outside-'));
  await mkdir(dir(), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('readHandoffBrief', () => {
  it('reads the stored file', async () => {
    await writeFile(path.join(dir(), NAME), '# 交接\n目標');
    const result = await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' });
    expect(result).toMatchObject({ ok: true, file: `.hestia/handoffs/${NAME}`, content: '# 交接\n目標', truncated: false, size: Buffer.byteLength('# 交接\n目標') });
  });

  it('without a stored file, finds the one ending in the short id, skipping an old .conversation.md', async () => {
    await writeFile(path.join(dir(), NAME), 'brief');
    await writeFile(path.join(dir(), '20261010-073000Z-1a2b3c4d.conversation.md'), 'old copy');
    expect(await readHandoffBrief(cwd, { briefFile: null, shortId: '1a2b3c4d' })).toMatchObject({ ok: true, content: 'brief' });
  });

  it('two files ending in the short id: refused', async () => {
    await writeFile(path.join(dir(), NAME), 'one');
    await writeFile(path.join(dir(), '20261011-000000Z-1a2b3c4d.md'), 'two');
    expect(await readHandoffBrief(cwd, { briefFile: null, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('missing: the file, the folder, or the working folder itself', async () => {
    expect(await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'missing' });
    expect(await readHandoffBrief(cwd, { briefFile: null, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'missing' });
    await rm(path.join(cwd, '.hestia'), { recursive: true });
    expect(await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'missing' });
    expect(await readHandoffBrief(path.join(cwd, 'gone'), { briefFile: null, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['a path that climbs out', '.hestia/handoffs/../../secret.md'],
    ['a deeper path', '.hestia/handoffs/sub/x.md'],
    ['another folder', '.hestia/other/x.md'],
    ['an absolute path', '/etc/passwd.md'],
    ['a hidden name', '.hestia/handoffs/.x.md'],
    ['not markdown', `.hestia/handoffs/${NAME.replace('.md', '.txt')}`],
    ['a backslash', '.hestia\\handoffs\\..\\x.md'],
  ])('never trusts a stored name blindly: %s', async (_name, briefFile) => {
    expect(await readHandoffBrief(cwd, { briefFile, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('the brief itself a symlink: refused', async () => {
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    await symlink(path.join(outside, 'secret.md'), path.join(dir(), NAME));
    expect(await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('handoffs a symlink to somewhere else: refused', async () => {
    await rm(dir(), { recursive: true });
    await writeFile(path.join(outside, NAME), 'elsewhere');
    await symlink(outside, dir());
    expect(await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('.hestia a symlink: refused', async () => {
    await rm(path.join(cwd, '.hestia'), { recursive: true });
    await mkdir(path.join(outside, 'handoffs'), { recursive: true });
    await writeFile(path.join(outside, 'handoffs', NAME), 'elsewhere');
    await symlink(outside, path.join(cwd, '.hestia'));
    expect(await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('a folder by the brief\'s name: refused', async () => {
    await mkdir(path.join(dir(), NAME));
    expect((await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).ok).toBe(false);
  });

  it('a working folder reached through a symlink is fine', async () => {
    await writeFile(path.join(dir(), NAME), 'ok');
    const link = path.join(outside, 'link');
    await symlink(cwd, link);
    expect(await readHandoffBrief(link, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' })).toMatchObject({ ok: true, content: 'ok' });
  });

  it('only the first 512 KiB, cut on a whole character', async () => {
    // Three-byte characters straddling the limit.
    const text = 'a'.repeat(HANDOFF_BRIEF_MAX_BYTES - 1) + '交接交接';
    await writeFile(path.join(dir(), NAME), text);
    const result = await readHandoffBrief(cwd, { briefFile: `.hestia/handoffs/${NAME}`, shortId: '1a2b3c4d' });
    expect(result.ok && result.truncated).toBe(true);
    expect(result.ok && result.content).toBe('a'.repeat(HANDOFF_BRIEF_MAX_BYTES - 1));
    expect(result.ok && result.size).toBe(Buffer.byteLength(text));
  });
});

describe('wholeCharacters', () => {
  it.each([
    ['ascii', Buffer.from('abc'), 3],
    ['a whole three-byte character', Buffer.from('a交'), 4],
    ['a cut three-byte character', Buffer.from('a交').subarray(0, 3), 1],
    ['a cut four-byte character', Buffer.from('a😀').subarray(0, 4), 1],
    ['empty', Buffer.alloc(0), 0],
  ])('%s', (_name, bytes, expected) => {
    expect(wholeCharacters(bytes)).toBe(expected);
  });
});
