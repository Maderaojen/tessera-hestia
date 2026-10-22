import { describe, expect, it } from 'vitest';
import { DELEGATION_MESSAGES, delegationMessageKind } from '../../src/contract/delegation.js';
import { HANDOFF_MESSAGES, handoffMessageKind } from '../../src/contract/continuity.js';

// How a client tells the delegation's own messages from the user's (to
// label them, and not to warn about their delivery).

describe('delegationMessageKind', () => {
  it.each([
    [DELEGATION_MESSAGES.brief('/w/hestia-delegate-ab12cd34/api/.hestia/delegations/ab12cd34/brief.md'), 'brief'],
    [DELEGATION_MESSAGES.parent('delivered', 'ab12cd34', '/w/hestia/.hestia/delegations/ab12cd34/report.md'), 'parent'],
    [DELEGATION_MESSAGES.parent('accepted', 'ab12cd34', '/w/x/report.md'), 'parent'],
    [DELEGATION_MESSAGES.parent('review', 'ab12cd34', '/w/x/report.md'), 'parent'],
    [DELEGATION_MESSAGES.feedback('ab12cd34', 2, '/w/hestia-delegate-ab12cd34/.hestia/delegations/ab12cd34/feedback-2.md'), 'feedback'],
    // From a second backend, whose command has its own name.
    [DELEGATION_MESSAGES.feedback('ab12cd34', 2, '/w/x/feedback-2.md', 'hestia-dev'), 'feedback'],
  ])('recognizes %s', (text, kind) => {
    expect(delegationMessageKind(text)).toBe(kind);
    // Rewrapped by the CLI.
    expect(delegationMessageKind(text.replace(/，/g, '，\n  '))).toBe(kind);
  });

  it('recognizes a parent message whose head was cut off', () => {
    const text = DELEGATION_MESSAGES.parent('blocked', 'ab12cd34', '/w/x/report.md');
    expect(delegationMessageKind(text.slice(20))).toBe('parent');
  });

  it('recognizes feedback whose head was cut off', () => {
    const text = DELEGATION_MESSAGES.feedback('ab12cd34', 3, '/w/x/feedback-3.md');
    expect(delegationMessageKind(text.slice(30))).toBe('feedback');
    expect(delegationMessageKind(DELEGATION_MESSAGES.feedback('ab12cd34', 3, '/w/x/feedback-3.md', 'hestia-dev').slice(30))).toBe('feedback');
  });

  it.each(['', '請讀 README.md，然後開始。', '[Hestia] hi', HANDOFF_MESSAGES.briefAsk('/w/.hestia/handoffs/x.md')])('leaves %j alone', (text) => {
    expect(delegationMessageKind(text)).toBeNull();
  });

  it('is not taken for a handoff message', () => {
    expect(handoffMessageKind(DELEGATION_MESSAGES.parent('delivered', 'ab12cd34', '/w/r.md'))).toBeNull();
    expect(handoffMessageKind(DELEGATION_MESSAGES.brief('/w/.hestia/delegations/ab12cd34/brief.md'))).toBeNull();
    expect(handoffMessageKind(DELEGATION_MESSAGES.feedback('ab12cd34', 2, '/w/f.md'))).toBeNull();
  });
});
