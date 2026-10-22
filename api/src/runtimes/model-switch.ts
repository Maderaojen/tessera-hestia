import { probePath } from '../probe-path.js';
import type { LaunchProfileSnapshot } from '../types.js';
import type { ModelTerminal } from './types.js';

/**
 * How to run one of a CLI's own subcommands (e.g. `agy models`) as the
 * account a conversation was launched with: through Janus for a Janus
 * profile, else the profile's executable with the runtime's native
 * environment, and `runtimeEnv` either way (e.g. what turns off the CLI's
 * own update check, ADR 0030). The profile's own launch args are left out;
 * they belong to the interactive CLI. PATH gets what a systemd service lacks (see probePath).
 */
export function profileCommand(
  profile: LaunchProfileSnapshot,
  args: string[],
  nativeEnv: Record<string, string> = {},
  runtimeEnv: Readonly<Record<string, string>> = {},
): { argv: string[]; env: Record<string, string> } | null {
  const PATH = probePath();
  if (profile.source === 'janus' && profile.delegate.kind === 'janus' && profile.profileName) {
    return { argv: [profile.delegate.executable, 'run', profile.profileName, ...args], env: { PATH, ...runtimeEnv } };
  }
  if (profile.source === 'native' && profile.delegate.kind === 'native') {
    return { argv: [profile.delegate.executable, ...args], env: { PATH, ...runtimeEnv, ...nativeEnv } };
  }
  return null;
}

const POLL_MS = 250;

export function sleepFor(terminal: ModelTerminal): (ms: number) => Promise<void> {
  return terminal.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

function allMatches(text: string, pattern: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
}

/**
 * Waits for one more line matching any of `patterns` than `before` (the
 * pane as it was before the command was typed) had, so an answer to an
 * earlier command still on screen is never mistaken for this one's. The
 * terminal's capture must include scrollback (see routes/models.ts), or an
 * old answer scrolling off would cancel out the new one.
 * Resolves with the index of the pattern and its newest match, or null.
 * `screen`, when given, is checked on every capture too: a screen it
 * recognizes (e.g. a dialog asked instead of answering) ends the wait with
 * what it read.
 */
export async function awaitNewAnswer(
  terminal: ModelTerminal,
  before: string,
  patterns: RegExp[],
  timeoutMs: number,
  screen?: (pane: string) => string | null,
): Promise<{ kind: 'answer'; index: number; match: RegExpMatchArray } | { kind: 'screen'; screen: string } | null> {
  const sleep = sleepFor(terminal);
  const counts = patterns.map((pattern) => allMatches(before, pattern).length);
  for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
    await sleep(POLL_MS);
    const pane = await terminal.capture();
    for (const [index, pattern] of patterns.entries()) {
      const matches = allMatches(pane, pattern);
      if (matches.length > counts[index]!) return { kind: 'answer', index, match: matches.at(-1)! };
    }
    const reading = screen?.(pane) ?? null;
    if (reading !== null) return { kind: 'screen', screen: reading };
  }
  return null;
}

/** Polls the pane until `read` recognizes it, or gives up with null. */
export async function awaitScreen<T>(
  terminal: ModelTerminal,
  read: (pane: string) => T | null,
  timeoutMs: number,
): Promise<T | null> {
  const sleep = sleepFor(terminal);
  for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
    await sleep(POLL_MS);
    const reading = read(await terminal.capture());
    if (reading !== null) return reading;
  }
  return null;
}
