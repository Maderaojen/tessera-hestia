import { describe, expect, it, vi } from 'vitest';
import { HANDOFF_MESSAGES } from '../../src/contract/continuity.js';
import { backfillSegmentHandoffs, derivedHandoff } from '../../src/continuity/segment-backfill.js';
import type { ConversationSegment, ManagedSession } from '../../src/types.js';

const BRIEF = '/work/repo/.hestia/handoffs/20261005-024513Z-dc6ee9c1.md';
const turn = (text: string) => ({ index: 0, user: { text, at: '' }, assistant: { text: 'ok', at: '' } });
const conversation = (patch: Partial<ConversationSegment>): ConversationSegment => ({
  id: 'c2', sequence: 2, startReason: 'provider_switch', turns: [], ...patch,
} as ConversationSegment);

describe('derivedHandoff', () => {
  it('from the briefing message: the short id, the file, the previous conversation', () => {
    const found = derivedHandoff(conversation({ turns: [turn(HANDOFF_MESSAGES.briefAsk(BRIEF)) as never] }), conversation({ id: 'c1', sequence: 1 }));
    expect(found).toEqual({
      handoffId: 'dc6ee9c1', trigger: null, fromConversationId: 'c1', briefSource: null, source: null, briefNote: null, briefNoteCode: null, confirm: null,
      briefAmended: null, derived: true, briefFile: '.hestia/handoffs/20261005-024513Z-dc6ee9c1.md',
    });
  });

  it('also the incoming LLM\'s briefing, and one after something else', () => {
    const turns = [turn('hi'), turn(HANDOFF_MESSAGES.briefIncomingAuto(BRIEF))] as never;
    expect(derivedHandoff(conversation({ turns }), undefined)).toMatchObject({ handoffId: 'dc6ee9c1', fromConversationId: null });
  });

  it.each([
    ['not a provider switch', conversation({ startReason: 'clear', turns: [turn(HANDOFF_MESSAGES.briefAsk(BRIEF)) as never] })],
    ['already marked', conversation({ handoff: { handoffId: 'x' } as never, turns: [turn(HANDOFF_MESSAGES.briefAsk(BRIEF)) as never] })],
    ['no briefing', conversation({ turns: [turn('請幫我看這個 .hestia/handoffs/x-dc6ee9c1.md') as never] })],
    ['a briefing without a brief file', conversation({ turns: [turn(HANDOFF_MESSAGES.briefAsk('/work/notes.md')) as never] })],
    ['a briefing too far in', conversation({ turns: [turn('a'), turn('b'), turn('c'), turn(HANDOFF_MESSAGES.briefAsk(BRIEF))] as never })],
  ])('none when %s', (_name, segment) => {
    expect(derivedHandoff(segment, undefined)).toBeNull();
  });
});

describe('backfillSegmentHandoffs', () => {
  it('fills in what is missing, once', async () => {
    const sessions = [{
      id: 's1',
      conversations: [
        conversation({ id: 'c2', sequence: 2, turns: [turn(HANDOFF_MESSAGES.briefAsk(BRIEF)) as never] }),
        conversation({ id: 'c1', sequence: 1, startReason: 'launch' }),
      ],
    }] as unknown as ManagedSession[];
    const updateConversation = vi.fn(async (_s: string, id: string, patch: Partial<ConversationSegment>) => {
      Object.assign(sessions[0]!.conversations!.find((c) => c.id === id)!, patch);
    });
    expect(await backfillSegmentHandoffs({ sessions: async () => sessions, updateConversation })).toBe(1);
    expect(updateConversation).toHaveBeenCalledWith('s1', 'c2', { handoff: expect.objectContaining({ handoffId: 'dc6ee9c1', fromConversationId: 'c1' }) });
    expect(await backfillSegmentHandoffs({ sessions: async () => sessions, updateConversation })).toBe(0);
  });
});
