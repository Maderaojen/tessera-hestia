import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachmentById, attachmentForPath, attachmentsInText, extensionFor, mimeFor, safeUploadName, withPromptText } from '../src/attachments.js';
import { UPLOADS_DIR } from '../src/config.js';
import { publicTurns } from '../src/session-dto.js';

describe('attachments', () => {
  it('names an upload by its folder and file, never anything that could leave UPLOADS_DIR', () => {
    expect(attachmentById('sess-1/abc.png')).toEqual({ id: 'sess-1/abc.png', kind: 'image', url: '/sessions/sess-1/uploads/abc.png' });
    expect(attachmentById('notes/abc.webp')?.url).toBe('/notes/uploads/abc.webp');
    for (const bad of ['../x.png', 'a/../../b.png', 'sess-1/abc.exe', 'sess-1/abc', 'a/b/c.png', '/abc.png', 'sess 1/abc.png']) {
      expect(attachmentById(bad), bad).toBeNull();
    }
  });

  it('reads a path it handed out by its last two segments, wherever UPLOADS_DIR was then', () => {
    expect(attachmentForPath('/old/home/state/uploads/notes/n.jpg')?.id).toBe('notes/n.jpg');
    expect(attachmentForPath('/etc/passwd')).toBeNull();
    // A file's own folder wins, even when its name ends like an image's.
    expect(attachmentForPath('/s/uploads/sess-1/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/x.png')).toMatchObject({ kind: 'file', name: 'x.png' });
  });

  it('names any other file by its own folder and name, never under notes', () => {
    const id = 'sess-1/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/季報.pdf';
    expect(attachmentById(id)).toEqual({
      id, kind: 'file', name: '季報.pdf', url: `/sessions/sess-1/uploads/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/${encodeURIComponent('季報.pdf')}`,
    });
    for (const bad of ['notes/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/a.pdf', 'sess-1/abc/a.pdf', 'sess-1/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/.env', 'sess-1/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/a b.pdf']) {
      expect(attachmentById(bad), bad).toBeNull();
    }
  });

  it('keeps a file\'s name safe for a path: no spaces, quotes or leading dots', () => {
    expect(safeUploadName('季報 (final).pdf')).toBe('季報_final_.pdf');
    expect(safeUploadName('../../.bashrc')).toBe('bashrc');
    expect(safeUploadName('"; rm -rf ~')).toBe('rm_-rf_');
    expect(safeUploadName('')).toBe('file');
    const long = safeUploadName(`${'a'.repeat(200)}.tar.gz`);
    expect([...long].length).toBe(120);
    expect(long.endsWith('.gz')).toBe(true);
  });

  it('hands the CLI the path on this machine alone', () => {
    expect(withPromptText(attachmentById('notes/n.png')!).promptText).toBe(path.join(UPLOADS_DIR, 'notes/n.png'));
  });

  it('finds bare paths into UPLOADS_DIR, a file\'s too, and nothing outside it', () => {
    const image = path.join(UPLOADS_DIR, 'sess-1/a.png');
    const file = path.join(UPLOADS_DIR, 'sess-1/0b7e5a52-8d3f-4c1e-9a6b-2f4d5e6a7b8c/季報.pdf');
    const text = `看這兩個\n\n${image}\n${file}\n/elsewhere/uploads/sess-1/b.png`;
    const found = attachmentsInText(text);
    expect(found.map((attachment) => [attachment.kind, text.slice(attachment.start, attachment.end)])).toEqual([['image', image], ['file', file]]);
    // The old wording is still read, and a path in it counted once.
    expect(attachmentsInText(`請看這張圖片：${image}`).map(({ start }) => start)).toEqual(['請看這張圖片：'.length]);
  });

  it('keeps one table of image types', () => {
    expect(extensionFor('image/jpeg')).toBe('.jpg');
    expect(mimeFor('X.HEIC')).toBe('image/heic');
    expect(mimeFor('x.gif')).toBeUndefined();
  });

  it('finds the uploads a message refers to, and where each path sits in it', () => {
    const text = '看一下\n請看這張圖片：/s/uploads/sess-1/a.png。還有請看這張圖片：/s/uploads/notes/b.jpg';
    const found = attachmentsInText(text);
    expect(found.map((attachment) => attachment.id)).toEqual(['sess-1/a.png', 'notes/b.jpg']);
    expect(found.map(({ start, end }) => text.slice(start, end))).toEqual(['/s/uploads/sess-1/a.png', '/s/uploads/notes/b.jpg']);
    expect(attachmentsInText('請看這張圖片：/etc/passwd')).toEqual([]);
  });

  it('turns as sent carry each message\'s attachments, followUps too', () => {
    const [turn] = publicTurns([{
      index: 1,
      user: { text: '請看這張圖片：/s/uploads/sess-1/a.png', at: null },
      followUps: [{ text: 'no image', at: null }],
      assistant: { text: 'ok', at: null },
    }]);
    expect(turn?.user.attachments?.map((attachment) => attachment.id)).toEqual(['sess-1/a.png']);
    expect(turn?.followUps?.[0]?.attachments).toEqual([]);
  });
});
