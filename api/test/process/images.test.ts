import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROCESS_IMAGE_MAX_BYTES } from '../../src/contract/process.js';
import { claudeItemDetail, claudeItemImages, claudeProcessTurns } from '../../src/process/claude.js';
import { codexItemDetail, codexItemImages, codexProcessTurns } from '../../src/process/codex.js';
import { loadProcessImage, ProcessImageError, sniffImage } from '../../src/process/images.js';

// A private key's first line, put together so the file itself holds none
// (the public release's scan stops on one).
const KEY_HEADER = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');

// Real signatures, made-up rest.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ProcessImageError) return error.code;
    throw error;
  }
}

describe('sniffImage', () => {
  it('knows PNG, JPEG, GIF and WebP by their bytes, and nothing else', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from(KEY_HEADER))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('loadProcessImage', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'process-images-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('serves a result\'s own image by what its bytes are', async () => {
    expect(await loadProcessImage({ source: 'result', data: PNG.toString('base64') })).toEqual({ type: 'image/png', bytes: PNG });
    expect(await code(loadProcessImage({ source: 'result', data: SVG.toString('base64') }))).toBe('unsupported_media');
    expect(await code(loadProcessImage({ source: 'result', data: 'A'.repeat(Math.ceil(PROCESS_IMAGE_MAX_BYTES / 3) * 4 + 8) }))).toBe('too_large');
  });

  it('serves a file the transcript names, inside a project or not', async () => {
    const file = path.join(dir, 'shot.png');
    await writeFile(file, PNG);
    expect(await loadProcessImage({ source: 'file', path: file })).toEqual({ type: 'image/png', bytes: PNG });
    // Through a symlink: what it points at is what is read and checked.
    await symlink(file, path.join(dir, 'link.png'));
    expect((await loadProcessImage({ source: 'file', path: path.join(dir, 'link.png') })).type).toBe('image/png');
  });

  it('refuses a file that only looks like an image, isn\'t a regular file, or is gone', async () => {
    await writeFile(path.join(dir, 'secret.png'), KEY_HEADER);
    expect(await code(loadProcessImage({ source: 'file', path: path.join(dir, 'secret.png') }))).toBe('unsupported_media');
    await mkdir(path.join(dir, 'folder.png'));
    expect(await code(loadProcessImage({ source: 'file', path: path.join(dir, 'folder.png') }))).toBe('not_file');
    expect(await code(loadProcessImage({ source: 'file', path: '/dev/zero' }))).toBe('not_file');
    expect(await code(loadProcessImage({ source: 'file', path: path.join(dir, 'gone.png') }))).toBe('missing');
    expect(await code(loadProcessImage({ source: 'file', path: 'relative/shot.png' }))).toBe('missing');
  });

  it('refuses a sensitive path, named directly or reached through a symlink', async () => {
    const keys = path.join(dir, '.ssh');
    await mkdir(keys);
    await writeFile(path.join(keys, 'shot.png'), PNG);
    expect(await code(loadProcessImage({ source: 'file', path: path.join(keys, 'shot.png') }))).toBe('blocked');
    await symlink(path.join(keys, 'shot.png'), path.join(dir, 'innocent.png'));
    expect(await code(loadProcessImage({ source: 'file', path: path.join(dir, 'innocent.png') }))).toBe('blocked');
  });
});

describe('process item images from transcripts', () => {
  it('lists a Claude tool result\'s images and gives them back by item', () => {
    const CWD = '/work/demo';
    const records = [
      { type: 'user', uuid: 'u1', cwd: CWD, timestamp: '2026-10-18T01:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '看一下截圖' } },
      { type: 'assistant', uuid: 't1', cwd: CWD, timestamp: '2026-10-18T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${CWD}/shot.png` } }], stop_reason: 'tool_use' } },
      { type: 'user', uuid: 'r1', cwd: CWD, timestamp: '2026-10-18T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] } },
      { type: 'assistant', uuid: 'a1', cwd: CWD, timestamp: '2026-10-18T01:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '看到了。' }], stop_reason: 'end_turn' } },
    ];
    const [turn] = claudeProcessTurns(records);
    expect(claudeItemDetail(records, turn!, 'toolu_1')?.images).toEqual([{ index: 0, source: 'result', name: null }]);
    expect(claudeItemImages(records, turn!, 'toolu_1')).toEqual([{ source: 'result', data: PNG.toString('base64') }]);
    expect(claudeItemImages(records, turn!, 'toolu_2')).toBeNull();
  });

  it('lists the file a Codex view_image looked at', () => {
    const at = (s: number) => `2026-10-18T02:00:${String(s).padStart(2, '0')}.000Z`;
    const records = [
      { timestamp: at(0), type: 'session_meta', payload: { id: 'x', cwd: '/work/demo' } },
      { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看圖' }] } },
      { timestamp: at(3), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ImageView', id: 'view-1', path: 'file:///tmp/screens/shot.png' } } },
      { timestamp: at(4), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '看到了' }] } },
      { timestamp: at(5), type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    const [turn] = codexProcessTurns(records);
    expect(codexItemDetail(records, turn!, 'view-1')?.images).toEqual([{ index: 0, source: 'file', name: 'shot.png' }]);
    expect(codexItemImages(records, turn!, 'view-1')).toEqual([{ source: 'file', path: '/tmp/screens/shot.png' }]);
  });
});
