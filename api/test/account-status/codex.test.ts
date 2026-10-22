import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapCodexStatus, queryCodexAppServer } from '../../src/account-status/codex.js';
import type { AccountRef } from '../../src/account-status/types.js';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-codex-app-server.mjs');
const NOW = new Date('2026-09-24T06:20:00Z');
const account: AccountRef = {
  id: 'janus:codex:codex-work', provider: 'codex', name: 'codex-work', source: 'janus',
  home: '/tmp/codex-work', launch: ['janus', 'run', 'codex-work'], env: {}, unsetEnv: [],
};

describe('queryCodexAppServer + mapCodexStatus', () => {
  it('reads plan, 5h/7d windows and credits from the app-server', async () => {
    const rpc = await queryCodexAppServer([process.execPath, FAKE], { CODEX_HOME: '/tmp/x' });
    const status = mapCodexStatus(account, rpc, NOW);
    expect(status).toMatchObject({
      state: 'ok', method: 'codex-app-server', error: null,
      identity: { email: 'me@example.com', plan: 'plus' },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      fetchedAt: '2026-09-24T06:20:00.000Z',
    });
    expect(status.windows).toEqual([
      { id: 'five_hour', label: '5 小時', usedPercent: 73, remainingPercent: 27, windowMinutes: 300, resetsAt: '2026-09-24T09:30:33.000Z', resetsText: null },
      { id: 'seven_day', label: '7 天', usedPercent: 32, remainingPercent: 68, windowMinutes: 10080, resetsAt: '2026-09-26T22:22:09.000Z', resetsText: null },
    ]);
  });

  it('classifies a logged-out CODEX_HOME as unauthenticated', async () => {
    const rpc = await queryCodexAppServer([process.execPath, FAKE], { FAKE_CODEX_MODE: 'unauth' });
    const status = mapCodexStatus(account, rpc, NOW);
    expect(status.state).toBe('unauthenticated');
    expect(status.windows).toEqual([]);
  });

  it('removes unset variables from the inherited environment', async () => {
    process.env.FAKE_CODEX_MODE = 'unauth';
    try {
      const rpc = await queryCodexAppServer([process.execPath, FAKE], {}, 5_000, ['FAKE_CODEX_MODE']);
      expect(mapCodexStatus(account, rpc, NOW).state).toBe('ok');
    } finally {
      delete process.env.FAKE_CODEX_MODE;
    }
  });

  it('times out instead of hanging on an unresponsive app-server', async () => {
    await expect(queryCodexAppServer([process.execPath, FAKE], { FAKE_CODEX_MODE: 'hang' }, 500)).rejects.toThrow(/timed out/);
  });

  it('rejects when the executable does not exist', async () => {
    await expect(queryCodexAppServer(['/nonexistent/codex'], {})).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('labels windows it does not recognise by their length', () => {
    const status = mapCodexStatus(account, {
      account: { id: 2, result: { account: null } },
      rateLimits: { id: 3, result: { rateLimits: { primary: { usedPercent: 120, windowDurationMins: 60, resetsAt: null }, secondary: null } } },
    }, NOW);
    expect(status.windows).toEqual([expect.objectContaining({ id: 'primary', label: '60 分鐘', usedPercent: 100, remainingPercent: 0 })]);
  });
});
