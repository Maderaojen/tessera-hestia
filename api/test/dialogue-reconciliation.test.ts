import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSegment, ManagedSession } from '../src/types.js';

const sessionId = 'f036bd2e-572c-49f4-9b88-1e2e0c231c65';
const conversationId = '7ef5e54a-6598-4263-a3bd-51d7f42a9196';
let home: string;
let root: string;
let source: string;
let destination: string;
let session: ManagedSession;
let conversation: ConversationSegment;
let reconcile: typeof import('../src/dialogue-reconciliation.js').reconcileDialogueArchive;

beforeEach(async () => {
  vi.resetModules();
  home = await mkdtemp(path.join(os.tmpdir(), 'dialogue-reconcile-test-'));
  vi.stubEnv('HOME', home);
  root = path.join(home, 'dialogue');
  vi.stubEnv('HESTIA_DIALOGUE_ROOT', root);
  vi.stubEnv('HESTIA_SESSION_PREFIX', 'hestia-');
  const host = os.hostname();
  source = path.join(root, host, sessionId, `${conversationId}.jsonl`);
  destination = path.join(root, host, 'claude', `hestia-${sessionId}`, `${conversationId}.jsonl`);
  conversation = {
    id: conversationId, sequence: 1, kind: 'cli', provider: 'claude', launchProfile: null,
    providerSessionId: conversationId, startedAt: '2026-01-01T00:00:00Z', endedAt: null,
    startReason: 'launch', endReason: null,
    transcript: { state: 'resolved', file: '/tmp/transcript.jsonl', identity: 'pinned_id' },
    lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null,
    pendingInteraction: null, transcriptError: null, turns: [],
  };
  session = {
    id: sessionId, tmuxName: `hestia-${sessionId}`, cwd: '/project', projectId: 'project', alias: null,
    createdAt: '2026-01-01T00:00:00Z', provider: null, providerSessionId: null,
    providerSessionFile: null, providerLaunchedAt: null, status: 'ready', lastUserMessageAt: null,
    lastUserMessageText: null, deliveryUnconfirmedText: null, lastError: null, pendingInteraction: null,
    turns: [], turnsSourceFile: null, activeConversationId: conversationId, conversations: [conversation],
  };
  reconcile = (await import('../src/dialogue-reconciliation.js')).reconcileDialogueArchive;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function putSource(overrides: Record<string, unknown> = {}) {
  await mkdir(path.dirname(source), { recursive: true });
  const record = {
    index: 1, user: { text: 'hi', at: null }, assistant: { text: 'hello', at: null },
    sessionId, conversationId, provider: 'claude', tmuxName: session.tmuxName, ...overrides,
  };
  await writeFile(source, `${JSON.stringify(record)}\n`);
}

describe('dialogue archive reconciliation', () => {
  it('accepts rows written with the archive identity fields (archiveVersion 2)', async () => {
    await putSource({ archiveVersion: 2, host: os.hostname(), projectId: 'project', providerSessionId: conversationId, runtimeId: 'claude-code', launchProfileId: null, transcriptFile: '/tmp/transcript.jsonl' });
    expect((await reconcile(source, { sessions: [session] })).status).toBe('would_copy');
  });

  it('still finds a session that is in the trash', async () => {
    await putSource();
    const registry = await import('../src/registry.js');
    const listAll = vi.spyOn(registry, 'listAllSessions').mockResolvedValueOnce([{ ...session, deletedAt: '2026-10-01T00:00:00Z' }]);
    const fresh = (await import('../src/dialogue-reconciliation.js')).reconcileDialogueArchive;
    expect((await fresh(source)).status).toBe('would_copy');
    expect(listAll).toHaveBeenCalled();
  });

  it('defaults to dry-run and leaves source and destination unchanged', async () => {
    await putSource();
    const result = await reconcile(source, { sessions: [session] });
    expect(result).toMatchObject({ status: 'would_copy', destination });
    expect(await readFile(source, 'utf8')).toContain('hello');
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies one verified copy, leaves source intact, and is idempotent', async () => {
    await putSource();
    const result = await reconcile(source, { apply: true, sessions: [session] });
    expect(result.status).toBe('copied');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(destination)).toEqual(await readFile(source));
    expect(await readFile(source, 'utf8')).toContain('hello');
    expect((await reconcile(source, { apply: true, sessions: [session] })).status).toBe('already_canonical');
  });

  it('rejects mismatched metadata without writing either path', async () => {
    await putSource({ provider: 'codex' });
    const result = await reconcile(source, { apply: true, sessions: [session] });
    expect(result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('metadata') });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toContain('codex');
  });

  it('does not overwrite a conflicting canonical destination', async () => {
    await putSource();
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'existing\n');
    const result = await reconcile(source, { apply: true, sessions: [session] });
    expect(result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('different content') });
    expect(await readFile(destination, 'utf8')).toBe('existing\n');
  });

  it("accepts only this install's prefix", async () => {
    await putSource();
    expect(await reconcile(source, { sessions: [session] })).toMatchObject({
      status: 'would_copy', destination: path.join(root, os.hostname(), 'claude', `hestia-${sessionId}`, `${conversationId}.jsonl`),
    });
    session = { ...session, tmuxName: `someone-else-${sessionId}` };
    await putSource();
    expect(await reconcile(source, { sessions: [session] })).toMatchObject({
      status: 'rejected', reason: expect.stringContaining('canonical Hestia name'),
    });
  });

  it('rejects the legacy flat provider/tmux layout without scanning or modifying it', async () => {
    const legacyFlat = path.join(root, os.hostname(), 'claude', session.tmuxName + '.jsonl');
    await mkdir(path.dirname(legacyFlat), { recursive: true });
    await writeFile(legacyFlat, 'legacy content\n');
    const result = await reconcile(legacyFlat, { apply: true, sessions: [session] });
    expect(result.status).toBe('rejected');
    expect(await readFile(legacyFlat, 'utf8')).toBe('legacy content\n');
  });
});
