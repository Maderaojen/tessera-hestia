import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server.js';

// Exercise the composition root: an isolated router cannot prove that
// private usage is protected by the host's authentication boundary.
describe('usage analytics authentication boundary', () => {
  const app = createApp();
  it.each([
    '/api/usage-analytics/facets',
    '/api/usage-analytics/summary?from=2026-10-04&to=2026-10-06&timezone=UTC',
    '/api/usage-analytics/days/2026-10-05?timezone=UTC',
  ])('rejects unauthenticated reads of %s', async (url) => {
    expect((await request(app).get(url)).status).toBe(401);
  });
  it('rejects an unauthenticated refresh before starting collection', async () => {
    expect((await request(app).post('/api/usage-analytics/refresh').send({})).status).toBe(401);
  });
});
