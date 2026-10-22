import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agyRuntime } from '../src/runtimes/agy.js';
import { claudeCodeRuntime } from '../src/runtimes/claude-code.js';
import { codexCliRuntime, readCodexInputReady, readCodexUpdated, readCodexUpdatePrompt } from '../src/runtimes/codex-cli.js';
import { geminiCliRuntime } from '../src/runtimes/gemini-cli.js';
import { paneTail, readLaunchScreen, type LaunchScreen } from '../src/runtimes/launch-screen.js';
import { answerMenu } from '../src/runtimes/startup-prompt-menu.js';
import type { RuntimeDriver } from '../src/runtimes/types.js';

// What a just-launched CLI's screen is, read off a pane capture (ADR 0030):
// its input box (the only screen the first message is typed into), a
// prompt the app knows, or anything else.

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const RUNTIMES: Record<string, RuntimeDriver> = { claude: claudeCodeRuntime, codex: codexCliRuntime, agy: agyRuntime };

type Expected = 'ready' | 'startup' | 'update_update' | 'update_skip' | 'update_skip_version' | 'updated' | 'unknown';

// test/fixtures/launch-screens/<runtime>.<expected>.<label>.txt, and the
// captures other readers already keep, with what each is at launch.
const own = readdirSync(path.join(FIXTURES, 'launch-screens')).filter((name) => name.endsWith('.txt')).map((name) => {
  const [runtime, expected] = name.split('.') as [string, Expected];
  return { file: path.join('launch-screens', name), runtime, expected };
});
const shared: { file: string; runtime: string; expected: Expected }[] = [
  { file: 'startup-prompts/codex.trust.0.157.1.txt', runtime: 'codex', expected: 'startup' },
  { file: 'startup-prompts/codex.none.0.157.1-after-trust.txt', runtime: 'codex', expected: 'ready' },
  { file: 'interaction-prompts/codex.idle-after.0.161.0.txt', runtime: 'codex', expected: 'ready' },
  { file: 'interaction-prompts/codex.perm-exec.0.161.0.txt', runtime: 'codex', expected: 'unknown' },
  { file: 'resume-conflicts/codex.none.0.160.0-after-resume.txt', runtime: 'codex', expected: 'ready' },
  { file: 'resume-conflicts/codex.none.0.160.0-cwd-menu.txt', runtime: 'codex', expected: 'unknown' },
  { file: 'resume-conflicts/codex.conflict.0.160.0-second-pane.txt', runtime: 'codex', expected: 'unknown' },
  { file: 'startup-prompts/claude.decline.2.1.283.txt', runtime: 'claude', expected: 'startup' },
  { file: 'startup-prompts/claude.none.after-decline-sample.txt', runtime: 'claude', expected: 'unknown' },
  { file: 'interaction-prompts/claude.idle-after.2.1.284.txt', runtime: 'claude', expected: 'ready' },
  { file: 'interaction-prompts/claude.perm-bash.2.1.284.txt', runtime: 'claude', expected: 'unknown' },
  { file: 'interaction-prompts/claude.q-single.2.1.284.txt', runtime: 'claude', expected: 'unknown' },
  { file: 'startup-prompts/agy.trust.1.2.10.txt', runtime: 'agy', expected: 'startup' },
  { file: 'startup-prompts/agy.trust.1.2.12-status-bar.txt', runtime: 'agy', expected: 'startup' },
  { file: 'model-switch/agy.answers.1.2.12.txt', runtime: 'agy', expected: 'ready' },
];
const captures = [...own, ...shared].map((capture) => ({ ...capture, pane: readFileSync(path.join(FIXTURES, capture.file), 'utf8') }));

function kindOf(screen: LaunchScreen): Expected | string {
  if (screen.kind === 'update_prompt') return `update_${screen.selected}`;
  if (screen.kind === 'input_ready') return 'ready';
  if (screen.kind === 'startup_prompt') return 'startup';
  if (screen.kind === 'cli_updated') return 'updated';
  return screen.kind;
}

describe('launch screens (test/fixtures/launch-screens and shared captures)', () => {
  it('has its own captures named <runtime>.<expected>.<label>.txt, for every runtime', () => {
    expect(new Set(own.map((capture) => capture.runtime))).toEqual(new Set(Object.keys(RUNTIMES)));
    for (const { file, expected } of own) {
      expect(['ready', 'startup', 'update_update', 'update_skip', 'update_skip_version', 'updated', 'unknown'], file).toContain(expected);
    }
  });

  it.each(captures)('$file', ({ runtime, expected, pane }) => {
    expect(kindOf(readLaunchScreen(RUNTIMES[runtime]!, pane))).toBe(expected);
    // Only the input box a runtime knows as its own is ready for it.
    if (expected === 'ready') {
      for (const [other, driver] of Object.entries(RUNTIMES)) if (other !== runtime) expect(driver.readInputReady!(pane), other).toBe(false);
    }
  });
});

describe('Codex 0.163.0 update screens', () => {
  const read = (name: string) => readFileSync(path.join(FIXTURES, 'launch-screens', name), 'utf8');

  it('reads the update menu, its cursor and its options in screen order', () => {
    expect(readCodexUpdatePrompt(read('codex.update_update.0.163.0.txt'))).toEqual({ selected: 'update', options: ['update', 'skip', 'skip_version'] });
    expect(readCodexUpdatePrompt(read('codex.update_skip.0.163.0.txt'))?.selected).toBe('skip');
    expect(readCodexUpdatePrompt(read('codex.ready.0.163.0-update-notice.txt'))).toBeNull();
  });

  it('the screen it leaves after updating itself, and not an input box', () => {
    const pane = read('codex.updated.0.163.0-cube-handoff.txt');
    expect(readCodexUpdated(pane)).toBe(true);
    expect(readCodexInputReady(pane)).toBe(false);
    expect(readCodexUpdated(read('codex.ready.0.163.0-update-notice.txt'))).toBe(false);
  });

  it('chooses Skip only once the cursor is positively on it (one Down from Update now)', async () => {
    const screens = [read('codex.update_update.0.163.0.txt'), read('codex.update_skip.0.163.0.txt'), read('codex.ready.0.163.0-update-check-off.txt')];
    const keys: string[] = [];
    let at = 0;
    const answer = await answerMenu({
      capture: async () => screens[at]!,
      sendKey: async (key) => { keys.push(key); at += 1; },
      sleep: async () => undefined,
    }, readCodexUpdatePrompt, 'skip');
    expect(answer).toBe('answered');
    expect(keys).toEqual(['Down', 'Enter']);
  });

  it('is unsure, and presses nothing, when the cursor can\'t be read', async () => {
    const pane = read('codex.update_update.0.163.0.txt').replace('› 1. Update now', '  1. Update now');
    const keys: string[] = [];
    expect(await answerMenu({ capture: async () => pane, sendKey: async (key) => { keys.push(key); } }, readCodexUpdatePrompt, 'skip')).toBe('unsure');
    expect(keys).toEqual([]);
  });
});

describe('readLaunchScreen', () => {
  it('is unverified for a runtime with no input-box reading', () => {
    expect(readLaunchScreen(geminiCliRuntime, '> ')).toEqual({ kind: 'unverified' });
  });

  it('keeps the last few non-empty lines as the tail', () => {
    expect(paneTail('a\n\nb\nc\n  \nd\ne\n\n', 3)).toBe('c\nd\ne');
  });
});
