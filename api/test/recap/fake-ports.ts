import type { LaunchOption } from '../../src/contract/meta.js';
import type { ConversationRecapEvent, ConversationRecapItem, ConversationRecapModelCatalog } from '../../src/contract/recap.js';
import type { Turn } from '../../src/contract/sessions.js';
import type { RecapAccountState, RecapConversation, RecapPorts, RecapRunRequest, RecapRunResult } from '../../src/recap/ports.js';
import { RECAP_CONVERSATION_END, RECAP_CONVERSATION_START } from '../../src/recap/prompt.js';
import type { RecapOutput } from '../../src/recap/schema.js';
import { emptyRecapFile, foldBatch, type ConversationRecapFile } from '../../src/recap/store.js';

// An in-memory app for recap/ tests: sessions' conversations, their recap
// files, the accounts and their models, a CLI that answers from the
// prompt it is given, and a log of runs and events.

export const T0 = Date.parse('2026-10-05T01:00:00.000Z');
export const at = (ms: number) => new Date(ms).toISOString();
export const MIN = 60_000;

export function turn(index: number, userAt: string | null = at(T0 + index * 1000), text = `第 ${index} 輪的要求`): Turn {
  return { index, user: { text, at: userAt }, assistant: { text: `第 ${index} 輪的回覆`, at: userAt } };
}

export function turns(count: number, from = T0): Turn[] {
  return Array.from({ length: count }, (_v, i) => turn(i, at(from + i * 1000)));
}

export function conversation(sessionId: string, conversationId: string, list: Turn[], patch: Partial<RecapConversation> = {}): RecapConversation {
  return {
    sessionId, conversationId, tmuxName: `hestia-${sessionId}`, projectId: 'p1', provider: 'codex',
    sequence: 1, startedAt: at(T0), endedAt: null, turns: list, replying: false, trashed: false, ...patch,
  };
}

/** The turns and the recap so far, as the model reads them from a prompt. */
export function readPrompt(prompt: string): { previous: { id: string }[]; turns: { index: number }[] } {
  const previous = JSON.parse(/^上一版清單：(.*)$/m.exec(prompt)![1]!) as { id: string }[];
  const start = prompt.indexOf(RECAP_CONVERSATION_START) + RECAP_CONVERSATION_START.length;
  return { previous, turns: JSON.parse(prompt.slice(start, prompt.indexOf(RECAP_CONVERSATION_END))) as { index: number }[] };
}

/** What a well-behaved model answers: the recap so far as it was, plus one item for the batch. */
export function answerFor(prompt: string): RecapOutput {
  const { previous, turns: batch } = readPrompt(prompt);
  const kept = (previous as ConversationRecapItem[]).map((item) => ({ id: item.id, title: item.title, status: item.status, turns: item.turns, mergedFrom: [] }));
  const range = { from: batch[0]!.index, to: batch.at(-1)!.index };
  return { items: [...kept, { id: null, title: `第 ${range.from}–${range.to} 輪`, status: 'uncertain', turns: range, mergedFrom: [] }] };
}

const keyOf = (sessionId: string, conversationId: string) => `${sessionId}\n${conversationId}`;

export type World = {
  conversations: Map<string, RecapConversation>;
  recaps: Map<string, ConversationRecapFile>;
  profiles: LaunchOption[];
  models: Map<string, ConversationRecapModelCatalog>;
  accounts: Map<string, RecapAccountState>;
  // Answers for the next runs, in order; once used up, answerFor.
  answers: (RecapRunResult | ((request: RecapRunRequest) => RecapRunResult | Promise<RecapRunResult>))[];
  runs: RecapRunRequest[];
  events: ConversationRecapEvent[];
  now: Date;
};

export function newWorld(): World {
  return {
    conversations: new Map(),
    recaps: new Map(),
    profiles: [
      { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', label: 'Codex (原生)', source: 'native' },
      { id: 'janus:claude:personal', provider: 'claude', runtimeId: 'claude-code', label: 'Claude · personal', source: 'janus', profileName: 'personal' },
    ],
    models: new Map([
      ['native:codex', {
        runtimeId: 'codex-cli', source: 'account', fetchedAt: at(T0),
        options: [
          { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true },
          { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', isDefault: false },
        ],
      }],
      ['janus:claude:personal', {
        runtimeId: 'claude-code', source: 'builtin', fetchedAt: at(T0),
        options: [{ id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, isDefault: false }],
      }],
    ]),
    accounts: new Map<string, RecapAccountState>([
      ['native:codex', { available: true, label: 'Codex (原生)', runtimeId: 'codex-cli', limited: null }],
      ['janus:claude:personal', { available: true, label: 'Claude · personal', runtimeId: 'claude-code', limited: null }],
    ]),
    answers: [],
    runs: [],
    events: [],
    now: new Date(T0),
  };
}

export function addConversation(world: World, item: RecapConversation): RecapConversation {
  world.conversations.set(keyOf(item.sessionId, item.conversationId), item);
  return item;
}

export function recapOf(world: World, sessionId: string, conversationId: string): ConversationRecapFile | undefined {
  return world.recaps.get(keyOf(sessionId, conversationId));
}

export function setRecap(world: World, owner: RecapConversation, patch: Partial<ConversationRecapFile>): void {
  world.recaps.set(keyOf(owner.sessionId, owner.conversationId), { ...emptyRecapFile(owner), ...patch });
}

export function fakePorts(world: World): RecapPorts {
  const copy = <T>(value: T): T => structuredClone(value);
  const live = () => [...world.conversations.values()];
  return {
    listConversations: async () => copy(live()),
    listSessionConversations: async (sessionId) => {
      const found = live().filter((item) => item.sessionId === sessionId);
      return found.length && !found[0]!.trashed ? copy(found) : null;
    },
    getConversation: async (sessionId, conversationId) => copy(world.conversations.get(keyOf(sessionId, conversationId)) ?? null),
    readRecap: async (owner) => copy(recapOf(world, owner.sessionId, owner.conversationId) ?? null),
    applyBatch: async (owner, write) => {
      const found = recapOf(world, owner.sessionId, owner.conversationId);
      const result = foldBatch(copy(found ?? emptyRecapFile(owner)), !!found, write);
      if (result.ok) world.recaps.set(keyOf(owner.sessionId, owner.conversationId), copy(result.recap));
      return result;
    },
    updateRecap: async (owner, mutate) => {
      const found = recapOf(world, owner.sessionId, owner.conversationId);
      const next = mutate(copy(found ?? emptyRecapFile(owner)), !!found);
      if (next) world.recaps.set(keyOf(owner.sessionId, owner.conversationId), copy(next));
      return copy(next ?? found ?? null);
    },
    setItemStatus: async (owner, itemId, status, now) => {
      const found = recapOf(world, owner.sessionId, owner.conversationId);
      const item = found?.items.find((candidate) => candidate.id === itemId);
      if (!found || !item) return null;
      Object.assign(item, { status, statusSource: 'user', statusChangedAt: now, updatedAt: now });
      return copy(found);
    },
    runBatch: async (request) => {
      world.runs.push(request);
      const next = world.answers.shift();
      if (!next) return { ok: true, output: answerFor(request.prompt) };
      return typeof next === 'function' ? next(request) : next;
    },
    listProfiles: async () => copy(world.profiles),
    listModels: async (profileId) => {
      const catalog = world.models.get(profileId);
      if (!catalog) throw new Error('model/list failed');
      return copy(catalog);
    },
    accountState: async (profileId) => copy(world.accounts.get(profileId) ?? { available: false }),
    now: () => world.now,
    publish: (event) => { world.events.push(event); },
  };
}
