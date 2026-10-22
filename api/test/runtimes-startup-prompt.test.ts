import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readAgyStartupPrompt } from '../src/runtimes/agy.js';
import { readClaudeStartupPrompt } from '../src/runtimes/claude-code.js';
import { readCodexStartupPrompt } from '../src/runtimes/codex-cli.js';
import { answerTrustMenu, readTrustMenu, type TrustMenuSpec } from '../src/runtimes/startup-prompt-menu.js';
import type { StartupPromptReading } from '../src/runtimes/types.js';

// ---------- every capture through its runtime's reader ----------

const CAPTURES = path.join(import.meta.dirname, 'fixtures', 'startup-prompts');
const READERS: Record<string, (pane: string) => StartupPromptReading | null> = {
  claude: readClaudeStartupPrompt,
  codex: readCodexStartupPrompt,
  agy: readAgyStartupPrompt,
};
const captures = readdirSync(CAPTURES).filter((name) => name.endsWith('.txt')).map((name) => {
  const [runtime, expected] = name.split('.') as [string, string];
  return { name, runtime, expected, pane: readFileSync(path.join(CAPTURES, name), 'utf8') };
});

describe('start-up prompt captures (test/fixtures/startup-prompts)', () => {
  it('has captures for every runtime, all named <runtime>.<expected>.<label>.txt', () => {
    expect(new Set(captures.map((capture) => capture.runtime))).toEqual(new Set(Object.keys(READERS)));
    for (const { name, expected } of captures) expect(['trust', 'decline', 'unknown', 'none'], name).toContain(expected);
  });

  it.each(captures)('$name', ({ runtime, expected, pane }) => {
    const reading = READERS[runtime]!(pane);
    if (expected === 'none') expect(reading).toBeNull();
    else expect(reading).toMatchObject({ kind: 'workspace_trust', selected: expected === 'unknown' ? null : expected });
    // No other runtime's reader takes it for its own prompt.
    for (const [other, read] of Object.entries(READERS)) if (other !== runtime) expect(read(pane), other).toBeNull();
  });
});

// ---------- the shared menu rules, once ----------

const spec: TrustMenuSpec = {
  question: /Trust here\?/,
  trust: ['Yes', 'Yes, proceed'],
  decline: ['No'],
  cursor: ['❯', '>'],
  hints: /enter to confirm/i,
};
const menu = (selected: 'trust' | 'decline' | null, order: 'trust-first' | 'decline-first' = 'trust-first') => {
  const yes = `${selected === 'trust' ? '❯ ' : '  '}1. Yes`;
  const no = `${selected === 'decline' ? '❯ ' : '  '}2. No`;
  return ['  Trust here? It can run code.', '', ...(order === 'trust-first' ? [yes, no] : [no, yes]), '', '  Enter to confirm', ''].join('\n');
};

describe('readTrustMenu', () => {
  it('reads the option under the cursor and the options in screen order', () => {
    expect(readTrustMenu(menu('trust'), spec)).toEqual({ kind: 'workspace_trust', selected: 'trust', options: ['trust', 'decline'] });
    expect(readTrustMenu(menu('decline', 'decline-first'), spec)).toEqual({ kind: 'workspace_trust', selected: 'decline', options: ['decline', 'trust'] });
  });

  it('reports an unreadable cursor rather than guessing', () => {
    expect(readTrustMenu(menu(null), spec)).toMatchObject({ selected: null });
  });

  it('reads only the live prompt, not one an earlier launch left above it', () => {
    expect(readTrustMenu(`${menu('decline')}\n$ \n${menu('trust')}`, spec)).toMatchObject({ selected: 'trust' });
  });

  it('is gone once anything but key hints or a right-aligned status bar follows it', () => {
    const statusBar = `${' '.repeat(60)}mode · model`;
    expect(readTrustMenu(`${menu('trust')}\n${statusBar}\n`, spec)).toMatchObject({ selected: 'trust' });
    expect(readTrustMenu(`${menu('trust')}\n> \n──────\n${statusBar}`, spec)).toBeNull();
    expect(readTrustMenu(`${menu('decline')}\ndev@host:/work$ `, spec)).toBeNull();
  });

  it('needs the question and both answers', () => {
    expect(readTrustMenu('❯ 1. Yes\n  2. No\n', spec)).toBeNull();
    expect(readTrustMenu('it asked: Trust here?\n❯ No\n', spec)).toBeNull();
    expect(readTrustMenu('> Trust here? is what it asked', spec)).toBeNull();
  });
});

describe('answerTrustMenu', () => {
  // A menu that moves its cursor like the real one: `wraps` or stops at the ends.
  function terminal(start: 'trust' | 'decline', opts: { order?: 'trust-first' | 'decline-first'; wraps?: boolean; frozen?: boolean } = {}) {
    const order = opts.order === 'decline-first' ? ['decline', 'trust'] as const : ['trust', 'decline'] as const;
    let at = order.indexOf(start);
    const keys: string[] = [];
    return {
      keys,
      term: {
        capture: vi.fn(async () => menu(order[at]!, opts.order)),
        sendKey: vi.fn(async (key: 'Up' | 'Down' | 'Enter') => {
          keys.push(key);
          if (opts.frozen || key === 'Enter') return;
          const next = at + (key === 'Down' ? 1 : -1);
          at = opts.wraps ? (next + order.length) % order.length : Math.min(Math.max(next, 0), order.length - 1);
        }),
        sleep: async () => undefined,
      },
    };
  }
  const read = (pane: string) => readTrustMenu(pane, spec);

  it('confirms at once when the wanted option is already selected', async () => {
    const { term, keys } = terminal('trust');
    expect(await answerTrustMenu(term, read, 'trust')).toBe('answered');
    expect(keys).toEqual(['Enter']);
  });

  it('moves toward the wanted option, so a menu that does not wrap is answered either way', async () => {
    for (const [start, choice, order, key] of [
      ['trust', 'decline', 'trust-first', 'Down'],
      ['decline', 'trust', 'trust-first', 'Up'],
      ['decline', 'trust', 'decline-first', 'Down'],
      ['trust', 'decline', 'decline-first', 'Up'],
    ] as const) {
      const { term, keys } = terminal(start, { order, wraps: false });
      expect(await answerTrustMenu(term, read, choice)).toBe('answered');
      expect(keys).toEqual([key, 'Enter']);
    }
  });

  it('never presses Enter when the selection cannot be confirmed', async () => {
    const frozen = terminal('trust', { frozen: true });
    expect(await answerTrustMenu(frozen.term, read, 'decline')).toBe('unsure');
    expect(frozen.keys).not.toContain('Enter');

    const unreadable = { capture: async () => menu(null), sendKey: vi.fn(async () => undefined) };
    expect(await answerTrustMenu(unreadable, read, 'trust')).toBe('unsure');
    expect(unreadable.sendKey).not.toHaveBeenCalled();
  });

  it('reports a prompt that is not on screen without sending anything', async () => {
    const gone = { capture: async () => '> \n? for shortcuts', sendKey: vi.fn(async () => undefined) };
    expect(await answerTrustMenu(gone, read, 'trust')).toBe('not_shown');
    expect(gone.sendKey).not.toHaveBeenCalled();
  });
});
