import { describe, expect, it } from 'vitest';
import { emptyActiveMirror, newSegment } from '../src/registry/segments.js';
import type { ConversationSegment } from '../src/types.js';

describe('newSegment', () => {
  it('opens an empty, unbound segment numbered after the highest existing one', () => {
    const existing = [{ sequence: 1 }, { sequence: 4 }, { sequence: 2 }] as ConversationSegment[];
    const segment = newSegment(existing, {
      id: 'c', provider: 'codex', runtimeId: 'codex-cli', launchProfile: null, providerSessionId: null,
      startedAt: '2026-01-01T00:00:00Z', startReason: 'clear', transcriptTurnOffset: 0,
    });
    expect(segment).toEqual({
      id: 'c', sequence: 5, kind: 'cli', provider: 'codex', runtimeId: 'codex-cli', launchProfile: null, providerSessionId: null,
      startedAt: '2026-01-01T00:00:00Z', endedAt: null, startReason: 'clear', endReason: null,
      transcript: { state: 'pending', file: null, identity: null }, transcriptTurnOffset: 0,
      lastUserMessageAt: null, lastUserMessageText: null, deliveryUnconfirmedText: null, pendingInteraction: null,
      transcriptError: null, turns: [],
    });
    expect(newSegment([], { ...segment }).sequence).toBe(1);
  });

  it('never shares a turns array between two emptied mirrors', () => {
    expect(emptyActiveMirror().turns).not.toBe(emptyActiveMirror().turns);
  });
});
