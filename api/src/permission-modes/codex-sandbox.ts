import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from '../child-env.js';
import { getLaunchProfileCatalog } from '../launch-profiles.js';
import { codexSandboxState, setCodexSandboxState } from '../runtimes/codex-sandbox-state.js';

// Checks whether Codex's workspace-write sandbox can run a command on this
// host, with Codex's own `codex sandbox` (0.162.1: runs the command under
// the Linux sandbox; `-c sandbox_mode="workspace-write"` is the policy
// `--approve-for-me` uses). On a host whose AppArmor blocks bubblewrap it
// exits 1 with "bwrap: loopback: Failed RTM_NEWADDR"; with full access the
// same command exits 0. Run once at start-up and again when the settings
// are read and the answer is older than an hour. Any failure (no codex,
// timeout, non-zero exit) counts as unavailable. Nothing on the host is
// changed: the command runs `true` in an empty temporary folder.

export const CODEX_SANDBOX_MAX_AGE_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;

export type SandboxProbe = () => Promise<boolean>;

async function codexExecutable(): Promise<string> {
  try {
    const native = (await getLaunchProfileCatalog()).profiles.find((profile) => profile.source === 'native' && profile.runtimeId === 'codex-cli');
    if (native && native.source === 'native' && native.executable) return native.executable;
  } catch { /* the default below */ }
  return 'codex';
}

export const probeCodexSandbox: SandboxProbe = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hestia-codex-sandbox-'));
  try {
    const executable = await codexExecutable();
    return await new Promise<boolean>((resolve) => {
      const child = spawn(executable, ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'true'], {
        cwd, env: childEnv(), stdio: 'ignore',
      });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, PROBE_TIMEOUT_MS);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
  } catch {
    return false;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
};

let inflight: Promise<boolean> | null = null;

/** Probes now (one at a time) and records the answer. */
export function refreshCodexSandbox(probe: SandboxProbe = probeCodexSandbox): Promise<boolean> {
  inflight ??= probe()
    .catch(() => false)
    .then((available) => {
      setCodexSandboxState(available);
      return available;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Probes again only when never probed, or longer ago than `maxAgeMs`. */
export async function refreshCodexSandboxIfStale(maxAgeMs = CODEX_SANDBOX_MAX_AGE_MS, probe: SandboxProbe = probeCodexSandbox): Promise<void> {
  const { checkedAt } = codexSandboxState();
  if (checkedAt !== null && Date.now() - checkedAt < maxAgeMs) return;
  await refreshCodexSandbox(probe);
}
