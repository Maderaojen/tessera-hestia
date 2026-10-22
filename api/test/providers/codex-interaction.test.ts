import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCodexInteraction } from '../../src/providers/codex-interaction.js';
import { answerInteraction, interactionId } from '../../src/sync/interaction.js';

const capture = (screen: string) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'interaction-prompts', `codex.${screen}.0.161.0.txt`), 'utf8');

describe('readCodexInteraction (Codex CLI 0.161.0 captures)', () => {
  it('reads a command approval: the command, why, and its three rows', () => {
    const read = readCodexInteraction(capture('perm-exec'))!;
    expect(read).toMatchObject({ toolName: 'exec_command', cursor: 0 });
    expect(read.screen).toMatchObject({
      kind: 'permission',
      title: 'Would you like to run the following command?',
      detail: 'Environment: local\nReason: May I run touch probe.txt to create the empty file in this folder?\n$ touch probe.txt',
      multiSelect: false,
      steps: null,
    });
    expect(read.screen.options.map((option) => [option.number, option.label, option.amendable, option.freeText])).toEqual([
      [1, 'Yes, proceed', false, false],
      [2, 'Yes, and don\'t ask again for commands that start with `touch probe.txt`', false, false],
      [3, 'No, and tell Codex what to do differently', false, false],
    ]);
  });

  it('follows the cursor, and finds nothing once it was answered', () => {
    expect(readCodexInteraction(capture('perm-exec-cursor-no'))?.cursor).toBe(2);
    expect(readCodexInteraction(capture('idle-after'))).toBeNull();
  });

  it('rejoins a row a narrow pane wrapped', () => {
    const narrow = capture('perm-exec').replace(
      "  2. Yes, and don't ask again for commands that start with `touch probe.txt` (p)",
      "  2. Yes, and don't ask again for commands that start with\n     `touch probe.txt` (p)",
    );
    expect(readCodexInteraction(narrow)!.screen.options[1]!.label).toBe("Yes, and don't ask again for commands that start with `touch probe.txt`");
  });

  it('is answered by moving the cursor and pressing Enter, as Codex takes it', async () => {
    // A terminal where Up/Down move the marker, as Codex 0.161.0 does.
    let screen = capture('perm-exec-cursor-no');
    const keys: string[] = [];
    const move = (step: number) => {
      const rows = screen.split('\n');
      const options = rows.map((row, at) => (/^(›| ) ?\d\. /.test(row) ? at : -1)).filter((at) => at >= 0);
      const current = options.findIndex((at) => rows[at]!.startsWith('›'));
      const next = (current + step + options.length) % options.length;
      rows[options[current]!] = `  ${rows[options[current]!]!.slice(2)}`;
      rows[options[next]!] = `› ${rows[options[next]!]!.slice(2)}`;
      screen = rows.join('\n');
    };
    const terminal = {
      capture: async () => screen,
      sendKey: async (key: string) => { keys.push(key); if (key === 'Up') move(-1); if (key === 'Down') move(1); },
      type: async () => { throw new Error('nothing is typed into an approval'); },
      sleep: async () => {},
    };
    const promptId = interactionId(readCodexInteraction(screen)!.screen);
    expect(await answerInteraction(terminal, readCodexInteraction, { promptId, option: 1 })).toBe('answered');
    expect(keys).toEqual(['Up', 'Up', 'Enter']);
  });
});
