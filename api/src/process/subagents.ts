import type { PublicTurn } from '../contract/index.js';
import { listClaudeSubagents, locateClaudeSubagentFile } from '../providers/claude-subagents.js';
import { readCodexSubagentRecords } from '../providers/codex-subagents.js';
import { resolvedBinding } from '../sync/binding.js';
import type { ManagedSession } from '../types.js';
import { readTranscriptProcess, type ProcessProvider } from './cache.js';
import { claudeWholeTurn } from './claude.js';
import { codexProcessTurns, codexWholeTurn } from './codex.js';
import type { ProcessTurn } from './types.js';

// A subagent's own transcript read the same way as a conversation's
// (subagent view): its texts split into
// reply and progress, its tools and thinking. Only a subagent of the
// session's active conversation, as the subagent view itself (its id must
// be one that conversation's transcript names; never a path).
export type SubagentProcess = { provider: ProcessProvider; records: readonly unknown[]; turns: ProcessTurn[] };

export async function readSubagentProcess(session: ManagedSession, agentId: string): Promise<SubagentProcess | null> {
  const binding = resolvedBinding(session);
  const provider = binding?.conversation.provider;
  if (!binding || (provider !== 'claude' && provider !== 'codex')) return null;
  if (provider === 'claude') {
    if (!(await listClaudeSubagents(binding.file)).some((agent) => agent.agentId === agentId)) return null;
    const file = await locateClaudeSubagentFile(binding.file, agentId);
    if (!file) return null;
    const read = await readTranscriptProcess(file, 'claude');
    if (read.status !== 'ok') return null;
    const whole = read.turns.length === 0 ? claudeWholeTurn(read.records) : null;
    return { provider, records: read.records, turns: whole ? [whole] : read.turns };
  }
  const records = await readCodexSubagentRecords(binding.file, agentId);
  if (!records) return null;
  const turns = codexProcessTurns(records);
  const whole = turns.length === 0 ? codexWholeTurn(records) : null;
  return { provider, records, turns: whole ? [whole] : turns };
}

/** The subagent's turns as the chat shows a conversation's, each with its brief. */
export function subagentPublicTurns(process: SubagentProcess, running: boolean): PublicTurn[] {
  return process.turns.map((turn, i) => {
    const firstText = turn.events.find((event) => event.type === 'text');
    const open = running && i === process.turns.length - 1;
    return {
      index: i + 1,
      user: { text: turn.user.text, at: turn.user.at },
      assistant: {
        text: turn.assistantText,
        at: firstText?.type === 'text' ? firstText.at : null,
        ...(turn.interrupted ? { interrupted: true as const } : {}),
      },
      process: { status: 'available', open, parts: turn.parts, counts: turn.counts },
    };
  });
}
