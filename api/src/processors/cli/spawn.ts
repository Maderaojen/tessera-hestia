import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Running the CLI: in its own process group, the input on stdin, its
// output collected up to a limit, and the whole group killed when it
// takes too long or once it has finished.

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

export type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; error: NodeJS.ErrnoException | null };

// The runner's folder holds nothing between runs: whatever is in it goes.
export async function emptyRunnerDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(dir)) await rm(path.join(dir, entry), { recursive: true, force: true });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch { /* already gone */ }
}

export function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string, input: string, timeoutMs: number): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const out = { stdout: '', stderr: '' };
    let timedOut = false;
    let settled = false;
    let killer: ReturnType<typeof setTimeout> | null = null;
    const finish = (exit: Omit<Exit, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      // Anything it left running in its group goes with it.
      killGroup(child.pid, 'SIGTERM');
      resolve({ ...exit, ...out, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      killer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
      killer.unref?.();
    }, timeoutMs);
    const collect = (name: 'stdout' | 'stderr') => (chunk: string) => {
      if (out[name].length < OUTPUT_LIMIT) out[name] += chunk;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, signal: null, error }));
    child.on('close', (code, signal) => finish({ code, signal, error: null }));
    child.stdin?.on('error', () => { /* reported through close */ });
    child.stdin?.end(input);
  });
}
