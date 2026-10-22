import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('refuses root test discovery before any archived test can load', async () => {
  const config = fileURLToPath(new URL('../../vitest.config.mjs', import.meta.url));
  await expect(promisify(execFile)(process.execPath, [config])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Root test discovery is disabled'),
  });
});
