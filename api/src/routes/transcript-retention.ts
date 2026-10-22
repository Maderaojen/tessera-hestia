import { Router } from 'express';
import { z } from 'zod';
import { listAccounts } from '../account-status/accounts.js';
import type { AccountRef } from '../account-status/types.js';
import type { RetentionAccount, TranscriptRetention } from '../contract/process.js';
import {
  CLAUDE_DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, claudeSettingsFile, readClaudeRetention, writeClaudeRetention,
} from '../retention/claude.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';

// The Claude accounts' transcript retention, read and — only when the user
// presses for it — written. It writes
// the user's own Claude settings, so only their login may, never the
// local tool token a CLI holds. `listAccounts` is injectable so tests never
// see a real home.
export type TranscriptRetentionDeps = { listAccounts: () => Promise<{ accounts: AccountRef[] }> };

const putSchema = z.object({
  days: z.number().int(),
  // The value the user saw (null: not set): a file changed since is not overwritten.
  expectedDays: z.number().int().nullable(),
});

export function createTranscriptRetentionRouter(deps: Partial<TranscriptRetentionDeps> = {}): Router {
  const router = Router();
  const list = deps.listAccounts ?? listAccounts;
  const claudeAccounts = async () => (await list()).accounts.filter((account) => account.provider === 'claude');

  router.get('/', requireLogin, async (_req, res) => {
    const accounts: RetentionAccount[] = [];
    for (const account of await claudeAccounts()) {
      const file = claudeSettingsFile(account.home);
      const read = await readClaudeRetention(file);
      accounts.push({
        id: account.id, name: account.name, source: account.source === 'janus' ? 'janus' : 'native', file,
        state: read.state, days: read.state === 'ok' ? read.days : null,
      });
    }
    const body: TranscriptRetention = { defaultDays: CLAUDE_DEFAULT_RETENTION_DAYS, minDays: MIN_RETENTION_DAYS, maxDays: MAX_RETENTION_DAYS, accounts };
    res.json(body);
  });

  router.put('/claude/:accountId', requireLogin, async (req, res) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', parsed.error.message);
      return;
    }
    const account = (await claudeAccounts()).find((candidate) => candidate.id === req.params.accountId);
    if (!account) {
      sendError(res, 404, 'not_found', 'no such Claude account');
      return;
    }
    const file = claudeSettingsFile(account.home);
    const result = await writeClaudeRetention(file, parsed.data.days, parsed.data.expectedDays);
    if (result === 'invalid_days') {
      sendError(res, 400, 'invalid_request', `days must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`);
      return;
    }
    if (result === 'unreadable') {
      sendError(res, 409, 'retention_file_unreadable', 'the settings file is not a JSON object Hestia can change');
      return;
    }
    if (result === 'changed') {
      sendError(res, 409, 'retention_changed', 'the settings file changed since it was read');
      return;
    }
    const read = await readClaudeRetention(file);
    res.json({ id: account.id, name: account.name, source: account.source === 'janus' ? 'janus' : 'native', file, state: read.state, days: read.state === 'ok' ? read.days : null } satisfies RetentionAccount);
  });

  return router;
}
