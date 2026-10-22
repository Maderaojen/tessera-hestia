import path from 'node:path';
import { UUID_SHAPE } from '../ids.js';
import { codexMessages, lastTurnBoundary, rolloutSearchRoots } from './codex.js';
import { readFirstRecord, readJsonlLines, readTailRecords } from './jsonl.js';
import { walkFiles } from './locate.js';
import type { Msg } from './msg.js';
import type { OpenSubagent, SubagentStatus, SubagentSummary } from './types.js';

// Codex's native subagents (multi-agent threads), verified against 0.162.1
// (test/fixtures/subagents/codex.*.0.162.1.jsonl):
//
// The parent rollout records each one as an event_msg item_completed whose
// item is a SubAgentActivity — `kind` started / interacted / completed /
// interrupted, `agent_thread_id` (the child's thread id, a UUIDv7) and
// `agent_path` ("/root/<task name>"). Only this conversation's own
// `started` ones define its children. A child's rollout carries the same
// items for its talk with the parent, under agent_path "/root" — never a
// child of its own.
//
// The child is a rollout of its own in the same sessions tree (dated by its
// id, like any other). Its first session_meta names it (`id`), its parent
// (`parent_thread_id`), `thread_source: "subagent"`, its `agent_path`,
// `agent_nickname`, and `subagent_history_start_ordinal`: every record
// carries an `ordinal`, and the ones before that are a copy of the parent's
// history the child was forked with. Messages between the agents
// (response_item agent_message) are encrypted, the delegated task included;
// only the child's replies are written out in plain text — and the parent
// gets each final one as an agent_message headed "Message Type:
// FINAL_ANSWER" whose text is plain.
//
// First version: direct children (depth 1) only.

const DIRECT_CHILD_PATH = /^\/root\/[^/]+$/;

type Activity = { kind: string; ts: string | null; model: string | null };
type Draft = {
  agentId: string;
  agentPath: string;
  startedAt: string | null;
  model: string | null;
  lastKind: string;
  lastTs: string | null;
  finalAnswer: string | null;
};

type ChildRollout = {
  nickname: string | null;
  role: string | null;
  // The child's own records: the copied parent history left out.
  records: readonly unknown[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function subagentActivity(rec: Record<string, unknown>): (Activity & { agentId: string; agentPath: string; id: string | null }) | null {
  if (rec.type !== 'event_msg') return null;
  const payload = asRecord(rec.payload);
  if (payload?.type !== 'item_completed') return null;
  const item = asRecord(payload.item);
  if (item?.type !== 'SubAgentActivity') return null;
  const agentId = str(item.agent_thread_id);
  const agentPath = str(item.agent_path);
  const kind = str(item.kind);
  if (!agentId || !agentPath || !kind) return null;
  return { agentId: agentId.toLowerCase(), agentPath, kind, id: str(item.id), ts: str(rec.timestamp), model: str(item.model) };
}

// "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/x\nPayload:\n<text>"
function finalAnswer(rec: Record<string, unknown>): { sender: string; text: string } | null {
  if (rec.type !== 'response_item') return null;
  const payload = asRecord(rec.payload);
  if (payload?.type !== 'agent_message' || !Array.isArray(payload.content)) return null;
  const text = payload.content.map((block) => str(asRecord(block)?.text) ?? '').join('');
  const match = /^Message Type: FINAL_ANSWER\n(?:[^\n]*\n)*?Payload:\n([\s\S]*)$/.exec(text);
  const sender = str(payload.author);
  if (!match || !sender) return null;
  const body = match[1]?.trim();
  return body ? { sender, text: body } : null;
}

function rolloutId(records: readonly unknown[]): string | null {
  const first = asRecord(records[0]);
  if (first?.type !== 'session_meta') return null;
  return str(asRecord(first.payload)?.id)?.toLowerCase() ?? null;
}

// The children this conversation started, with what its own rollout says
// of each; their rollouts are read afterwards.
function readParentDrafts(records: readonly unknown[]): Draft[] {
  const byId = new Map<string, Draft>();
  const finals = new Map<string, string>();
  for (const record of records) {
    const rec = asRecord(record);
    if (!rec) continue;
    const activity = subagentActivity(rec);
    if (activity) {
      if (!UUID_SHAPE.test(activity.agentId) || !DIRECT_CHILD_PATH.test(activity.agentPath)) continue;
      const known = byId.get(activity.agentId);
      if (activity.kind === 'started' && !known) {
        byId.set(activity.agentId, {
          agentId: activity.agentId, agentPath: activity.agentPath, startedAt: activity.ts, model: activity.model,
          lastKind: 'started', lastTs: activity.ts, finalAnswer: null,
        });
      } else if (known) {
        known.lastKind = activity.kind;
        known.lastTs = activity.ts;
      }
      continue;
    }
    const answer = finalAnswer(rec);
    if (answer) finals.set(answer.sender, answer.text);
  }
  for (const draft of byId.values()) draft.finalAnswer = finals.get(draft.agentPath) ?? null;
  return [...byId.values()];
}

// The poller asks every tick (openCodexSubagents): the parse cache hands
// back the same array, grown in place, until the rollout changes, so a
// walk is redone only when there is something new in it.
const draftsMemo = new WeakMap<readonly unknown[], { length: number; drafts: Draft[] }>();

function parentDrafts(records: readonly unknown[]): Draft[] {
  const memo = draftsMemo.get(records);
  if (memo && memo.length === records.length) return memo.drafts;
  const drafts = readParentDrafts(records);
  draftsMemo.set(records, { length: records.length, drafts });
  return drafts;
}

// Where a child's rollout can be: the sessions tree the parent's sits in,
// on the dates the child's id gives (or the parent's own directory when
// that tree isn't the usual YYYY/MM/DD one).
function searchDirs(parentFile: string, agentId: string): string[] {
  const dayDir = path.dirname(parentFile);
  const monthDir = path.dirname(dayDir);
  const yearDir = path.dirname(monthDir);
  const dated = /^\d{2}$/.test(path.basename(dayDir)) && /^\d{2}$/.test(path.basename(monthDir)) && /^\d{4}$/.test(path.basename(yearDir));
  if (!dated) return [dayDir];
  const roots = rolloutSearchRoots(path.dirname(yearDir), agentId);
  return roots.length === 1 && roots[0] === path.dirname(yearDir) ? [dayDir] : roots;
}

type ChildFile = { file: string; meta: Record<string, unknown> };

// Child rollouts found, by parent file and child id: a rollout never moves
// once written, so the poller's checks look it up once. Kept small.
const childFiles = new Map<string, ChildFile>();
const MAX_CHILD_FILES = 64;

// The child's rollout, by its first record alone: its id, and this
// conversation as its parent.
async function locateChildRollout(parentFile: string, parentId: string, agentId: string): Promise<ChildFile | null> {
  if (!UUID_SHAPE.test(agentId)) return null;
  const id = agentId.toLowerCase();
  const key = `${parentFile}\n${id}`;
  const known = childFiles.get(key);
  if (known) return known;
  const suffix = `-${id}.jsonl`;
  const files = (await Promise.all(searchDirs(parentFile, agentId).map((dir) =>
    walkFiles(dir, (name) => name.startsWith('rollout-') && name.toLowerCase().endsWith(suffix)),
  ))).flat();
  for (const file of files) {
    const first = asRecord(await readFirstRecord(file));
    const meta = asRecord(first?.payload);
    if (first?.type !== 'session_meta' || !meta) continue;
    if (str(meta.id)?.toLowerCase() !== id) continue;
    if (str(meta.parent_thread_id)?.toLowerCase() !== parentId) continue;
    const found = { file, meta };
    childFiles.set(key, found);
    while (childFiles.size > MAX_CHILD_FILES) childFiles.delete(childFiles.keys().next().value!);
    return found;
  }
  return null;
}

async function readChildRollout(parentFile: string, parentId: string, agentId: string): Promise<ChildRollout | null> {
  const found = await locateChildRollout(parentFile, parentId, agentId);
  if (!found) return null;
  const { meta } = found;
  const spawn = asRecord(asRecord(asRecord(meta.source)?.subagent)?.thread_spawn);
  return {
    nickname: str(meta.agent_nickname) ?? str(spawn?.agent_nickname),
    role: str(meta.agent_role) ?? str(spawn?.agent_role),
    records: ownRecords(await readJsonlLines(found.file), meta.subagent_history_start_ordinal),
  };
}

// Leaves out the parent's history the child was forked with: the records
// before subagent_history_start_ordinal. Without that field, the child's
// own part begins with its first turn another agent set off: a task_started
// whose turn_attribution names an initiating_agent_path. The copied turns
// were the user's (null there), and there can be several of them, so "the
// first task_started after the copied session_meta" would not do.
function ownRecords(records: readonly unknown[], startOrdinal: unknown): readonly unknown[] {
  if (typeof startOrdinal === 'number' && Number.isFinite(startOrdinal)) {
    return records.filter((record) => {
      const ordinal = asRecord(record)?.ordinal;
      return typeof ordinal === 'number' && ordinal >= startOrdinal;
    });
  }
  const first = records.findIndex((record) => {
    const rec = asRecord(record);
    const payload = asRecord(rec?.payload);
    return rec?.type === 'event_msg' && payload?.type === 'task_started'
      && typeof asRecord(payload.turn_attribution)?.initiating_agent_path === 'string';
  });
  return first < 0 ? [] : records.slice(first);
}

function lastBoundaryRecord(records: readonly unknown[]): { type: string; ts: string | null; lastMessage: string | null } | null {
  const type = lastTurnBoundary(records);
  if (!type) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = asRecord(records[i]);
    const payload = asRecord(rec?.payload);
    if (rec?.type === 'event_msg' && payload?.type === type) {
      return { type, ts: str(rec.timestamp), lastMessage: str(payload.last_agent_message) };
    }
  }
  return { type, ts: null, lastMessage: null };
}

function statusOf(draft: Draft, child: ChildRollout | null): { status: SubagentStatus; endedAt: string | null; childAnswer: string | null } {
  const boundary = child ? lastBoundaryRecord(child.records) : null;
  if (boundary) {
    if (boundary.type === 'task_started') return { status: 'running', endedAt: null, childAnswer: null };
    return { status: boundary.type === 'task_complete' ? 'completed' : 'stopped', endedAt: boundary.ts, childAnswer: boundary.lastMessage };
  }
  // No rollout of its own to go by: what the parent last said of it.
  switch (draft.lastKind) {
    case 'completed': return { status: 'completed', endedAt: draft.lastTs, childAnswer: null };
    case 'interrupted': return { status: 'stopped', endedAt: draft.lastTs, childAnswer: null };
    default: return { status: 'running', endedAt: null, childAnswer: null };
  }
}

export async function listCodexSubagents(sessionFilePath: string): Promise<SubagentSummary[]> {
  const records = await readJsonlLines(sessionFilePath);
  const parentId = rolloutId(records);
  if (!parentId) return [];
  const drafts = parentDrafts(records);
  return Promise.all(drafts.map(async (draft) => {
    const child = await readChildRollout(sessionFilePath, parentId, draft.agentId);
    const { status, endedAt, childAnswer } = statusOf(draft, child);
    const task = draft.agentPath.split('/').at(-1) ?? draft.agentPath;
    return {
      agentId: draft.agentId,
      description: child?.nickname ? `${task} (${child.nickname})` : task,
      subagentType: child?.role ?? null,
      background: true,
      status,
      startedAt: draft.startedAt,
      endedAt,
      summary: status === 'running' ? null : (draft.finalAnswer ?? childAnswer),
      model: draft.model,
    };
  }));
}

// Only a child this conversation's own rollout started: the id never
// reaches the filesystem otherwise.
export async function readCodexSubagentMessages(sessionFilePath: string, agentId: string): Promise<Msg[] | null> {
  if (!UUID_SHAPE.test(agentId)) return null;
  const records = await readJsonlLines(sessionFilePath);
  const parentId = rolloutId(records);
  const id = agentId.toLowerCase();
  if (!parentId || !parentDrafts(records).some((draft) => draft.agentId === id)) return null;
  const child = await readChildRollout(sessionFilePath, parentId, id);
  return child ? codexMessages(child.records) : null;
}

// The child's own records (its copied parent history left out), under the
// same checks: process/subagents.ts reads its tools from them.
export async function readCodexSubagentRecords(sessionFilePath: string, agentId: string): Promise<readonly unknown[] | null> {
  if (!UUID_SHAPE.test(agentId)) return null;
  const records = await readJsonlLines(sessionFilePath);
  const parentId = rolloutId(records);
  const id = agentId.toLowerCase();
  if (!parentId || !parentDrafts(records).some((draft) => draft.agentId === id)) return null;
  return (await readChildRollout(sessionFilePath, parentId, id))?.records ?? null;
}

// The children still out by this conversation's own rollout alone: started,
// or set running again by a later interaction, with no completed or
// interrupted since. Read every poll (sync/backgroundAgents.ts), so nothing
// past the parent's cached records is touched.
export async function openCodexSubagents(sessionFilePath: string): Promise<OpenSubagent[]> {
  const records = await readJsonlLines(sessionFilePath);
  if (!rolloutId(records)) return [];
  return parentDrafts(records)
    .filter((draft) => draft.lastKind !== 'completed' && draft.lastKind !== 'interrupted')
    .map((draft) => ({ agentId: draft.agentId, startedAt: draft.startedAt, since: draft.lastTs }));
}

// Whether a child is still on a turn of its own, by the last turn boundary
// in its rollout's tail: the parent need not write that it ended (nothing
// waits on a background child once the parent's turn is over). null when
// its rollout can't be found or the tail has no boundary of its own.
export async function codexSubagentStillRunning(sessionFilePath: string, agentId: string): Promise<boolean | null> {
  const parentId = rolloutId(await readJsonlLines(sessionFilePath));
  if (!parentId) return null;
  const found = await locateChildRollout(sessionFilePath, parentId, agentId);
  const tail = found ? await readTailRecords(found.file) : null;
  if (!found || !tail) return null;
  // The parent's history the child was forked with sits at the head of the
  // file: only a tail that reaches the head (a short rollout) can hold any.
  const start = found.meta.subagent_history_start_ordinal;
  const whole = asRecord(tail[0])?.type === 'session_meta';
  const own = typeof start === 'number' || whole ? ownRecords(tail, start) : tail;
  const boundary = lastTurnBoundary(own);
  return boundary === null ? null : boundary === 'task_started';
}
