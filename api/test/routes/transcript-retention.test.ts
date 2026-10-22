import { mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as auth from '../../src/auth.js';
import type { AccountRef } from '../../src/account-status/types.js';
import { createTranscriptRetentionRouter } from '../../src/routes/transcript-retention.js';

// Only throwaway homes: this writes Claude settings files.
let root: string;
let login: string;
const TOOL_TOKEN = 'retention-tool-token';

function account(id: string, name: string, source: 'native' | 'janus', provider = 'claude'): AccountRef {
  return { id, provider, name, source, home: path.join(root, name), launch: [], env: {}, unsetEnv: [] } as AccountRef;
}
let accounts: AccountRef[];

function app() {
  const server = express();
  server.use(express.json());
  server.use('/transcript-retention', createTranscriptRetentionRouter({ listAccounts: async () => ({ accounts }) }));
  return server;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'hestia-retention-'));
  accounts = [account('native:claude:default', 'default', 'native'), account('janus:claude:work', 'work', 'janus'), account('native:codex:default', 'codex', 'native', 'codex')];
  for (const a of accounts) await mkdir(a.home, { recursive: true });
  await writeFile(path.join(root, 'work', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [] }, cleanupPeriodDays: 60 }));
  await chmod(path.join(root, 'work', 'settings.json'), 0o640);
  login = `Bearer ${auth.issueSessionToken()}`;
  auth.__setLocalToolTokenForTests(TOOL_TOKEN);
});
afterEach(async () => {
  auth.__setLocalToolTokenForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe('GET /transcript-retention', () => {
  it('lists each Claude account\'s value and the file it lives in', async () => {
    const res = await request(app()).get('/transcript-retention').set('Authorization', login);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ defaultDays: 30, minDays: 1, maxDays: 3650 });
    expect(res.body.accounts).toEqual([
      { id: 'native:claude:default', name: 'default', source: 'native', file: path.join(root, 'default', 'settings.json'), state: 'ok', days: null },
      { id: 'janus:claude:work', name: 'work', source: 'janus', file: path.join(root, 'work', 'settings.json'), state: 'ok', days: 60 },
    ]);
  });

  it('is for the user\'s own login only', async () => {
    expect((await request(app()).get('/transcript-retention').set('X-Hestia-Token', TOOL_TOKEN)).status).toBe(403);
  });
});

describe('PUT /transcript-retention/claude/:accountId', () => {
  const file = () => path.join(root, 'work', 'settings.json');

  it('sets the value and keeps every other setting and the file\'s mode', async () => {
    const res = await request(app()).put('/transcript-retention/claude/janus:claude:work').set('Authorization', login).send({ days: 180, expectedDays: 60 });
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(180);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ theme: 'dark', hooks: { Stop: [] }, cleanupPeriodDays: 180 });
    expect((await stat(file())).mode & 0o777).toBe(0o640);
  });

  it('creates the settings file when the account has none', async () => {
    const res = await request(app()).put('/transcript-retention/claude/native:claude:default').set('Authorization', login).send({ days: 90, expectedDays: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(await readFile(path.join(root, 'default', 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 90 });
  });

  it('does not overwrite a file that changed since the user saw it', async () => {
    const res = await request(app()).put('/transcript-retention/claude/janus:claude:work').set('Authorization', login).send({ days: 180, expectedDays: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('retention_changed');
    expect(JSON.parse(await readFile(file(), 'utf8')).cleanupPeriodDays).toBe(60);
  });

  it('refuses 0 (it fails Claude Code\'s own validation) and other bad values', async () => {
    for (const days of [0, -1, 3651]) {
      const res = await request(app()).put('/transcript-retention/claude/janus:claude:work').set('Authorization', login).send({ days, expectedDays: 60 });
      expect(res.status).toBe(400);
    }
    expect((await request(app()).put('/transcript-retention/claude/janus:claude:work').set('Authorization', login).send({ days: 1.5, expectedDays: 60 })).status).toBe(400);
  });

  it('leaves a settings file it cannot parse alone', async () => {
    await writeFile(file(), '{ "theme": "dark", // a comment\n}');
    const res = await request(app()).put('/transcript-retention/claude/janus:claude:work').set('Authorization', login).send({ days: 180, expectedDays: null });
    expect(res.body.code).toBe('retention_file_unreadable');
    expect(await readFile(file(), 'utf8')).toBe('{ "theme": "dark", // a comment\n}');
  });

  it('only knows Claude accounts, and only for the user\'s own login', async () => {
    expect((await request(app()).put('/transcript-retention/claude/native:codex:default').set('Authorization', login).send({ days: 90, expectedDays: null })).status).toBe(404);
    expect((await request(app()).put('/transcript-retention/claude/janus:claude:work').set('X-Hestia-Token', TOOL_TOKEN).send({ days: 90, expectedDays: 60 })).status).toBe(403);
    expect(JSON.parse(await readFile(file(), 'utf8')).cleanupPeriodDays).toBe(60);
  });
});
