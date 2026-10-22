import { execFile } from 'node:child_process';
import { childEnv } from '../child-env.js';

// The one place the API runs git: the project files and git view, all
// read-only, and a delegation's worktree (worktree.ts, the only writes).
// Every call:
// - takes no optional locks, so it never fights the CLI working in the same
//   repo for index.lock;
// - reads pathspecs literally, and a rev given by a client goes after
//   --end-of-options, so no argument can turn into an option or pathspec
//   magic;
// - turns off what a repo's own config could run (fsmonitor; diff drivers
//   and textconv are off per command) and anything that would ask for input;
// - is capped in time, output and concurrency.

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_CONCURRENT = 4;

const GLOBAL_ARGS = [
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'color.ui=false',
  '-c', 'log.showSignature=false',
];

// Variables that would point git somewhere else than the folder it runs in.
const REDIRECTING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

export type GitErrorKind = 'not_repo' | 'timeout' | 'unavailable' | 'dubious_ownership' | 'failed';

export class GitError extends Error {
  constructor(public readonly kind: GitErrorKind, message: string) {
    super(message);
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = childEnv();
  for (const name of REDIRECTING_ENV) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

let running = 0;
const waiting: Array<() => void> = [];

async function slot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  return () => {
    running -= 1;
    waiting.shift()?.();
  };
}

export type GitRunOptions = {
  // Exit codes that still count as an answer (check-ignore, diff --no-index).
  okExitCodes?: number[];
  input?: string;
  // check-ignore refuses --literal-pathspecs (its caller keeps magic out).
  literalPathspecs?: boolean;
  // Longer than the default for a command that writes a whole checkout
  // (git worktree add).
  timeoutMs?: number;
};

/** Runs `git <args>` in `cwd` and answers its stdout. */
export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  return (await run(cwd, args, options)).toString('utf8');
}

/** As git(), but stdout as bytes: a blob that may not be text. */
export async function gitBytes(cwd: string, args: string[], options: GitRunOptions = {}): Promise<Buffer> {
  return run(cwd, args, options);
}

async function run(cwd: string, args: string[], options: GitRunOptions): Promise<Buffer> {
  const release = await slot();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const globals = options.literalPathspecs === false ? GLOBAL_ARGS.filter((arg) => arg !== '--literal-pathspecs') : GLOBAL_ARGS;
      let inputError: NodeJS.ErrnoException | null = null;
      const child = execFile('git', [...globals, ...args], {
        cwd, env: gitEnv(), timeout: options.timeoutMs ?? TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'buffer',
      }, (error, stdout, stderr) => {
        if (!error) {
          if (inputError) { reject(toGitError(inputError, '')); return; }
          resolve(stdout);
          return;
        }
        const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        if (typeof failure.code === 'number' && options.okExitCodes?.includes(failure.code)) {
          resolve(stdout);
          return;
        }
        reject(toGitError(failure, stderr.toString('utf8')));
      });
      // Nothing here reads a terminal; closing stdin keeps a command that
      // would wait for input from hanging until the timeout.
      // A fast command can close its pipe before this write completes.
      // EPIPE is expected in that case; its exit result remains authoritative.
      // The stdin stream has its own error event, separate from execFile's
      // callback, and leaving it unhandled would crash the API process.
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') inputError = error;
      });
      if (options.input === undefined) child.stdin?.end();
      else child.stdin?.end(options.input);
    });
  } finally {
    release();
  }
}

function toGitError(error: NodeJS.ErrnoException & { killed?: boolean }, stderr: string): GitError {
  if (error.code === 'ENOENT') return new GitError('unavailable', 'git is not installed on this host');
  if (error.killed) return new GitError('timeout', 'git took too long');
  if (/dubious ownership/i.test(stderr)) return new GitError('dubious_ownership', stderr.trim());
  if (/not a git repository/i.test(stderr)) return new GitError('not_repo', stderr.trim());
  return new GitError('failed', stderr.trim() || error.message);
}
