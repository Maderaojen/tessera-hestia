import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../../src/types.js';

vi.mock('../../src/registry.js', () => ({ updateSession: vi.fn(async () => undefined) }));

const registry = await import('../../src/registry.js');
const { CLI_SUGGESTION_RECHECK_MS, CLI_SUGGESTION_SAMPLE_MS, CLI_SUGGESTION_WATCH_MS } = await import('../../src/config.js');
const { __resetCliSuggestionsForTests, refreshCliSuggestion } = await import('../../src/sync/cliSuggestion.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/cli-suggestion');
const ANSI = readFileSync(path.join(FIXTURES, 'claude.suggestion.2.1.296.ansi.txt'), 'utf-8');
const SUGGESTION = 'Write sub.py with a function sub that subtracts two numbers';
// The same pane with the user's own text in the box (not dim).
const TYPED = ANSI.replace(`\x1b[2m${SUGGESTION}\x1b[0m`, 'my own draft');

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 's1', tmuxName: 'hestia-s1', status: 'ready', turnPhase: 'idle', provider: 'claude', runtimeId: 'claude-code',
    pendingInteraction: null, clearPending: null, cliSuggestion: null,
    ...overrides,
  } as unknown as ManagedSession;
}

function ports(pane: string | null, { now = 0, recent = null as string | null } = {}) {
  return { now: vi.fn(() => now), capture: vi.fn(async () => pane), recent: vi.fn(() => recent) };
}

beforeEach(() => {
  __resetCliSuggestionsForTests();
  vi.mocked(registry.updateSession).mockClear();
});

describe('refreshCliSuggestion', () => {
  it('stores the suggestion read from an attribute capture of an idle Claude pane', async () => {
    const p = ports(ANSI);
    await refreshCliSuggestion(session(), p);
    expect(p.capture).toHaveBeenCalledWith('hestia-s1');
    expect(registry.updateSession).toHaveBeenCalledWith('s1', { cliSuggestion: SUGGESTION });
  });

  it('never stores typed text as a suggestion, and clears one that was typed over', async () => {
    await refreshCliSuggestion(session(), ports(TYPED));
    expect(registry.updateSession).not.toHaveBeenCalled();
    await refreshCliSuggestion(session({ cliSuggestion: SUGGESTION }), ports(TYPED, { now: CLI_SUGGESTION_SAMPLE_MS }));
    expect(registry.updateSession).toHaveBeenCalledWith('s1', { cliSuggestion: null });
  });

  it('writes nothing when it is unchanged', async () => {
    await refreshCliSuggestion(session({ cliSuggestion: SUGGESTION }), ports(ANSI));
    expect(registry.updateSession).not.toHaveBeenCalled();
  });

  it('clears it without reading the pane once the turn is not idle, or for a CLI without suggestions', async () => {
    for (const s of [
      session({ cliSuggestion: SUGGESTION, turnPhase: 'replying' }),
      session({ cliSuggestion: SUGGESTION, status: 'dead' }),
      session({ cliSuggestion: SUGGESTION, provider: 'codex', runtimeId: 'codex-cli' }),
    ]) {
      vi.mocked(registry.updateSession).mockClear();
      const p = ports(ANSI);
      await refreshCliSuggestion(s, p);
      expect(p.capture).not.toHaveBeenCalled();
      expect(registry.updateSession).toHaveBeenCalledWith('s1', { cliSuggestion: null });
    }
  });

  it('samples every few seconds right after the turn goes idle, then stops unless one is shown', async () => {
    const p = ports(TYPED);
    const at = async (now: number, s = session()) => { p.now.mockReturnValue(now); await refreshCliSuggestion(s, p); };
    await at(0);
    await at(CLI_SUGGESTION_SAMPLE_MS - 1);
    expect(p.capture).toHaveBeenCalledTimes(1);
    await at(CLI_SUGGESTION_SAMPLE_MS);
    expect(p.capture).toHaveBeenCalledTimes(2);
    await at(CLI_SUGGESTION_WATCH_MS + 10 * CLI_SUGGESTION_RECHECK_MS);
    expect(p.capture).toHaveBeenCalledTimes(2);
    await at(CLI_SUGGESTION_WATCH_MS + 10 * CLI_SUGGESTION_RECHECK_MS, session({ cliSuggestion: SUGGESTION }));
    expect(p.capture).toHaveBeenCalledTimes(3);
  });

  it("reuses an open terminal view's fresh capture instead of capturing again", async () => {
    const history = `${'old line\n'.repeat(500)}${ANSI}`;
    const p = ports(null, { recent: history });
    await refreshCliSuggestion(session(), p);
    expect(p.capture).not.toHaveBeenCalled();
    expect(registry.updateSession).toHaveBeenCalledWith('s1', { cliSuggestion: SUGGESTION });
  });

  it('offers nothing while the pane is busy', async () => {
    const busy = ANSI.replace('auto mode on', 'auto mode on · esc to interrupt');
    await refreshCliSuggestion(session(), ports(busy));
    expect(registry.updateSession).not.toHaveBeenCalled();
  });
});
