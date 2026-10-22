import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../src/auth.js';
import { createApp } from '../../src/server.js';
import { clearProcessCache } from '../../src/process/cache.js';
import type { ConversationSegment, ManagedSession } from '../../src/types.js';

vi.mock('../../src/registry.js', () => ({
  getSession: vi.fn(),
  getConversation: vi.fn(),
  listSessions: vi.fn(async () => []),
  reconcile: vi.fn(async () => {}),
}));
const registry = await import('../../src/registry.js');

const TOOL_TOKEN = 'tool-token-for-tests';
let dir: string;
let file: string;
let login: string;

const records = [
  { type: 'user', timestamp: '2026-10-12T00:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '問' } },
  { type: 'assistant', timestamp: '2026-10-12T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '先查。' }] } },
  { type: 'assistant', timestamp: '2026-10-12T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat .env' } }] } },
  { type: 'user', timestamp: '2026-10-12T00:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'SECRET=1' }] } },
  { type: 'assistant', timestamp: '2026-10-12T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '答。' }] } },
  { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-12T00:00:05.000Z' },
  // Sent, nothing written back yet but a tool.
  { type: 'user', timestamp: '2026-10-12T00:01:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '再跑一次' } },
  { type: 'assistant', timestamp: '2026-10-12T00:01:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } }] } },
];

const session = { id: 'sess-1', cwd: '/w', status: 'ready', turnPhase: 'replying', activeConversationId: 'conv-1', provider: 'claude' } as unknown as ManagedSession;
function conversation(): ConversationSegment {
  return {
    id: 'conv-1', provider: 'claude', providerSessionId: null, startedAt: '2026-10-12T00:00:00Z', launchProfile: null,
    transcript: { state: 'resolved', file, identity: 'pinned_id' },
    turns: [{ index: 1, user: { text: '問', at: '2026-10-12T00:00:00.000Z' }, assistant: { text: '先查。\n\n答。', at: '2026-10-12T00:00:01.000Z' } }],
  } as unknown as ConversationSegment;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-turn-process-route-'));
  file = path.join(dir, 't.jsonl');
  await writeFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  clearProcessCache();
  login = `Bearer ${auth.issueSessionToken()}`;
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
  vi.mocked(registry.getSession).mockResolvedValue(session);
  vi.mocked(registry.getConversation).mockImplementation(async () => conversation());
});
afterEach(async () => {
  auth.__setLocalToolTokenForTests(null);
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const base = '/api/sessions/sess-1/conversations/conv-1/turns';

describe('GET …/turns/:index/process', () => {
  it('lists a stored turn\'s items', async () => {
    const res = await request(createApp()).get(`${base}/1/process`).set('Authorization', login);
    expect(res.status).toBe(200);
    expect(res.body.process).toMatchObject({ status: 'available', counts: { run: 1 } });
    expect(res.body.items).toEqual([{ id: 'toolu_1', kind: 'run', label: 'cat .env', at: '2026-10-12T00:00:02.000Z', status: 'ok', hasDetail: true, afterPart: 0 }]);
    expect(JSON.stringify(res.body)).not.toContain(dir);
  });

  it('lists what the newest message set going before it is a turn', async () => {
    const res = await request(createApp()).get(`${base}/open/process`).set('Authorization', login);
    expect(res.status).toBe(200);
    expect(res.body.process).toMatchObject({ status: 'available', open: true, parts: [] });
    expect(res.body.items).toMatchObject([{ id: 'toolu_2', label: 'npm test', status: 'running' }]);
  });

  it('refuses the local tool token: these can show secrets', async () => {
    const res = await request(createApp()).get(`${base}/1/process`).set('X-Hestia-Token', TOOL_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('login_required');
  });

  it('says the transcript is gone', async () => {
    await rm(file);
    const res = await request(createApp()).get(`${base}/1/process`).set('Authorization', login);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('transcript_missing');
  });

  it('404s a turn the conversation does not have, and refuses a bad index', async () => {
    expect((await request(createApp()).get(`${base}/9/process`).set('Authorization', login)).body.code).toBe('turn_not_found');
    expect((await request(createApp()).get(`${base}/-1/process`).set('Authorization', login)).status).toBe(400);
  });
});

describe('GET …/turns/:index/process/items/:itemId', () => {
  it('gives an item\'s details', async () => {
    const res = await request(createApp()).get(`${base}/1/process/items/toolu_1`).set('Authorization', login);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ input: 'cat .env', output: 'SECRET=1', truncated: false });
  });

  it('only finds items of that turn, and never reads anything else', async () => {
    expect((await request(createApp()).get(`${base}/1/process/items/toolu_2`).set('Authorization', login)).body.code).toBe('process_item_not_found');
    expect((await request(createApp()).get(`${base}/1/process/items/..%2F..%2Fetc%2Fpasswd`).set('Authorization', login)).status).toBe(400);
    expect((await request(createApp()).get(`${base}/1/process/items/toolu_1`).set('X-Hestia-Token', TOOL_TOKEN)).status).toBe(403);
  });
});

describe('GET …/turns/:index/git', () => {
  it('is for the user\'s own login only, and 404s a turn it does not have', async () => {
    expect((await request(createApp()).get(`${base}/1/git`).set('X-Hestia-Token', TOOL_TOKEN)).status).toBe(403);
    expect((await request(createApp()).get(`${base}/9/git`).set('Authorization', login)).body.code).toBe('turn_not_found');
    expect((await request(createApp()).get(`${base}/open/git`).set('Authorization', login)).status).toBe(400);
  });
});

describe('GET …/process/items/:itemId/images/:image', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  // The first turn's command, its result an image and an SVG labelled as a PNG.
  beforeEach(async () => {
    const withImages = records.map((record, index) => index !== 3 ? record : {
      ...record,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [
        { type: 'text', text: 'SECRET=1' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SVG.toString('base64') } },
      ] }] },
    });
    await writeFile(file, withImages.map((record) => `${JSON.stringify(record)}\n`).join(''));
    clearProcessCache();
  });
  const images = `${base}/1/process/items/toolu_1/images`;

  it('lists the images in the item\'s detail and serves each by its bytes, never sniffed or cached', async () => {
    const detail = await request(createApp()).get(`${base}/1/process/items/toolu_1`).set('Authorization', login);
    expect(detail.body.images).toEqual([{ index: 0, source: 'result', name: null }, { index: 1, source: 'result', name: null }]);
    const res = await request(createApp()).get(`${images}/0`).set('Authorization', login).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('refuses what isn\'t an image the app shows, an image the item lacks, a bad index and the tool token', async () => {
    expect((await request(createApp()).get(`${images}/1`).set('Authorization', login)).status).toBe(415);
    const missing = await request(createApp()).get(`${images}/2`).set('Authorization', login);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('process_image_not_found');
    expect((await request(createApp()).get(`${base}/1/process/items/toolu_9/images/0`).set('Authorization', login)).status).toBe(404);
    expect((await request(createApp()).get(`${images}/x`).set('Authorization', login)).status).toBe(400);
    expect((await request(createApp()).get(`${images}/0`).set('X-Hestia-Token', TOOL_TOKEN)).status).toBe(403);
  });
});
