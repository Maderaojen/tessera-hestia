import { Router, type Request } from 'express';
import type { UsageQuery } from '../contract/usage-analytics.js';
import { sendError } from '../routes/errors.js';
import { validateUsageQuery, type UsageAnalyticsService } from './service.js';
import { usageAnalytics } from './wiring.js';

function queryOf(req: Request, day?: string): UsageQuery {
  const raw = req.query;
  const get = (key: string, required = false): string | undefined => {
    const value = raw[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string') throw new Error('invalid_query');
    return value;
  };
  const query = { from: day ?? get('from', true)!, to: day ? new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10) : get('to', true)!, timezone: get('timezone', true)!, accountId: get('accountId'), provider: get('provider'), projectId: get('projectId'), tmuxId: get('tmuxId') };
  validateUsageQuery(query);
  return query;
}
export function createUsageAnalyticsRouter(service: UsageAnalyticsService = usageAnalytics): Router {
  const router = Router();
  router.get('/facets', async (_req, res) => {
    try { res.json(await service.facets()); } catch { sendError(res, 503, 'internal_error', 'usage analytics can\'t be read right now'); }
  });
  router.get('/summary', async (req, res) => {
    let query: UsageQuery;
    try { query = queryOf(req); } catch { sendError(res, 400, 'invalid_request', 'invalid usage analytics query'); return; }
    try { res.json(await service.summary(query)); } catch (error) { if (error instanceof Error && error.message === 'unknown_filter') sendError(res, 400, 'invalid_request', 'no such usage analytics filter'); else sendError(res, 503, 'internal_error', 'usage analytics can\'t be read right now'); }
  });
  router.get('/days/:date', async (req, res) => {
    let query: UsageQuery;
    const date = req.params.date;
    try { query = queryOf(req, date); validateUsageQuery(query); }
    catch { sendError(res, 400, 'invalid_request', 'invalid usage analytics date or query'); return; }
    try { res.json(await service.day(date, query)); } catch (error) { if (error instanceof Error && error.message === 'unknown_filter') { sendError(res, 400, 'invalid_request', 'no such usage analytics filter'); return; } sendError(res, 503, 'internal_error', 'usage analytics can\'t be read right now'); }
  });
  router.post('/refresh', (_req, res) => {
    try { const task = service.refresh(); void task.catch(() => {}); res.status(202).json(service.state()); }
    catch { sendError(res, 503, 'internal_error', 'usage analytics can\'t be refreshed right now'); }
  });
  return router;
}
