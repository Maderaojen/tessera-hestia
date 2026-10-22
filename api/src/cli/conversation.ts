// `hestia conversation show`: a conversation the app recorded, printed as
// markdown to stdout — nothing is written to disk (ADR 0023: the same
// conversation is never kept twice).
//
//   hestia conversation show [--upstream | --session <id> [--conversation <cid>]] [--last N | --turns a..b]
//
// With no session, this tmux's own conversation. `--upstream` is a branch
// line's or a delegate's: the conversation it was forked or delegated from,
// up to the turn it was forked at, or the turns there were when it was
// delegated (its fork from HESTIA_FORK_ID, else its delegation from
// HESTIA_DELEGATION_ID, both set on its tmux; without either, the fork and
// then the delegation whose session this tmux is). `--last N` keeps the
// last N turns of those, `--turns a..b` the turns whose Turn.index is a to b
// (either end may be left out).
import type { ConversationDetail, SessionDto } from '../contract/sessions.js';
import { formatConversationExport } from '../continuity/brief.js';
import { t } from '../i18n/index.js';

export type ConversationDeps = {
  api<T>(route: string, init?: { method?: string; body?: unknown }): Promise<T>;
  fail(message: string): never;
  env: NodeJS.ProcessEnv;
  // The name of the tmux session this runs in, or null outside tmux.
  tmuxName(): string | null;
  now(): Date;
  log(text: string): void;
};

export const CONVERSATION_USAGE = 'usage: hestia conversation show [--upstream | --session <id> [--conversation <cid>]] [--last N | --turns a..b]';

// What `--upstream` reads from a fork (GET /api/forks/:id, contract/fork.ts)
// and from a delegation (GET /api/delegations/:id, contract/delegation.ts).
type ForkOrigin = { id: string; childSessionId: string; closedAt: string | null; origin: { sessionId: string; conversationId: string; turnsAtFork: number } };
type DelegationOrigin = { id: string; childSessionId: string | null; parentSessionId: string | null; parentConversationId: string | null; parentTurnsAtStart?: number | null };

/** Where `--upstream` reads: a conversation, up to its `upTo`th turn (null: all of it). */
type Upstream = { sessionId: string; conversationId: string; upTo: number | null };


export type ShowArgs = {
  source: { kind: 'own' } | { kind: 'upstream' } | { kind: 'session'; sessionId: string; conversationId: string | null };
  range: { kind: 'all' } | { kind: 'last'; count: number } | { kind: 'turns'; from: number | null; to: number | null };
};

/** `show`'s options, or a message saying what is wrong with them. */
export function parseShowArgs(args: string[]): ShowArgs | string {
  let upstream = false;
  let sessionId: string | null = null;
  let conversationId: string | null = null;
  let range: ShowArgs['range'] = { kind: 'all' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--upstream') {
      upstream = true;
    } else if (arg === '--session' || arg === '--conversation' || arg === '--last' || arg === '--turns') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      if (arg === '--session') sessionId = value;
      else if (arg === '--conversation') conversationId = value;
      else if (range.kind !== 'all') return 'give at most one of --last or --turns';
      else if (arg === '--last') {
        if (!/^[1-9]\d*$/.test(value)) return '--last needs a number of turns (1 or more)';
        range = { kind: 'last', count: Number(value) };
      } else {
        const match = /^(\d*)\.\.(\d*)$/.exec(value);
        if (!match || (!match[1] && !match[2])) return '--turns needs a range like 3..8, 3.. or ..8';
        range = { kind: 'turns', from: match[1] ? Number(match[1]) : null, to: match[2] ? Number(match[2]) : null };
      }
    } else {
      return `unknown option ${arg}`;
    }
  }
  if (upstream && (sessionId || conversationId)) return '--upstream reads the conversation this branch line or delegation came from; leave out --session and --conversation';
  if (conversationId && !sessionId) return '--conversation needs --session';
  const source: ShowArgs['source'] = upstream ? { kind: 'upstream' }
    : sessionId ? { kind: 'session', sessionId, conversationId }
      : { kind: 'own' };
  return { source, range };
}

/** The turns `range` keeps: `--turns` by their numbers, `--last` from the end. */
export function selectTurns<T extends { index: number }>(turns: readonly T[], range: ShowArgs['range']): T[] {
  if (range.kind === 'last') return turns.slice(-range.count);
  if (range.kind === 'turns') return turns.filter((turn) => (range.from === null || turn.index >= range.from) && (range.to === null || turn.index <= range.to));
  return [...turns];
}

async function ownSessionId(deps: ConversationDeps): Promise<string | null> {
  const name = deps.tmuxName();
  if (!name) return null;
  const sessions = await deps.api<{ id: string; tmuxName: string }[]>('/sessions');
  return sessions.find((session) => session.tmuxName === name)?.id ?? null;
}

function fromFork(fork: ForkOrigin): Upstream {
  return { sessionId: fork.origin.sessionId, conversationId: fork.origin.conversationId, upTo: fork.origin.turnsAtFork };
}

function fromDelegation(delegation: DelegationOrigin, deps: ConversationDeps): Upstream {
  if (!delegation.parentSessionId || !delegation.parentConversationId) deps.fail(t('cli.conversation.noDelegator'));
  // One made before the count was kept: all of it.
  return { sessionId: delegation.parentSessionId, conversationId: delegation.parentConversationId, upTo: delegation.parentTurnsAtStart ?? null };
}

/** A branch line's main line, else a delegate's delegating conversation. */
async function upstreamOf(deps: ConversationDeps): Promise<Upstream> {
  const forkId = deps.env.HESTIA_FORK_ID?.trim();
  if (forkId) return fromFork((await deps.api<{ fork: ForkOrigin }>(`/forks/${encodeURIComponent(forkId)}`)).fork);
  const delegationId = deps.env.HESTIA_DELEGATION_ID?.trim();
  if (delegationId) return fromDelegation((await deps.api<{ delegation: DelegationOrigin }>(`/delegations/${encodeURIComponent(delegationId)}`)).delegation, deps);
  const own = await ownSessionId(deps) ?? deps.fail(t('cli.conversation.notUpstream'));
  const query = `?session=${encodeURIComponent(own)}`;
  const { forks } = await deps.api<{ forks: ForkOrigin[] }>(`/forks${query}`);
  const fork = forks.find((item) => item.childSessionId === own);
  if (fork) return fromFork(fork);
  const { delegations } = await deps.api<{ delegations: DelegationOrigin[] }>(`/delegations${query}`);
  const delegation = delegations.find((item) => item.childSessionId === own);
  return delegation ? fromDelegation(delegation, deps) : deps.fail(t('cli.conversation.notUpstream'));
}

export async function conversationCommand(args: string[], deps: ConversationDeps): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== 'show') deps.fail(CONVERSATION_USAGE);
  const parsed = parseShowArgs(rest);
  if (typeof parsed === 'string') deps.fail(`${parsed}\n${CONVERSATION_USAGE}`);
  let sessionId: string;
  let conversationId: string | null = null;
  // `--upstream` stops where the branch line was forked, or the delegation made.
  let upTo: number | null = null;
  if (parsed.source.kind === 'upstream') {
    ({ sessionId, conversationId, upTo } = await upstreamOf(deps));
  } else if (parsed.source.kind === 'session') {
    sessionId = parsed.source.sessionId;
    conversationId = parsed.source.conversationId;
  } else {
    sessionId = await ownSessionId(deps) ?? deps.fail('not in a tmux the Hestia app manages; give --session');
  }
  const session = await deps.api<SessionDto>(`/sessions/${encodeURIComponent(sessionId)}`);
  conversationId ??= session.activeConversationId ?? session.conversations.at(-1)?.id ?? deps.fail('this session has no conversation yet');
  const conversation = await deps.api<ConversationDetail>(`/sessions/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`);
  const turns = selectTurns(upTo === null ? conversation.turns : conversation.turns.slice(0, upTo), parsed.range);
  deps.log(formatConversationExport({
    fromLabel: conversation.launchProfile?.profileName ?? conversation.runtimeId ?? conversation.provider,
    cwd: session.cwd,
    now: deps.now(),
    turns,
  }));
}
