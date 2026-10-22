import { describe, expect, it } from 'vitest';
import { clipDetail, DETAIL_MAX_CHARS } from '../../src/process/text.js';

describe('clipDetail', () => {
  it('cuts a long field and says how big it was', () => {
    const output = '字'.repeat(DETAIL_MAX_CHARS + 10);
    const detail = clipDetail({ input: 'ls', output, exitCode: 2 });
    expect(detail.output).toHaveLength(DETAIL_MAX_CHARS);
    expect(detail).toMatchObject({ input: 'ls', exitCode: 2, truncated: true, originalBytes: Buffer.byteLength(output) });
  });

  it('leaves short fields alone', () => {
    expect(clipDetail({ output: 'ok' })).toEqual({ output: 'ok', truncated: false });
  });
});
