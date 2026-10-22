import { Router } from 'express';
import type { SubagentSummary } from '../providers/types.js';
import * as registry from '../registry.js';
import { resolvedBinding } from '../sync/binding.js';
import { subagentOutlivedItsCli } from '../sync/backgroundAgents.js';
import type { ManagedSession } from '../types.js';
import { readSubagentProcess, subagentPublicTurns } from '../process/subagents.js';
import { sendError } from './errors.js';

export const subagentsRouter = Router();

// Any CLI's agent id, never a path: Claude's are 'a' + hex, Codex's are
// UUIDs. Each adapter checks its own shape strictly on top of this.
const AGENT_ID = /^[A-Za-z0-9-]{6,64}$/;

// A subagent runs inside its CLI's process: once the session's CLI is gone
// (or was relaunched after the subagent started), one the transcript last
// saw running will never write its end, so it is shown as stopped.
// (The poller's background count applies the same rule: sync/backgroundAgents.ts.)
export function settleStale(session: ManagedSession, agents: SubagentSummary[]): SubagentSummary[] {
  return agents.map((agent) => (
    agent.status === 'running' && subagentOutlivedItsCli(session, agent.startedAt) ? { ...agent, status: 'stopped' } : agent
  ));
}

// Subagents of the session's active conversation. Read only on request —
// a subagent's transcript can run to many MB, so the poller never touches
// it. A conversation with no attributed transcript, or a CLI whose
// subagents can't be read, simply has none to show. (The poller only
// counts the ones still out, cheaply: sync/backgroundAgents.ts.)
subagentsRouter.get('/:id/subagents', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const binding = resolvedBinding(session);
  const subagents = binding?.adapter.listSubagents ? await binding.adapter.listSubagents(binding.file) : [];
  res.json({ subagents: settleStale(session, subagents) });
});

// One subagent's messages, with its summary as of now (the read-only view
// polls this while it runs).
subagentsRouter.get('/:id/subagents/:agentId', async (req, res) => {
  const session = await registry.getSession(req.params.id);
  if (!session) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const { agentId } = req.params;
  const binding = resolvedBinding(session);
  const messages = binding?.adapter.readSubagentMessages && AGENT_ID.test(agentId)
    ? await binding.adapter.readSubagentMessages(binding.file, agentId)
    : null;
  if (!binding || !messages) {
    sendError(res, 404, 'subagent_not_found', 'subagent not found');
    return;
  }
  const listed = binding.adapter.listSubagents ? await binding.adapter.listSubagents(binding.file) : [];
  const subagent = settleStale(session, listed).find((agent) => agent.agentId.toLowerCase() === agentId.toLowerCase()) ?? null;
  // Its turns with their briefs (capability turn_process), when its
  // transcript reads that way; the messages stay for older clients.
  const process = await readSubagentProcess(session, agentId).catch(() => null);
  const turns = process ? subagentPublicTurns(process, subagent?.status === 'running') : undefined;
  res.json({ agentId, messages, subagent, ...(turns ? { turns } : {}) });
});
