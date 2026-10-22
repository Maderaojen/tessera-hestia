import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../src/auth.js';
import { LoginFlows } from '../../src/account-status/login.js';
import type { AccountRef } from '../../src/account-status/types.js';
import { API_CAPABILITIES } from '../../src/contract/index.js';
import { API_FEATURES } from '../../src/routes/meta.js';
import { createAccountStatusRouter } from '../../src/routes/account-status.js';

// The re-login routes behind the same gate as server.ts's requireAuth (a
// login or the local tool token), driving a fake `claude auth login`.

const FAKE = path.join(import.meta.dirname, '..', 'account-status', 'fixtures', 'fake-claude-login.mjs');
const TOOL_TOKEN = 'tool-token-for-tests';
const CODE = 'goodcode-0123456789#state-abc';
let dir: string;
let app: express.Express;
let flows: LoginFlows;
let login: string;
let logged: string[];

function gate(req: Request, res: Response, next: NextFunction): void {
  if (auth.accountForRequest(req)) next();
  else res.status(401).json({ code: 'not_authenticated' });
}

const claude = (): AccountRef => ({
  id: 'janus:claude:work', provider: 'claude', name: 'work', source: 'janus', home: dir,
  launch: [process.execPath, FAKE], env: {}, unsetEnv: [],
});
const codex = (): AccountRef => ({ ...claude(), id: 'janus:codex:work', provider: 'codex' });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'login-route-'));
  logged = [];
  flows = new LoginFlows({ log: (line) => logged.push(line), onSucceeded: () => undefined });
  const router = createAccountStatusRouter({
    listAccounts: async () => ({ accounts: [claude(), codex()] }),
    knownEmail: async () => 'me@example.com',
    flows,
  });
  app = express().use(express.json()).use(gate).use('/account-status', router);
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  login = `Bearer ${auth.issueSessionToken({ username: 'alice', localOnly: false })}`;
});

afterEach(async () => {
  flows.cancelAll();
  auth.__setLocalToolTokenForTests(null);
  await rm(dir, { recursive: true, force: true });
});

const asTool = (req: request.Test) => req.set('X-Hestia-Token', TOOL_TOKEN);
const asUser = (req: request.Test) => req.set('Authorization', login);
const start = () => asUser(request(app).post(`/account-status/${encodeURIComponent('janus:claude:work')}/login`));

describe('/account-status re-login', () => {
  it('is a capability', () => {
    expect(API_CAPABILITIES).toContain('account_login');
    expect(API_FEATURES).toContain('account_login');
  });

  it('refuses the local tool token on every route', async () => {
    const started = await asTool(request(app).post(`/account-status/${encodeURIComponent('janus:claude:work')}/login`));
    expect(started.status).toBe(403);
    expect(started.body.code).toBe('login_required');
    expect(flows.activeFor('janus:claude:work')).toBe(false);
    expect((await asTool(request(app).post('/account-status/logins/x/code')).send({ code: CODE })).status).toBe(403);
    expect((await asTool(request(app).delete('/account-status/logins/x'))).status).toBe(403);
  });

  it('starts, takes a code, and says who signed in', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const started = await start();
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ state: 'awaiting_code', expectedEmail: 'me@example.com' });
    expect(started.body.url).toMatch(/^https:\/\/claude\.com\//);
    expect((await start()).body.code).toBe('login_in_progress');

    const bad = await asUser(request(app).post(`/account-status/logins/${started.body.loginId}/code`)).send({ code: 'short#x' });
    expect(bad.body).toEqual({ state: 'invalid_code', email: null, emailMatches: null });
    const done = await asUser(request(app).post(`/account-status/logins/${started.body.loginId}/code`)).send({ code: CODE });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ state: 'succeeded', email: 'me@example.com', emailMatches: true });
    expect(JSON.stringify([done.body, bad.body, logged])).not.toContain('goodcode');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('cancels, and answers unknown logins and accounts', async () => {
    const started = await start();
    expect((await asUser(request(app).delete(`/account-status/logins/${started.body.loginId}`))).status).toBe(204);
    expect((await asUser(request(app).delete(`/account-status/logins/${started.body.loginId}`))).status).toBe(404);
    expect((await asUser(request(app).post(`/account-status/logins/${started.body.loginId}/code`)).send({ code: CODE })).status).toBe(404);
    expect((await asUser(request(app).post('/account-status/nope/login'))).status).toBe(404);
    const codexLogin = await asUser(request(app).post(`/account-status/${encodeURIComponent('janus:codex:work')}/login`));
    expect(codexLogin.status).toBe(400);
    expect(codexLogin.body.code).toBe('login_unsupported');
    expect((await asUser(request(app).post('/account-status/logins/x/code')).send({})).body.code).toBe('invalid_request');
  });
});
