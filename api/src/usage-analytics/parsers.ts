import { createHash } from 'node:crypto';

export type UsageEvent = {
  id: string; provider: 'claude' | 'codex'; sessionId: string; timestamp: string;
  model: string | null; input: number; output: number; cached: number; cacheWrite: number;
  reasoning: number; cwd: string | null; cacheWrite1h?: number; serviceTier?: string | null; inferenceGeo?: string | null;
};
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const token = (value: unknown): number | null => value === undefined ? 0 : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const key = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export type ParserState = { sessionId: string; model: string | null; cwd: string | null; baseline: number[]; hasBaseline: boolean; inherited: boolean; startedAt: string | null; generation: number; warnings: string[] };
export function createUsageParser(provider: 'claude' | 'codex', fallbackSession: string, previous?: ParserState) {
  let sessionId = fallbackSession;
  let model: string | null = null;
  let cwd: string | null = null;
  let baseline: number[] = [0, 0, 0, 0];
  let hasBaseline = false;
  let inherited = false;
  let startedAt: string | null = null;
  let generation = 0;
  const warnings = new Set<string>(previous?.warnings);
  if (previous) ({ sessionId, model, cwd, baseline, hasBaseline, inherited, startedAt, generation } = previous);
  return {
    get warnings(): string[] { return [...warnings]; },
    snapshot(): ParserState { return { sessionId, model, cwd, baseline, hasBaseline, inherited, startedAt, generation, warnings: [...warnings] }; },
    parse(raw: unknown): UsageEvent | null {
      const row = object(raw);
      const payload = object(row.payload);
      const stamp = string(row.timestamp);
      if (provider === 'codex') {
        if (row.type === 'session_meta') {
          sessionId = string(payload.id) ?? fallbackSession;
          cwd = string(payload.cwd);
          inherited = Boolean(payload.forked_from_id || payload.forked_from || payload.parent_session_id || payload.parent_thread_id);
          startedAt = stamp;
          return null;
        }
        if (row.type === 'turn_context') { model = string(payload.model); cwd = string(payload.cwd) ?? cwd; return null; }
        if (row.type === 'token_usage_record' || payload.type === 'token_usage_record') warnings.add('unsupported_compaction_usage');
        if (row.type !== 'event_msg' || payload.type !== 'token_count') return null;
        const info = object(payload.info);
        const usage = object(info.total_token_usage);
        if (!Object.keys(usage).length) return null;
        const counters = [usage.input_tokens, usage.cached_input_tokens, usage.output_tokens, usage.reasoning_output_tokens].map(token);
        if (counters.some((n) => n === null) || !stamp || !Number.isFinite(Date.parse(stamp))) { warnings.add('invalid_usage'); return null; }
        const next = counters as number[];
        if (next[1]! > next[0]! || next[3]! > next[2]!) { warnings.add('invalid_usage'); return null; }
        if ((inherited && !hasBaseline) || (startedAt && Date.parse(stamp) <= Date.parse(startedAt))) {
          baseline = next; hasBaseline = true; warnings.add('codex_inherited_baseline'); return null;
        }
        if (next.some((n, i) => n < baseline[i]!)) {
          // A reset may be compaction or inherited history. Skip the uncertain
          // baseline rather than assigning prior usage to a new request/date.
          warnings.add('codex_counter_reset'); return null;
        }
        let delta = next.map((n, i) => n - baseline[i]!);
        const last = object(info.last_token_usage);
        if (!hasBaseline && Object.keys(last).length) {
          const lastCounters = [last.input_tokens, last.cached_input_tokens, last.output_tokens, last.reasoning_output_tokens].map(token);
          if (lastCounters.every((n, i) => n !== null && n <= next[i]!)) delta = lastCounters as number[];
          else { warnings.add('invalid_usage'); baseline = next; hasBaseline = true; return null; }
        }
        baseline = next; hasBaseline = true;
        if (delta[1]! > delta[0]! || delta[3]! > delta[2]!) { warnings.add('invalid_usage_delta'); return null; }
        if (!delta[0] && !delta[2]) return null;
        return { id: key([provider, sessionId, generation, next]), provider, sessionId, timestamp: new Date(stamp).toISOString(), model,
          input: Math.max(0, delta[0]! - delta[1]!), cached: delta[1]!, output: delta[2]!, reasoning: delta[3]!, cacheWrite: 0, cwd };
      }
      if (row.type !== 'assistant') return null;
      if (row.isApiErrorMessage === true || row.isSynthetic === true) { warnings.add('synthetic_usage_skipped'); return null; }
      const message = object(row.message);
      const usage = object(message.usage);
      if (message.model === '<synthetic>') { warnings.add('synthetic_usage_skipped'); return null; }
      if (!Object.keys(usage).length) return null;
      const request = string(row.requestId);
      const messageId = string(message.id) ?? string(row.uuid);
      const identity = request && messageId ? [request, messageId] : messageId ? [messageId] : null;
      const sid = string(row.sessionId) ?? fallbackSession;
      const counters = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].map(token);
      if (!identity || !stamp || !Number.isFinite(Date.parse(stamp)) || counters.some((n) => n === null)) { warnings.add('invalid_usage'); return null; }
      const reasoning = token(object(usage.output_tokens_details).thinking_tokens);
      if (reasoning === null || reasoning > counters[1]!) { warnings.add('invalid_usage'); return null; }
      return { id: key([provider, identity]), provider, sessionId: sid, timestamp: new Date(stamp).toISOString(), model: string(message.model),
        input: counters[0]!, output: counters[1]!, cached: counters[2]!, cacheWrite: counters[3]!, reasoning, cwd: string(row.cwd), cacheWrite1h: token(object(usage.cache_creation).ephemeral_1h_input_tokens) ?? 0, serviceTier: string(usage.service_tier), inferenceGeo: string(usage.inference_geo) };
    },
  };
}
