import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFileStore } from '@maderaojen/json-file-store';
import * as auth from '../../src/auth.js';
import { decodePermissionModeState, emptyPermissionModeState, resolveLaunchMode, capForLlm, effectiveMode } from '../../src/permission-modes/policy.js';
import { createPermissionModeService, type PermissionModeService } from '../../src/permission-modes/service.js';
import { refreshCodexSandbox, refreshCodexSandboxIfStale } from '../../src/permission-modes/codex-sandbox.js';
import { __setCodexSandboxForTests, codexSandboxState } from '../../src/runtimes/codex-sandbox-state.js';

vi.mock('../../src/registry.js', () => ({ getSession: vi.fn(), listSessions: vi.fn(async () => []) }));
const registry = await import('../../src/registry.js');
const { permissionModeSettingsRouter, sessionPermissionModesRouter } = await import('../../src/routes/permission-modes.js');

// Launch permission modes:
// the global per-runtime default (never yolo), a tmux's own choice, and
// what a launch resolves from them.

const TOOL_TOKEN = 'tool-token-for-tests';
let dir: string;
let service: PermissionModeService;
let store: ReturnType<typeof jsonFileStore<ReturnType<typeof emptyPermissionModeState>>>;
let app: express.Express;
let login: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'permission-modes-'));
  store = jsonFileStore({ path: path.join(dir, 'p.json'), empty: emptyPermissionModeState, decode: decodePermissionModeState });
  service = createPermissionModeService(store);
  __setCodexSandboxForTests(true);
  app = express().use(express.json())
    .use('/permission-modes', permissionModeSettingsRouter(service))
    .use('/sessions', sessionPermissionModesRouter(service));
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  login = `Bearer ${auth.issueSessionToken({ username: 'alice', localOnly: false })}`;
  vi.mocked(registry.getSession).mockImplementation(async (id: string) => (id === 's1' ? { id: 's1' } as never : undefined));
});

afterEach(async () => {
  auth.__setLocalToolTokenForTests(null);
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const asUser = (req: request.Test) => req.set('Authorization', login);
const asTool = (req: request.Test) => req.set('X-Hestia-Token', TOOL_TOKEN);

describe('policy', () => {
  const all = ['cli_default', 'auto', 'yolo'] as const;

  it('takes the tmux\'s own mode, else the global default, else cli_default', () => {
    const state = { ...emptyPermissionModeState(), defaults: { 'codex-cli': 'auto' as const }, sessions: { s1: { 'codex-cli': 'yolo' as const } } };
    expect(effectiveMode(state, 's1', 'codex-cli', all)).toBe('yolo');
    expect(effectiveMode(state, 's2', 'codex-cli', all)).toBe('auto');
    expect(effectiveMode(state, null, 'claude-code', all)).toBe('cli_default');
    // One the runtime can't start in (support changed since) is cli_default.
    expect(effectiveMode(state, 's2', 'codex-cli', ['cli_default', 'yolo'])).toBe('cli_default');
  });

  it('caps an LLM\'s launch below yolo', () => {
    expect(capForLlm('yolo', all)).toBe('auto');
    expect(capForLlm('yolo', ['cli_default', 'yolo'])).toBe('cli_default');
    expect(capForLlm('auto', all)).toBe('auto');
    const state = { ...emptyPermissionModeState(), sessions: { s1: { agy: 'yolo' as const } } };
    expect(resolveLaunchMode({ state, sessionId: 's1', runtimeId: 'agy', supported: ['cli_default', 'yolo'], llm: true })).toEqual({ ok: true, mode: 'cli_default' });
    expect(resolveLaunchMode({ state, sessionId: 's1', runtimeId: 'agy', supported: ['cli_default', 'yolo'], requested: 'auto' }))
      .toMatchObject({ ok: false, code: 'permission_mode_unsupported' });
  });

  it('never decodes a yolo global default, nor values it doesn\'t know', () => {
    const state = decodePermissionModeState({
      defaults: { 'codex-cli': 'yolo', 'claude-code': 'auto', agy: 'everything', nope: 'auto' },
      sessions: { s1: { 'codex-cli': 'yolo', 'claude-code': 'cli_default', agy: 7 }, s2: 'x' },
    });
    expect(state.defaults).toEqual({ 'claude-code': 'auto' });
    expect(state.sessions).toEqual({ s1: { 'codex-cli': 'yolo', 'claude-code': 'cli_default' } });
  });
});

describe('/permission-modes (global)', () => {
  it('starts with no defaults and lists what each runtime supports', async () => {
    const res = await request(app).get('/permission-modes');
    expect(res.body.defaults).toEqual({});
    expect(res.body.supported).toMatchObject({ 'claude-code': ['cli_default', 'auto', 'yolo'], agy: ['cli_default', 'yolo'] });
  });

  it('refuses yolo as a global default', async () => {
    const res = await asUser(request(app).put('/permission-modes')).send({ defaults: { 'codex-cli': 'yolo' } });
    expect(res.status).toBe(400);
    expect((await service.getSettings()).defaults).toEqual({});
  });

  it('takes auto from the login only, refuses a mode the runtime lacks, and null puts it back', async () => {
    expect((await asTool(request(app).put('/permission-modes')).send({ defaults: { 'codex-cli': 'auto' } })).status).toBe(403);
    let res = await asUser(request(app).put('/permission-modes')).send({ defaults: { 'codex-cli': 'auto' } });
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual({ 'codex-cli': 'auto' });
    res = await asUser(request(app).put('/permission-modes')).send({ defaults: { agy: 'auto' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('permission_mode_unsupported');
    res = await asUser(request(app).put('/permission-modes')).send({ defaults: { 'codex-cli': null } });
    expect(res.body.defaults).toEqual({});
  });
});

describe('/sessions/:id/permission-modes', () => {
  it('takes yolo for one tmux, from the login only; null resets it to the global value', async () => {
    await service.setDefaults({ defaults: { 'codex-cli': 'auto' } });
    expect((await asTool(request(app).put('/sessions/s1/permission-modes')).send({ override: { 'codex-cli': 'yolo' } })).status).toBe(403);
    let res = await asUser(request(app).put('/sessions/s1/permission-modes')).send({ override: { 'codex-cli': 'yolo' } });
    expect(res.status).toBe(200);
    expect(res.body.override).toEqual({ 'codex-cli': 'yolo' });
    expect(res.body.effective['codex-cli']).toBe('yolo');
    expect((await service.launchMode({ sessionId: 's1', runtimeId: 'codex-cli' }))).toEqual({ ok: true, mode: 'yolo' });
    expect((await service.launchMode({ sessionId: 's2', runtimeId: 'codex-cli' }))).toEqual({ ok: true, mode: 'auto' });
    res = await asUser(request(app).put('/sessions/s1/permission-modes')).send({ override: { 'codex-cli': null } });
    expect(res.body.override).toEqual({});
    expect(res.body.effective['codex-cli']).toBe('auto');
  });

  it('answers 404 for a session it doesn\'t know, and refuses an unknown mode', async () => {
    expect((await request(app).get('/sessions/nope/permission-modes')).status).toBe(404);
    expect((await asUser(request(app).put('/sessions/s1/permission-modes')).send({ override: { 'codex-cli': 'all' } })).status).toBe(400);
  });
});

describe('Codex\'s auto where Codex\'s sandbox can\'t start', () => {
  beforeEach(() => __setCodexSandboxForTests(false));

  it('says so in the settings, and refuses it globally and per tmux with its own code', async () => {
    const settings = await request(app).get('/permission-modes');
    expect(settings.body.unavailable).toEqual({ 'codex-cli': { auto: 'sandbox_unavailable' } });
    expect(settings.body.supported['codex-cli']).toEqual(['cli_default', 'auto', 'yolo']);
    let res = await asUser(request(app).put('/permission-modes')).send({ defaults: { 'codex-cli': 'auto' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('permission_mode_unavailable');
    res = await asUser(request(app).put('/sessions/s1/permission-modes')).send({ override: { 'codex-cli': 'auto' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('permission_mode_unavailable');
    // yolo per tmux is still fine.
    expect((await asUser(request(app).put('/sessions/s1/permission-modes')).send({ override: { 'codex-cli': 'yolo' } })).status).toBe(200);
  });

  it('starts a saved auto as cli_default, saying it fell back; a launch asking for it is refused', async () => {
    await store.save({ version: 1, defaults: { 'codex-cli': 'auto' }, sessions: { s1: { 'codex-cli': 'auto' } } });
    expect(await service.launchMode({ sessionId: 's1', runtimeId: 'codex-cli' })).toEqual({ ok: true, mode: 'cli_default', fallbackFrom: 'auto' });
    expect(await service.launchMode({ sessionId: 's2', runtimeId: 'codex-cli' })).toEqual({ ok: true, mode: 'cli_default', fallbackFrom: 'auto' });
    expect((await service.getSession('s1')).effective['codex-cli']).toBe('cli_default');
    expect(await service.launchMode({ sessionId: 's1', runtimeId: 'codex-cli', requested: 'auto' })).toMatchObject({ ok: false, code: 'permission_mode_unavailable' });
  });

  it('caps an LLM\'s yolo at cli_default for Codex, since its auto can\'t be used', async () => {
    await store.save({ version: 1, defaults: {}, sessions: { s1: { 'codex-cli': 'yolo', 'claude-code': 'yolo' } } });
    expect(await service.launchMode({ sessionId: 's1', runtimeId: 'codex-cli', llm: true })).toEqual({ ok: true, mode: 'cli_default' });
    expect(await service.launchMode({ sessionId: 's1', runtimeId: 'claude-code', llm: true })).toEqual({ ok: true, mode: 'auto' });
  });
});

describe('the Codex sandbox probe', () => {
  beforeEach(() => __setCodexSandboxForTests(null));

  it('records what the probe says, counting a failure as unavailable, one probe at a time', async () => {
    const probe = vi.fn(async () => true);
    const [a, b] = await Promise.all([refreshCodexSandbox(probe), refreshCodexSandbox(probe)]);
    expect([a, b]).toEqual([true, true]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(codexSandboxState().available).toBe(true);
    expect(await refreshCodexSandbox(async () => { throw new Error('codex not found'); })).toBe(false);
    expect(codexSandboxState().available).toBe(false);
  });

  it('probes again only when never probed or the answer is older than the limit', async () => {
    const probe = vi.fn(async () => false);
    await refreshCodexSandboxIfStale(60_000, probe);
    await refreshCodexSandboxIfStale(60_000, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    await refreshCodexSandboxIfStale(0, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reads the settings after refreshing a stale answer', async () => {
    const beforeRead = vi.fn(async () => { __setCodexSandboxForTests(false); });
    const fresh = createPermissionModeService(store, { beforeRead });
    __setCodexSandboxForTests(true);
    expect((await fresh.getSettings()).unavailable).toEqual({ 'codex-cli': { auto: 'sandbox_unavailable' } });
    expect(beforeRead).toHaveBeenCalledTimes(1);
  });
});
