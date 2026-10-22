import type { MenuReading, RuntimeDriver, UpdateChoice } from './types.js';

/**
 * What a just-launched CLI's screen is, from one pane capture (ADR 0030).
 * The first message after a launch is typed only into `input_ready`:
 * everything else either has its own handling (the trust prompt, the
 * update menu, a CLI that updated itself and quit) or is `unknown` and
 * left for the user. `unverified`: the runtime has no input-box reading,
 * so the screen can't be told either way.
 */
export type LaunchScreen =
  | { kind: 'input_ready' }
  | { kind: 'startup_prompt' }
  | ({ kind: 'update_prompt' } & MenuReading<UpdateChoice>)
  | { kind: 'cli_updated' }
  | { kind: 'unknown' }
  | { kind: 'unverified' };

export function readLaunchScreen(runtime: RuntimeDriver, paneText: string): LaunchScreen {
  if (!runtime.readInputReady) return { kind: 'unverified' };
  if (runtime.readStartupPrompt?.(paneText)) return { kind: 'startup_prompt' };
  const update = runtime.updatePrompt?.read(paneText);
  if (update) return { kind: 'update_prompt', ...update };
  if (runtime.updatePrompt?.updated(paneText)) return { kind: 'cli_updated' };
  if (runtime.readInputReady(paneText)) return { kind: 'input_ready' };
  return { kind: 'unknown' };
}

/** The pane's last `lines` non-empty lines, right-trimmed: what the user is shown of a screen. */
export function paneTail(paneText: string, lines = 8): string {
  return paneText.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.length > 0).slice(-lines).join('\n');
}
