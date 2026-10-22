import { open } from 'node:fs/promises';
import * as registry from '../registry.js';
import { git, GitError } from '../git/run.js';
import { currentBranch } from '../git/worktree.js';
import type { SessionWorkspace } from '../contract/index.js';
import type { ManagedSession } from '../types.js';
import { activeConversation } from './binding.js';

// Which git checkout and branch a session's CLI is working in, for the chat
// header. The CLI can move after it started (Claude's EnterWorktree, a `cd`
// into another checkout), and neither the tmux's folder nor the pane's
// shell knows; the CLI's own transcript does: Claude writes `cwd` on every
// entry, Codex on its session_meta and turn_context lines
// (docs/reference/cli-version-alignment.md). A CLI that records no folder
// (Agy's SQLite store) falls back to the session's folder.

// Re-checked this often per session: a branch can change with nothing
// written to the transcript (a checkout in another terminal).
export const WORKSPACE_REFRESH_MS = 5_000;
// How far back from the end of the transcript to look for a folder. A
// single entry (a long tool result) can be bigger than this; then the
// folder last found is kept.
const TAIL_BYTES = 512 * 1024;

const lastChecked = new Map<string, number>();

/** The folder the transcript's last entry that names one records, or null. */
export async function lastRecordedCwd(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // The first line is cut off unless the read began at the start.
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.includes('"cwd"')) continue;
      try {
        const entry = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : entry.payload?.cwd;
        if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
      } catch {
        // A line still being written; an earlier one will do.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function defaultBranchOf(root: string): Promise<string | null> {
  const origin = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { okExitCodes: [1, 128] })).trim();
  if (origin) return origin.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    const out = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { okExitCodes: [1] });
    if (out.trim()) return name;
  }
  return null;
}

/**
 * The checkout `dir` is in; null when it isn't in one (or is gone).
 * undefined when git couldn't answer (timed out, missing): nothing known.
 */
export async function readWorkspace(dir: string): Promise<SessionWorkspace | null | undefined> {
  try {
    const [root, gitDir, commonDir] = (await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']))
      .split('\n').map((line) => line.trim());
    if (!root || !gitDir || !commonDir) return null;
    const branch = await currentBranch(root);
    return {
      root,
      branch,
      linkedWorktree: gitDir !== commonDir,
      defaultBranch: branch !== null && branch === await defaultBranchOf(root),
    };
  } catch (error) {
    if (error instanceof GitError && (error.kind === 'timeout' || error.kind === 'unavailable')) return undefined;
    return null;
  }
}

function sameWorkspace(a: SessionWorkspace | null | undefined, b: SessionWorkspace | null): boolean {
  if (!a || !b) return (a ?? null) === b;
  return a.root === b.root && a.branch === b.branch && a.linkedWorktree === b.linkedWorktree && a.defaultBranch === b.defaultBranch;
}

/** Looks again at most every WORKSPACE_REFRESH_MS; writes only a change. */
export async function refreshWorkspace(session: ManagedSession, now: number = Date.now()): Promise<void> {
  if (session.status === 'dead') return;
  if (now - (lastChecked.get(session.id) ?? -Infinity) < WORKSPACE_REFRESH_MS) return;
  lastChecked.set(session.id, now);
  const file = activeConversation(session)?.transcript.file;
  // Before the transcript names a folder the CLI is where it was launched,
  // the session's folder; once it has, an entry too big to read back keeps
  // the checkout last seen.
  const recorded = file?.endsWith('.jsonl') ? await lastRecordedCwd(file) : null;
  const dir = recorded ?? (file ? session.workspace?.root : undefined) ?? session.cwd;
  const workspace = await readWorkspace(dir);
  if (workspace === undefined || sameWorkspace(session.workspace, workspace)) return;
  await registry.updateSession(session.id, { workspace });
}

export function __resetWorkspaceChecksForTests(): void {
  lastChecked.clear();
}
