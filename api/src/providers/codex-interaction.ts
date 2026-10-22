import type { InteractionOption } from '../contract/sessions.js';
import type { PaneInteraction } from './types.js';

// Verified against Codex CLI 0.161.0 by capturing real panes in an isolated
// tmux (test/fixtures/interaction-prompts/codex.*). The approval Codex asks
// for before running a command, the prompt the screen ends with:
//
//   Would you like to run the following command?
//
//   Environment: local
//
//   Reason: May I run touch probe.txt to create the empty file in this folder?
//
//   $ touch probe.txt
//
// › 1. Yes, proceed (y)
//   2. Yes, and don't ask again for commands that start with `touch probe.txt` (p)
//   3. No, and tell Codex what to do differently (esc)
//
//   Press enter to confirm or esc to cancel
//
// "›" marks the cursor; Up/Down move it (Down from the last wraps to the
// first) and Enter takes the row under it: 1 ran the command, 3 declined it
// and ended the turn. The (y)/(p)/(esc) after each row are its own keys,
// not part of what it says. Codex writes nothing to its rollout while this
// waits, so the screen is the only place it can be read from.

const TITLE = /^\s*(Would you like to .+\?)\s*$/;
const FOOTER = /^\s*Press enter to confirm or esc to cancel\s*$/;
const OPTION = /^\s*(›\s*)?(\d+)\.\s+(.*)$/;
const SHORTCUT = /\s+\((?:[a-z]|esc)\)$/;
const COMMAND = /^\s*\$\s+(.+)$/;

function trimLines(paneText: string): string[] {
  const lines = paneText.split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

/** The approval prompt the pane ends with, or null when none is on screen. */
export function readCodexInteraction(paneText: string): PaneInteraction | null {
  const lines = trimLines(paneText);
  const footer = lines.length - 1;
  if (footer < 0 || !FOOTER.test(lines[footer]!)) return null;
  let titleAt = -1;
  for (let i = footer - 1; i >= 0; i--) {
    if (TITLE.test(lines[i]!)) { titleAt = i; break; }
  }
  if (titleAt < 0) return null;

  const options: InteractionOption[] = [];
  let cursor: number | null = null;
  let firstOption = -1;
  for (let i = titleAt + 1; i < footer; i++) {
    const line = lines[i]!;
    const numbered = OPTION.exec(line);
    if (numbered) {
      if (firstOption < 0) firstOption = i;
      if (numbered[1]) cursor = options.length;
      options.push({ number: Number(numbered[2]), label: numbered[3]!.replace(SHORTCUT, '').trim(), description: null, freeText: false, amendable: false, checked: null });
    } else if (options.length && line.trim() !== '') {
      // A long row wrapped onto the next line.
      const last = options.at(-1)!;
      last.label = `${last.label} ${line.trim()}`.replace(SHORTCUT, '').trim();
    }
  }
  if (!options.length || cursor === null) return null;

  const about = lines.slice(titleAt + 1, firstOption).map((line) => line.trim()).filter((line) => line !== '');
  const command = about.map((line) => COMMAND.exec(line)?.[1]).find((found) => !!found) ?? null;
  return {
    screen: {
      kind: 'permission',
      title: TITLE.exec(lines[titleAt]!)![1]!,
      detail: about.length ? about.join('\n') : null,
      options,
      multiSelect: false,
      steps: null,
    },
    toolName: command ? 'exec_command' : 'codex',
    cursor,
  };
}
