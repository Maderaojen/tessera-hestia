import { spawn } from 'node:child_process';
import { childEnv } from '../child-env.js';
import { baseStatus, usageWindow, type AccountRef, type AccountStatus, type UsageWindow } from './types.js';
import { t } from '../i18n/index.js';

// Codex's own app-server protocol (`codex app-server`, JSON-RPC over stdio)
// exposes `account/read` and `account/rateLimits/read` — the same data the
// TUI's `/status` shows, straight from OpenAI's backend, as structured JSON
// (and `model/list`, see runtimes/codex-models.ts).
export const CODEX_APP_SERVER_ARGS = ['-s', 'read-only', '-a', 'never', 'app-server'];
const TIMEOUT_MS = 20_000;

type RpcError = { code?: number; message?: string };
export type RpcReply = { id: number; result?: unknown; error?: RpcError };
export type CodexRpcResult = { account: RpcReply; rateLimits: RpcReply };
export type CodexRpcCall = { method: string; params?: unknown };

// Spawns the app-server, performs the initialize handshake, and sends each
// call in order; resolves with their replies in the same order once all
// have answered. The process (group) is always killed afterwards.
export function callCodexAppServer(
  argv: string[], env: Record<string, string>, calls: CodexRpcCall[], timeoutMs = TIMEOUT_MS, unsetEnv: string[] = [],
): Promise<RpcReply[]> {
  return new Promise((resolve, reject) => {
    const spawnEnv: NodeJS.ProcessEnv = { ...childEnv(), ...env };
    for (const key of unsetEnv) delete spawnEnv[key];
    const child = spawn(argv[0], argv.slice(1), {
      env: spawnEnv, stdio: ['pipe', 'pipe', 'ignore'], detached: true,
    });
    const replies = new Map<number, RpcReply>();
    // Call i is sent with id i + 2 (1 is the handshake).
    const ids = calls.map((_call, index) => index + 2);
    const complete = () => ids.every((id) => replies.has(id));
    let buffer = '';
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      if (!error && complete()) resolve(ids.map((id) => replies.get(id)!));
      else reject(error ?? new Error('codex app-server exited early'));
    };
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), timeoutMs);
    const send = (message: object) => { child.stdin.write(`${JSON.stringify(message)}\n`); };

    child.on('error', (error) => finish(error));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => { /* reported through exit/timeout */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: RpcReply;
        try { message = JSON.parse(line) as RpcReply; } catch { continue; }
        if (typeof message.id !== 'number') continue; // notifications
        replies.set(message.id, message);
        if (message.id === 1) {
          send({ method: 'initialized' });
          calls.forEach((call, index) => send({ id: ids[index], method: call.method, ...(call.params === undefined ? {} : { params: call.params }) }));
        }
        if (complete()) finish(null);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hestia', version: '0.1.0' } } });
  });
}

// The two read-only questions behind an account's status.
export async function queryCodexAppServer(
  argv: string[], env: Record<string, string>, timeoutMs = TIMEOUT_MS, unsetEnv: string[] = [],
): Promise<CodexRpcResult> {
  const [account, rateLimits] = await callCodexAppServer(argv, env, [
    { method: 'account/read', params: {} },
    { method: 'account/rateLimits/read' },
  ], timeoutMs, unsetEnv);
  return { account: account!, rateLimits: rateLimits! };
}

type RawWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;

function mapWindow(raw: RawWindow, fallbackId: string): UsageWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number') return null;
  const minutes = typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : null;
  const id = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : fallbackId;
  const label = id === 'five_hour' ? t('account.window.fiveHour') : id === 'seven_day' ? t('account.window.sevenDay') : minutes ? t('account.window.minutes', { minutes }) : fallbackId;
  const resetsAt = typeof raw.resetsAt === 'number' ? new Date(raw.resetsAt * 1000).toISOString() : null;
  return usageWindow(id, label, raw.usedPercent, minutes, resetsAt);
}

export function mapCodexStatus(account: AccountRef, rpc: CodexRpcResult, now: Date = new Date()): AccountStatus {
  const status: AccountStatus = { ...baseStatus(account, now), method: 'codex-app-server' };
  const acct = (rpc.account.result as { account?: { email?: unknown; planType?: unknown } | null } | undefined)?.account;
  if (acct) {
    status.identity = {
      email: typeof acct.email === 'string' ? acct.email : null,
      plan: typeof acct.planType === 'string' ? acct.planType : null,
    };
  }
  if (rpc.rateLimits.error) {
    const message = rpc.rateLimits.error.message ?? 'rate limit query failed';
    status.state = !acct || /auth/i.test(message) ? 'unauthenticated' : 'error';
    status.error = message;
    return status;
  }
  const limits = (rpc.rateLimits.result as { rateLimits?: Record<string, unknown> } | undefined)?.rateLimits;
  if (!limits) {
    status.error = 'rate limit response had no rateLimits';
    return status;
  }
  status.windows = [
    mapWindow(limits.primary as RawWindow, 'primary'),
    mapWindow(limits.secondary as RawWindow, 'secondary'),
  ].filter((w): w is UsageWindow => w !== null);
  const credits = limits.credits as { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined;
  if (credits) {
    status.credits = {
      hasCredits: credits.hasCredits === true,
      unlimited: credits.unlimited === true,
      balance: typeof credits.balance === 'string' ? credits.balance : null,
    };
  }
  if (!status.identity.plan && typeof limits.planType === 'string') status.identity.plan = limits.planType;
  status.state = 'ok';
  return status;
}

export async function probeCodex(account: AccountRef, now: () => Date = () => new Date()): Promise<AccountStatus> {
  try {
    const rpc = await queryCodexAppServer([...account.launch, ...CODEX_APP_SERVER_ARGS], account.env, TIMEOUT_MS, account.unsetEnv);
    return mapCodexStatus(account, rpc, now());
  } catch (error) {
    const status = baseStatus(account, now());
    status.method = 'codex-app-server';
    const code = (error as NodeJS.ErrnoException).code;
    status.state = code === 'ENOENT' ? 'not_installed' : 'error';
    status.error = (error as Error).message;
    return status;
  }
}
