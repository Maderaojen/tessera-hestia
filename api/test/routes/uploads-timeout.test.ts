import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/registry.js', () => ({ getSession: vi.fn(async () => ({ id: 'sess-1' })) }));
afterEach(() => { vi.unstubAllEnvs(); });

describe('upload deadline', () => {
  it.each([false, true])('cancels stalled uploads and admits a subsequent upload (file started: %s)', async (fileStarted) => {
    vi.resetModules();
    vi.stubEnv('HESTIA_UPLOAD_TIMEOUT_MS', '40');
    vi.stubEnv('HESTIA_UPLOAD_CONCURRENCY', '1');
    const { createApp } = await import('../../src/server.js');
    const { issueSessionToken } = await import('../../src/auth.js');
    const auth = `Bearer ${issueSessionToken()}`;
    const app = createApp();
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = httpRequest({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
      method: 'POST', path: '/api/sessions/sess-1/uploads', headers: { Authorization: auth, 'Content-Type': 'multipart/form-data; boundary=stalled' } });
    try {
      const aborted = new Promise<void>((resolve) => client.once('error', () => resolve()));
      client.write(fileStarted ? '--stalled\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\npartial' : '--stalled\r\nContent-Dispo');
      await aborted;
      let status = 429;
      for (let attempt = 0; attempt < 40; attempt++) {
        status = (await request(app).post('/api/sessions/sess-1/uploads').set('Authorization', auth)).status;
        if (status !== 429) break;
        await delay(5);
      }
      expect(status).toBe(400);
    } finally { client.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
