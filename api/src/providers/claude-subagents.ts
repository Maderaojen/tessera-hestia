import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileExists } from './locate.js';
import { readJsonlLines } from './jsonl.js';
import type { OpenSubagent, SubagentStatus, SubagentSummary } from './types.js';

// Claude Code keeps each Agent-tool subagent in its own transcript, never in
// the main one (verified 2.1.283):
//   <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl   (isSidechain lines)
//   <projectDir>/<sessionId>/subagents/agent-<agentId>.meta.json
// The main transcript links to it: the Agent tool_use, then a user record
// whose `toolUseResult` names the agentId ('async_launched' for a background
// one, 'completed' when it ran in the foreground), then — for background
// ones — a <task-notification> naming it by <task-id> once it ends. A
// SendMessage to the agentId sets it running again.
//
// A conversation that continued in another transcript (followContinuation)
// carries this whole history over under its new session id, but subagents
// started before that stay under the old id's directory, so the file is
// looked up across the project directory rather than in one session's.

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
// Claude's agent ids are 'a' + 16 hex digits; accept a little more, never a path.
export const SUBAGENT_ID = /^[A-Za-z0-9]{6,64}$/;

type Draft = SubagentSummary & { toolUseId: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function notificationStatus(raw: string | undefined): SubagentStatus {
  switch (raw) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'stopped'; // stopped, killed, or anything newer that still means "ended"
  }
}

// Every text a record can carry a <task-notification> in: a user message
// (string or text blocks) or a queued_command attachment's prompt.
function recordTexts(rec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const content = asRecord(rec.message)?.content;
  if (typeof content === 'string') out.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      const text = str(asRecord(block)?.text);
      if (text) out.push(text);
    }
  }
  const prompt = asRecord(rec.attachment)?.prompt;
  if (typeof prompt === 'string') out.push(prompt);
  return out;
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;

// The poller asks every tick (openClaudeSubagents): the parse cache hands
// back the same array, grown in place, until the transcript changes, so a
// walk is redone only when there is something new in it. Callers never
// mutate what comes back.
const memo = new WeakMap<readonly unknown[], { length: number; agents: SubagentSummary[] }>();

export async function listClaudeSubagents(sessionFilePath: string): Promise<SubagentSummary[]> {
  const records = await readJsonlLines(sessionFilePath);
  const known = memo.get(records);
  if (known && known.length === records.length) return known.agents;
  const agents = subagentsOf(records);
  memo.set(records, { length: records.length, agents });
  return agents;
}

// The background agents still out by the main transcript: launched (or set
// running again by a SendMessage) with no <task-notification> since. The
// main transcript is the authority here — Claude writes every end there.
export async function openClaudeSubagents(sessionFilePath: string): Promise<OpenSubagent[]> {
  return (await listClaudeSubagents(sessionFilePath))
    .filter((agent) => agent.background && agent.status === 'running')
    .map((agent) => ({ agentId: agent.agentId, startedAt: agent.startedAt, since: agent.startedAt }));
}

function subagentsOf(records: readonly unknown[]): SubagentSummary[] {
  const byToolUse = new Map<string, Draft>();
  const byAgent = new Map<string, Draft>();

  for (const record of records) {
    const rec = asRecord(record);
    if (!rec) continue;
    const ts = str(rec.timestamp);
    const content = asRecord(rec.message)?.content;

    if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const raw of content) {
        const block = asRecord(raw);
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const input = asRecord(block.input) ?? {};
        if (AGENT_TOOL_NAMES.has(str(block.name) ?? '')) {
          byToolUse.set(block.id, {
            toolUseId: block.id, agentId: '', description: str(input.description) ?? '',
            subagentType: str(input.subagent_type), background: false, status: 'running',
            startedAt: ts, endedAt: null, summary: null,
          });
        } else if (block.name === 'SendMessage') {
          const resumed = byAgent.get(str(input.to) ?? '');
          if (resumed) Object.assign(resumed, { status: 'running', endedAt: null, summary: null });
        }
      }
      continue;
    }

    const result = asRecord(rec.toolUseResult);
    const agentId = str(result?.agentId);
    if (rec.type === 'user' && Array.isArray(content) && agentId && SUBAGENT_ID.test(agentId)) {
      for (const raw of content) {
        const block = asRecord(raw);
        const draft = block?.type === 'tool_result' ? byToolUse.get(str(block.tool_use_id) ?? '') : undefined;
        if (!draft) continue;
        draft.agentId = agentId;
        draft.background = result?.isAsync === true || result?.status === 'async_launched';
        if (!draft.background) {
          draft.status = block?.is_error === true ? 'failed' : 'completed';
          draft.endedAt = ts;
        }
        if (!draft.description) draft.description = str(result?.description) ?? '';
        byAgent.set(agentId, draft);
      }
    }

    for (const text of recordTexts(rec)) {
      for (const match of text.matchAll(NOTIFICATION)) {
        const body = match[1] ?? '';
        const status = notificationStatus(/<status>([^<]*)<\/status>/.exec(body)?.[1]?.trim());
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim() ?? null;
        // One notification can end several tasks at once (e.g. the parent
        // session ending while two are still out).
        for (const idMatch of body.matchAll(/<task-id>([^<]*)<\/task-id>/g)) {
          const draft = byAgent.get(idMatch[1]?.trim() ?? '');
          if (draft) Object.assign(draft, { status, endedAt: ts, summary });
        }
      }
    }
  }

  return [...byAgent.values()].map(({ toolUseId: _toolUseId, ...summary }) => summary);
}

// The subagent's own transcript, found only by an agentId the listing
// produced (the caller checks that), under this project directory.
export async function locateClaudeSubagentFile(sessionFilePath: string, agentId: string): Promise<string | null> {
  if (!SUBAGENT_ID.test(agentId)) return null;
  const projectDir = path.dirname(sessionFilePath);
  const name = `agent-${agentId}.jsonl`;
  const own = path.join(projectDir, path.basename(sessionFilePath, '.jsonl'), 'subagents', name);
  if (await fileExists(own)) return own;
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectDir, entry.name, 'subagents', name);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}
