import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnv } from '../child-env.js';
import type { AccountLoginProtocol, AccountRef } from './types.js';

// Logging an account in again from the app (ADR 0028), the way the user
// would in a terminal: the account's own CLI login command, started the way
// the account is (`janus run <name> …`, or the bare CLI with the parent's
// CLAUDE_CONFIG_DIR cleared), over pipes. The CLI prints a sign-in URL and
// waits for the code the sign-in page shows; the app relays the code to its
// stdin. The CLI itself exchanges and stores the credentials — Hestia
// never sees a token.
//
// What passes through here stays out of every log, error and response:
// the child's output is only matched against the protocol's keywords, the
// code is written to stdin and forgotten. Logs carry the account id and an
// outcome word, nothing else.
//
// Flows live in memory only. One per account; each ends on success,
// failure, cancel or LOGIN_TIMEOUT_MS, and its process group is killed.

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
// From start until the CLI prints its URL and waits for the code.
export const PROMPT_TIMEOUT_MS = 30_000;
// From a submitted code until the CLI says how it went.
export const VERIFY_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
// Output kept for matching; the protocol's lines are short.
const MAX_BUFFER = 64 * 1024;

export type LoginFlowState = 'awaiting_code' | 'verifying';
export type CodeOutcome = 'succeeded' | 'invalid_code' | 'failed';

export type StartedLogin = { loginId: string; url: string; state: 'awaiting_code'; expectedEmail: string | null };
export type CodeResult = { state: CodeOutcome; email: string | null; emailMatches: boolean | null };

export class LoginError extends Error {
  constructor(readonly code: 'login_in_progress' | 'login_start_failed' | 'login_not_found' | 'login_busy', message: string) {
    super(message);
  }
}

type Flow = {
  id: string;
  account: AccountRef;
  protocol: AccountLoginProtocol;
  child: ChildProcess;
  expectedEmail: string | null;
  state: LoginFlowState;
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined; // undefined while running
  timer: ReturnType<typeof setTimeout>;
  // Called on every output chunk and on exit, while someone waits.
  onChange: (() => void) | null;
};

export type LoginDeps = {
  spawn: typeof spawn;
  // `<launch> auth status --json`'s stdout, or null.
  runStatus: (argv: string[], env: NodeJS.ProcessEnv) => Promise<string | null>;
  // After a successful login: re-read the account's status.
  onSucceeded: (account: AccountRef) => void;
  log: (line: string) => void;
  loginTimeoutMs: number;
  promptTimeoutMs: number;
  verifyTimeoutMs: number;
};

function runStatusDefault(argv: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { env, timeout: STATUS_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

const defaultDeps: LoginDeps = {
  spawn,
  runStatus: runStatusDefault,
  onSucceeded: () => undefined,
  log: (line) => console.info(`[account-login] ${line}`),
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  promptTimeoutMs: PROMPT_TIMEOUT_MS,
  verifyTimeoutMs: VERIFY_TIMEOUT_MS,
};

/** The environment the account's CLI runs with, and a browser that does nothing. */
export function loginEnv(account: AccountRef): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childEnv(), ...account.env, BROWSER: 'true' };
  for (const key of account.unsetEnv) delete env[key];
  return env;
}

function sameEmail(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class LoginFlows {
  private readonly flows = new Map<string, Flow>();
  private readonly deps: LoginDeps;

  constructor(deps: Partial<LoginDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Whether the account has a login under way. */
  activeFor(accountId: string): boolean {
    return [...this.flows.values()].some((flow) => flow.account.id === accountId);
  }

  async start(account: AccountRef, protocol: AccountLoginProtocol, expectedEmail: string | null): Promise<StartedLogin> {
    if (this.activeFor(account.id)) throw new LoginError('login_in_progress', 'a login for this account is already under way');
    const argv = [...account.launch, ...protocol.loginArgs(expectedEmail)];
    let child: ChildProcess;
    try {
      child = this.deps.spawn(argv[0], argv.slice(1), { env: loginEnv(account), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch {
      throw new LoginError('login_start_failed', 'the CLI could not be started');
    }
    const flow: Flow = {
      id: randomUUID(), account, protocol, child, expectedEmail, state: 'awaiting_code',
      stdout: '', stderr: '', exitCode: undefined, onChange: null,
      timer: setTimeout(() => this.end(flow, 'timed out'), this.deps.loginTimeoutMs),
    };
    flow.timer.unref?.();
    this.flows.set(flow.id, flow);
    const keep = (buffer: string, chunk: string) => (buffer + chunk).slice(-MAX_BUFFER);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { flow.stdout = keep(flow.stdout, chunk); flow.onChange?.(); });
    child.stderr?.on('data', (chunk: string) => { flow.stderr = keep(flow.stderr, chunk); flow.onChange?.(); });
    child.stdin?.on('error', () => { /* reported through exit */ });
    child.on('error', () => { flow.exitCode = flow.exitCode ?? -1; flow.onChange?.(); });
    child.on('exit', (code) => { flow.exitCode = code ?? -1; flow.onChange?.(); });

    const url = await this.waitFor(flow, this.deps.promptTimeoutMs, () => {
      const prompt = protocol.readPrompt(flow.stdout);
      if (prompt) return prompt.url;
      return flow.exitCode !== undefined ? null : undefined;
    });
    if (!url) {
      this.end(flow, 'start failed');
      throw new LoginError('login_start_failed', 'the CLI did not offer a sign-in link');
    }
    flow.stdout = '';
    flow.stderr = '';
    this.deps.log(`${account.id} started`);
    return { loginId: flow.id, url, state: 'awaiting_code', expectedEmail };
  }

  async submit(loginId: string, code: string): Promise<CodeResult> {
    const flow = this.flows.get(loginId);
    if (!flow) throw new LoginError('login_not_found', 'no such login');
    if (flow.state !== 'awaiting_code') throw new LoginError('login_busy', 'a code for this login is being checked');
    const line = code.trim();
    if (!flow.protocol.codeLooksValid(line)) return { state: 'invalid_code', email: null, emailMatches: null };
    flow.state = 'verifying';
    flow.stdout = '';
    flow.stderr = '';
    flow.child.stdin?.write(`${line}\n`);
    const outcome = await this.waitFor(flow, this.deps.verifyTimeoutMs, () => {
      const said = flow.protocol.readOutcome(flow.stdout, flow.stderr);
      if (said) return said;
      if (flow.exitCode === undefined) return undefined;
      return flow.exitCode === 0 ? 'succeeded' : 'failed';
    }) ?? 'failed';
    if (outcome === 'invalid_code') {
      flow.state = 'awaiting_code';
      flow.stdout = '';
      flow.stderr = '';
      return { state: 'invalid_code', email: null, emailMatches: null };
    }
    if (outcome === 'failed') {
      this.end(flow, 'failed');
      return { state: 'failed', email: null, emailMatches: null };
    }
    // Let the CLI finish writing the credentials before asking who it is.
    await this.waitFor(flow, 5_000, () => (flow.exitCode !== undefined ? true : undefined));
    this.end(flow, 'succeeded');
    const statusArgv = [...flow.account.launch, ...flow.protocol.statusArgs];
    const status = await this.deps.runStatus(statusArgv, loginEnv(flow.account)).catch(() => null);
    const email = status ? flow.protocol.readEmail(status) : null;
    this.deps.onSucceeded(flow.account);
    return { state: 'succeeded', email, emailMatches: sameEmail(flow.expectedEmail, email) };
  }

  cancel(loginId: string): boolean {
    const flow = this.flows.get(loginId);
    if (!flow) return false;
    this.end(flow, 'cancelled');
    return true;
  }

  cancelAll(): void {
    for (const flow of [...this.flows.values()]) this.end(flow, 'cancelled');
  }

  // Resolves with what `check` finds (undefined: keep waiting), or null on timeout.
  private waitFor<T>(flow: Flow, timeoutMs: number, check: () => T | null | undefined): Promise<T | null> {
    return new Promise((resolve) => {
      const done = (value: T | null) => {
        clearTimeout(timer);
        flow.onChange = null;
        resolve(value);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      flow.onChange = () => {
        if (!this.flows.has(flow.id)) return done(null);
        const value = check();
        if (value !== undefined) done(value);
      };
      flow.onChange();
    });
  }

  private end(flow: Flow, outcome: string): void {
    if (!this.flows.delete(flow.id)) return;
    clearTimeout(flow.timer);
    if (flow.exitCode === undefined) {
      try { process.kill(-flow.child.pid!, 'SIGTERM'); } catch { flow.child.kill('SIGTERM'); }
    }
    flow.child.stdin?.destroy();
    flow.stdout = '';
    flow.stderr = '';
    flow.onChange?.();
    this.deps.log(`${flow.account.id} ${outcome}`);
  }
}
