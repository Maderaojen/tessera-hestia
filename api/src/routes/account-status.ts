import { Router } from 'express';
import { listAccounts } from '../account-status/accounts.js';
import { getAccountStatus, refreshAfterLogin, requestRefresh } from '../account-status/index.js';
import { LoginError, LoginFlows } from '../account-status/login.js';
import { readSnapshot } from '../account-status/snapshot.js';
import type { AccountRef } from '../account-status/types.js';
import { accountRuntimeFor } from '../runtimes/index.js';
import { sendError } from './errors.js';
import { requireLogin } from './login-guard.js';

export type AccountStatusRouterDeps = {
  listAccounts: () => Promise<{ accounts: AccountRef[] }>;
  // The email the account was last seen signed in as, to pre-fill the
  // sign-in page and to compare with afterwards.
  knownEmail: (accountId: string) => Promise<string | null>;
  flows: LoginFlows;
};

async function knownEmailFromSnapshot(accountId: string): Promise<string | null> {
  const snapshot = await readSnapshot();
  return snapshot?.accounts.find((account) => account.id === accountId)?.identity.email ?? null;
}

let sharedFlows: LoginFlows | null = null;
function defaultFlows(): LoginFlows {
  if (!sharedFlows) {
    sharedFlows = new LoginFlows({
      onSucceeded: () => {
        refreshAfterLogin().catch((error: unknown) => {
          console.warn(`[account-status] refresh after login failed: ${(error as Error).message}`);
        });
      },
    });
    // A login's CLI is in its own process group; don't leave it waiting.
    const flows = sharedFlows;
    process.once('exit', () => flows.cancelAll());
  }
  return sharedFlows;
}

// Login errors answer with fixed wording; nothing from the CLI goes out.
function sendLoginError(res: Parameters<typeof sendError>[0], error: unknown): void {
  if (!(error instanceof LoginError)) {
    sendError(res, 500, 'internal_error', 'login failed unexpectedly');
    return;
  }
  switch (error.code) {
    case 'login_in_progress': sendError(res, 409, 'login_in_progress', 'a login for this account is already under way'); return;
    case 'login_busy': sendError(res, 409, 'login_in_progress', 'a code for this login is being checked'); return;
    case 'login_not_found': sendError(res, 404, 'not_found', 'no such login'); return;
    case 'login_start_failed': sendError(res, 502, 'login_start_failed', 'the CLI did not offer a sign-in link'); return;
  }
}

export function createAccountStatusRouter(deps: Partial<AccountStatusRouterDeps> = {}): Router {
  const router = Router();
  const list = deps.listAccounts ?? listAccounts;
  const knownEmail = deps.knownEmail ?? knownEmailFromSnapshot;
  const flows = () => deps.flows ?? defaultFlows();

  // Always answers from the snapshot file; never waits on a CLI.
  router.get('/', async (_req, res) => {
    res.json(await getAccountStatus());
  });

  // Starts a sweep in the background and returns the current snapshot with
  // `sweeping: true`; the client polls GET until it clears. `{ force: false }`
  // (the sidebar opening) only sweeps when the snapshot is older than 5 min;
  // the default (the ↻ button) always does.
  router.post('/refresh', async (req, res) => {
    const force = (req.body as { force?: unknown } | undefined)?.force !== false;
    const report = await requestRefresh(force);
    res.status(report.sweeping ? 202 : 200).json(report);
  });

  // Logging an account in again (account-status/login.ts, ADR 0028). Only
  // the user's own login: an LLM holding the tool token must not replace
  // an account's credentials.
  router.post('/logins/:loginId/code', requireLogin, async (req, res) => {
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== 'string' || !code.trim() || code.length > 4096) {
      sendError(res, 400, 'invalid_request', 'code is required');
      return;
    }
    try {
      res.json(await flows().submit(req.params.loginId as string, code));
    } catch (error) {
      sendLoginError(res, error);
    }
  });

  router.delete('/logins/:loginId', requireLogin, (req, res) => {
    if (flows().cancel(req.params.loginId as string)) res.status(204).end();
    else sendError(res, 404, 'not_found', 'no such login');
  });

  router.post('/:accountId/login', requireLogin, async (req, res) => {
    const accountId = req.params.accountId as string;
    const account = (await list()).accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      sendError(res, 404, 'not_found', 'no such account');
      return;
    }
    const protocol = accountRuntimeFor(account.provider)?.accountStatus?.login;
    if (!protocol) {
      sendError(res, 400, 'login_unsupported', 'logging this account in from the app is not supported');
      return;
    }
    try {
      res.status(201).json(await flows().start(account, protocol, await knownEmail(account.id)));
    } catch (error) {
      sendLoginError(res, error);
    }
  });

  return router;
}

export const accountStatusRouter = createAccountStatusRouter();
