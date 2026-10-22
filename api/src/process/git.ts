import * as projectStore from '../project-store.js';
import { git } from '../git/run.js';
import { repoInfo } from '../git/repo-reader.js';
import { resolveProjectRoot } from '../files/repo-paths.js';
import type { TurnGitChanges, TurnGitCommit, TurnGitRepo } from '../contract/process.js';
import type { ConversationSegment, ManagedSession } from '../types.js';
import { readConversationProcess } from './service.js';

// What changed in git while a turn went on (docs/specs/turn-process-
// levels.md §8): the commits made in its time — from its user message to
// the next one (to now for the last) — in the repos the CLI worked in.
// From git itself, not from the conversation: the transcript only says
// which folders the CLI was in. Other sessions committing to the same repo
// at the same time show too (the screen says so).

export const MAX_TURN_COMMITS = 50;

// Status letters git prints for a changed file (A, M, D, R100, …).
const STATUS = /^[ACDMRTUXB]\d*$/;

/** The folders the turn's records say the CLI was in, else the session's. */
function turnFolders(records: readonly unknown[], from: number, to: number, provider: 'claude' | 'codex'): string[] {
  const folders = new Set<string>();
  for (let i = from; i < to && i < records.length; i++) {
    const record = records[i] as Record<string, unknown> | null;
    if (!record || typeof record !== 'object') continue;
    if (provider === 'claude' && typeof record.cwd === 'string') folders.add(record.cwd);
    if (provider === 'codex' && record.type === 'turn_context') {
      const cwd = (record.payload as Record<string, unknown> | null)?.cwd;
      if (typeof cwd === 'string') folders.add(cwd);
    }
  }
  return [...folders];
}

function lastTimestamp(records: readonly unknown[], from: number, to: number): string | null {
  for (let i = Math.min(to, records.length) - 1; i >= from; i--) {
    const at = (records[i] as Record<string, unknown> | null)?.timestamp;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return at;
  }
  return null;
}

async function commitsIn(toplevel: string, since: string, until: string): Promise<{ commits: TurnGitCommit[]; truncated: boolean }> {
  const out = await git(toplevel, [
    'log', '--branches', 'HEAD', `--since=${since}`, `--until=${until}`, `--max-count=${MAX_TURN_COMMITS + 1}`,
    '--format=%H%x1f%cI%x1f%s%x1e',
  ]);
  const rows = out.split('\x1e').map((row) => row.trim()).filter(Boolean).map((row) => row.split('\x1f'));
  const commits: TurnGitCommit[] = [];
  for (const [sha, committedAt, subject] of rows.slice(0, MAX_TURN_COMMITS)) {
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    // The first parent's diff, as the Git area shows a commit.
    const names = await git(toplevel, ['diff-tree', '--no-commit-id', '--root', '-r', '-z', '--name-status', sha]);
    const parts = names.split('\0').filter((part) => part !== '');
    const files: TurnGitCommit['files'] = [];
    for (let i = 0; i < parts.length;) {
      const status = parts[i]!;
      if (!STATUS.test(status)) { i += 1; continue; }
      const renamed = status.startsWith('R') || status.startsWith('C');
      const file = renamed ? parts[i + 2] : parts[i + 1];
      if (file) files.push({ path: file, status: status[0]! });
      i += renamed ? 3 : 2;
    }
    commits.push({ sha, subject: subject ?? '', committedAt: committedAt ?? null, files });
  }
  return { commits, truncated: rows.length > MAX_TURN_COMMITS };
}

/** A project path (or a spawn's worktree) the Git area can open this repo by. */
async function projectRootFor(projectId: string, toplevel: string): Promise<string | null> {
  const project = await projectStore.getProject(projectId);
  const candidates = [...(project?.paths.map((entry) => entry.path) ?? []), toplevel];
  for (const candidate of candidates) {
    try {
      await resolveProjectRoot(projectId, candidate);
      if ((await repoInfo(candidate))?.toplevel === toplevel) return candidate;
    } catch { /* not one this project can open */ }
  }
  return null;
}

export async function turnGitChanges(session: ManagedSession, conversation: ConversationSegment, turnIndex: number, now = new Date()): Promise<TurnGitChanges | null> {
  const at = conversation.turns.findIndex((turn) => turn.index === turnIndex);
  const turn = conversation.turns[at];
  if (!turn) return null;
  const since = turn.user.at;
  const next = conversation.turns[at + 1]?.user.at ?? null;
  if (!since) return { since: null, until: next, repos: [] };

  let folders: string[] = [];
  let lastRecordAt: string | null = null;
  const read = await readConversationProcess(session, conversation).catch(() => null);
  if (read?.status === 'ok') {
    const found = read.process.turns.find((candidate) => candidate.user.at === since && candidate.user.text === turn.user.text);
    if (found) {
      folders = turnFolders(read.process.records, found.userSrc, found.endSrc, read.provider);
      lastRecordAt = lastTimestamp(read.process.records, found.userSrc, found.endSrc);
    }
  }
  if (folders.length === 0) folders = [session.cwd];
  // The latest turn ends where the CLI last wrote for it (a minute's grace
  // for a commit made by its last tool), now while it is still going.
  const going = session.activeConversationId === conversation.id && session.status === 'ready'
    && (session.turnPhase === 'replying' || session.turnPhase === 'awaiting_approval');
  const until = next
    ?? (!going && lastRecordAt ? new Date(Date.parse(lastRecordAt) + 60_000).toISOString() : null)
    ?? conversation.endedAt
    ?? now.toISOString();

  const repos: TurnGitRepo[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const info = await repoInfo(folder).catch(() => null);
    if (!info || seen.has(info.toplevel)) continue;
    seen.add(info.toplevel);
    const { commits, truncated } = await commitsIn(info.toplevel, since, until);
    const last = !next;
    let uncommitted: number | null = null;
    if (last) {
      const status = await git(info.toplevel, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).catch(() => null);
      uncommitted = status === null ? null : status.split('\0').filter((entry) => /^.. /.test(entry)).length;
    }
    repos.push({ root: info.toplevel, projectRoot: await projectRootFor(session.projectId, info.toplevel), commits, truncated, uncommitted });
  }
  return { since, until: next ? until : (going ? null : until), repos };
}
