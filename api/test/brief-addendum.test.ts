import { afterEach, describe, expect, it } from 'vitest';
import { briefAddendumFor, registerBriefAddendum } from '../src/services/brief-addendum.js';

// What a continuity handoff brief adds for features that live elsewhere
// (ADR 0015 決策 16: a delegate's how-to-deliver).

const unregister: (() => void)[] = [];
afterEach(() => {
  while (unregister.length) unregister.pop()!();
});

describe('briefAddendumFor', () => {
  it('joins what every source gives, in order, skipping one that fails or has nothing', async () => {
    unregister.push(registerBriefAddendum(async (id) => (id === 's1' ? '## A\n' : null)));
    unregister.push(registerBriefAddendum(async () => { throw new Error('boom'); }));
    unregister.push(registerBriefAddendum(async () => '  '));
    unregister.push(registerBriefAddendum(async () => '## B'));
    expect(await briefAddendumFor('s1')).toBe('## A\n\n## B');
    expect(await briefAddendumFor('s2')).toBe('## B');
  });

  it('is null with no source, and once a source is gone', async () => {
    expect(await briefAddendumFor('s1')).toBeNull();
    const off = registerBriefAddendum(async () => '## A');
    off();
    expect(await briefAddendumFor('s1')).toBeNull();
  });
});
