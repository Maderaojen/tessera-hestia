import { afterEach, describe, expect, it } from 'vitest';
import { activeDelegationOf } from '../src/delegation/policy.js';
import { registerTmuxEnv, tmuxEnvFor } from '../src/services/tmux-env.js';

// A tmux made again for a session the app already has carries what the
// first one did (ADR 0015: a delegate's HESTIA_DELEGATION_ID).

const unregister: (() => void)[] = [];
afterEach(() => {
  while (unregister.length) unregister.pop()!();
});

describe('tmuxEnvFor', () => {
  it('merges what every source gives, skipping one that fails', async () => {
    unregister.push(registerTmuxEnv(async (id): Promise<Record<string, string>> => (id === 's1' ? { HESTIA_DELEGATION_ID: 'ab12cd34' } : {})));
    unregister.push(registerTmuxEnv(async () => { throw new Error('boom'); }));
    unregister.push(registerTmuxEnv(async () => ({ OTHER: 'x' })));
    expect(await tmuxEnvFor('s1')).toEqual({ HESTIA_DELEGATION_ID: 'ab12cd34', OTHER: 'x' });
    expect(await tmuxEnvFor('s2')).toEqual({ OTHER: 'x' });
  });

  it('is empty with no source', async () => {
    expect(await tmuxEnvFor('s1')).toEqual({});
  });
});

describe('activeDelegationOf', () => {
  const d = (id: string, childSessionId: string | null, state: 'working' | 'accepted' | 'needs_attention', createdAt: string) => ({ id, childSessionId, state, createdAt });
  it('is the newest delegation the session is the delegate of, not one that is over', () => {
    const list = [
      d('old', 's1', 'accepted', '2026-10-06T08:00:00Z'),
      d('now', 's1', 'needs_attention', '2026-10-06T09:00:00Z'),
      d('theirs', 's2', 'working', '2026-10-06T10:00:00Z'),
    ];
    expect(activeDelegationOf(list, 's1')?.id).toBe('now');
    expect(activeDelegationOf(list, 's3')).toBeNull();
    expect(activeDelegationOf([list[0]!], 's1')).toBeNull();
  });
});
