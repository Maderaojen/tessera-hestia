import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const report = (sweeping: boolean) => ({ accounts: [], janusAvailable: true, fetchedAt: '2026-09-24T07:15:00.000Z', trigger: 'schedule', sweeping });
vi.mock('../../src/account-status/index.js', () => ({
  getAccountStatus: vi.fn(async () => report(false)),
  requestRefresh: vi.fn(async (force: boolean) => report(force)),
}));

const { accountStatusRouter } = await import('../../src/routes/account-status.js');
const status = await import('../../src/account-status/index.js');
const app = express().use(express.json()).use('/account-status', accountStatusRouter);

afterEach(() => vi.clearAllMocks());

describe('account status route', () => {
  it('GET answers from the snapshot', async () => {
    const response = await request(app).get('/account-status');
    expect(response.status).toBe(200);
    expect(response.body.fetchedAt).toBe('2026-09-24T07:15:00.000Z');
  });

  it('POST /refresh forces by default and answers 202 while the sweep runs', async () => {
    const response = await request(app).post('/account-status/refresh');
    expect(status.requestRefresh).toHaveBeenCalledWith(true);
    expect(response.status).toBe(202);
    expect(response.body.sweeping).toBe(true);
  });

  it('POST /refresh with force:false is the sidebar-open refresh', async () => {
    const response = await request(app).post('/account-status/refresh').send({ force: false });
    expect(status.requestRefresh).toHaveBeenCalledWith(false);
    expect(response.status).toBe(200);
  });
});
