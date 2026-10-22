import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createUsageAnalytics } from '../../src/usage-analytics/service.js';
import { createUsageAnalyticsRouter } from '../../src/usage-analytics/router.js';

describe('analytics transport validation', () => {
  it('accepts day timezone without summary range and rejects unknown facet filters', async () => {
    const service = createUsageAnalytics({ dbPath: ':memory:', discoverSources: async () => ({ sources: [], warnings: [] }) });
    const app = express(); app.use('/api/usage-analytics', createUsageAnalyticsRouter(service));
    const result = await request(app).get('/api/usage-analytics/days/2026-10-05?timezone=Asia%2FTaipei');
    expect(result.status).toBe(200); expect(result.body.date).toBe('2026-10-05');
    const invalid = await request(app).get('/api/usage-analytics/summary?from=2026-10-04&to=2026-10-06&timezone=UTC&accountId=unknown');
    expect(invalid.status).toBe(400);
    expect((await request(app).get('/api/usage-analytics/days/2026-02-30?timezone=UTC')).status).toBe(400);
    service.close();
  });
});
