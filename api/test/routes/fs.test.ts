import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import { createApp } from '../../src/server.js';
import { issueSessionToken } from '../../src/auth.js';
import { FsBrowserError } from '../../src/fs-browser.js';

vi.mock('../../src/tmux.js', () => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  listManagedSessionNames: vi.fn(async () => [] as string[]),
  CONTROL_KEYS: ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab'],
}));

vi.mock('../../src/fs-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs-browser.js')>();
  return { ...actual, listDirectory: vi.fn(), searchDirectories: vi.fn() };
});

const fsBrowser = await import('../../src/fs-browser.js');

let auth: string;

beforeEach(() => {
  auth = `Bearer ${issueSessionToken()}`;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/fs', () => {
  it('requires auth', async () => {
    const app = createApp();
    const res = await request(app).get('/api/fs');
    expect(res.status).toBe(401);
  });

  it('passes an empty path through when no ?path= is given', async () => {
    vi.mocked(fsBrowser.listDirectory).mockResolvedValueOnce({ path: '/home/dev', parent: '/home', entries: [] });
    const app = createApp();
    const res = await request(app).get('/api/fs').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(fsBrowser.listDirectory).toHaveBeenCalledWith('');
    expect(res.body).toEqual({ path: '/home/dev', parent: '/home', entries: [] });
  });

  it('passes the ?path= query through', async () => {
    vi.mocked(fsBrowser.listDirectory).mockResolvedValueOnce({ path: '/tmp', parent: '/', entries: [] });
    const app = createApp();
    const res = await request(app).get('/api/fs?path=/tmp').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(fsBrowser.listDirectory).toHaveBeenCalledWith('/tmp');
  });

  it('maps NOT_FOUND to 404', async () => {
    vi.mocked(fsBrowser.listDirectory).mockRejectedValueOnce(new FsBrowserError('nope', 'NOT_FOUND'));
    const app = createApp();
    const res = await request(app).get('/api/fs?path=/nonexistent').set('Authorization', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'path_not_found', message: 'nope', error: 'nope' });
  });

  it('maps FORBIDDEN to 403', async () => {
    vi.mocked(fsBrowser.listDirectory).mockRejectedValueOnce(new FsBrowserError('nope', 'FORBIDDEN'));
    const app = createApp();
    const res = await request(app).get('/api/fs?path=/root').set('Authorization', auth);
    expect(res.status).toBe(403);
  });

  it('maps NOT_A_DIRECTORY to 400', async () => {
    vi.mocked(fsBrowser.listDirectory).mockRejectedValueOnce(new FsBrowserError('nope', 'NOT_A_DIRECTORY'));
    const app = createApp();
    const res = await request(app).get('/api/fs?path=/etc/hosts').set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('an unexpected (non-FsBrowserError) error propagates to the generic 500 handler', async () => {
    vi.mocked(fsBrowser.listDirectory).mockRejectedValueOnce(new Error('disk on fire'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    const res = await request(app).get('/api/fs').set('Authorization', auth);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'internal_error', message: 'internal server error', error: 'internal server error' });
    consoleErrorSpy.mockRestore();
  });
});

 describe('GET /api/fs/search', () => {
  it('requires auth', async () => {
    expect((await request(createApp()).get('/api/fs/search?path=/work&query=leaf')).status).toBe(401);
    expect(fsBrowser.searchDirectories).not.toHaveBeenCalled();
  });
  it('returns search completeness to the authenticated operator', async () => {
    const result = { path: '/work', entries: [], complete: true, incompleteReasons: [] };
    vi.mocked(fsBrowser.searchDirectories).mockResolvedValueOnce(result);
    const res = await request(createApp()).get('/api/fs/search?path=/work&query=leaf').set('Authorization', auth);
    expect(res.status).toBe(200); expect(res.body).toEqual(result);
  });
  it('requires bounded string query and path', async () => {
    for (const query of [{ path: '/' }, { path: '/', query: '' }, { path: '/', query: 'x'.repeat(1025) }, { path: '/', query: '\0' }]) {
      expect((await request(createApp()).get('/api/fs/search').set('Authorization', auth).query(query)).status).toBe(400);
    }
    expect(vi.mocked(fsBrowser.searchDirectories)).not.toHaveBeenCalled();
  });
  it('returns provider completeness and gives provider cancellation signal', async () => {
    const result = { path: '/work', entries: [], complete: false, incompleteReasons: ['limit' as const] };
    vi.mocked(fsBrowser.searchDirectories).mockResolvedValue(result);
    const res = await request(createApp()).get('/api/fs/search').set('Authorization', auth).query({ path: '/work', query: 'leaf' });
    expect(res.status).toBe(200); expect(res.body).toEqual(result);
    expect(vi.mocked(fsBrowser.searchDirectories).mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('cancels traversal when the client disconnects', async () => {
    let observed!: AbortSignal;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let cancelled!: () => void;
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    vi.mocked(fsBrowser.searchDirectories).mockImplementation((_path, _query, options) => {
      observed = options!.signal!; started();
      return new Promise(resolve => observed.addEventListener('abort', () => { cancelled(); resolve({ path: '/', entries: [], complete: false, incompleteReasons: ['limit'] }); }, { once: true }));
    });
    const server = createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}/api/fs/search?path=/&query=leaf`, { signal: controller.signal, headers: { Authorization: auth } }).catch(() => undefined);
    try { await ready; controller.abort(); await aborted; expect(observed.aborted).toBe(true); await response; }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

 });
