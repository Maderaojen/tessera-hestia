import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../src/auth.js';
import { createApp } from '../../src/server.js';

// The Git area and the folder picker read files and trees: only the user's
// login may call them, never the local tool token a CLI holds.

vi.mock('../../src/fs-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs-browser.js')>();
  return {
    ...actual,
    listDirectory: vi.fn(async () => ({ path: '/tmp', parent: '/', entries: [] })),
    searchDirectories: vi.fn(async () => ({ results: [], truncated: false })),
  };
});

const TOOL_TOKEN = 'tool-token-for-tests';

const ENDPOINTS = [
  '/api/projects/p-none/repos',
  '/api/projects/p-none/repo/status?root=/tmp',
  '/api/projects/p-none/repo/worktrees?root=/tmp',
  '/api/projects/p-none/repo/diff?root=/tmp&path=a',
  '/api/projects/p-none/repo/commit?root=/tmp&sha=0123456789abcdef0123456789abcdef01234567',
  '/api/projects/p-none/repo/tree?root=/tmp',
  '/api/projects/p-none/repo/file?root=/tmp&path=a',
  '/api/projects/p-none/repo/log?root=/tmp',
  '/api/fs?path=/tmp',
  '/api/fs/search?path=/tmp&query=a',
];

beforeEach(() => {
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
});

afterEach(() => {
  auth.__setLocalToolTokenForTests(null);
  vi.clearAllMocks();
});

describe('Git area and folder picker: login only', () => {
  it.each(ENDPOINTS)('%s refuses the tool token with login_required', async (url) => {
    const res = await request(createApp()).get(url).set('X-Hestia-Token', TOOL_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
  });

  it.each(ENDPOINTS)('%s lets the login through', async (url) => {
    const res = await request(createApp()).get(url).set('Authorization', `Bearer ${auth.issueSessionToken()}`);
    expect(res.body.code).not.toBe('login_required');
    // An unknown project is 404; the folder picker (mocked) answers.
    expect(res.status).toBe(url.startsWith('/api/fs') ? 200 : 404);
  });

  it('the tool token still reaches the project list (the hestia command uses it)', async () => {
    const res = await request(createApp()).get('/api/projects').set('X-Hestia-Token', TOOL_TOKEN);
    expect(res.status).toBe(200);
  });
});
