import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeInteraction } from '../../src/providers/claude-interaction.js';

const capture = (screen: string) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'interaction-prompts', `claude.${screen}.2.1.284.txt`), 'utf8');
const read = (screen: string) => readClaudeInteraction(capture(screen));
const labels = (screen: string) => read(screen)!.screen.options.map((option) => option.label);

describe('readClaudeInteraction (Claude Code 2.1.284 captures)', () => {
  it('finds no prompt once it was answered', () => {
    expect(read('idle-after')).toBeNull();
    expect(read('idle-after-question')).toBeNull();
  });

  it('reads a permission: its tool, what it is about, and which rows take a note', () => {
    const write = read('perm-write')!;
    expect(write).toMatchObject({ toolName: 'Write', cursor: 0 });
    expect(write.screen).toMatchObject({ kind: 'permission', title: 'Do you want to create a.txt?', detail: 'Create file\na.txt\n1 hi', steps: null });
    expect(write.screen.options.map((option) => [option.number, option.amendable])).toEqual([[1, true], [2, false], [3, true]]);

    const bash = read('perm-bash')!;
    expect(bash.toolName).toBe('Bash');
    // The tip over the prompt is left out; the command and its purpose stay.
    expect(bash.screen.detail).toBe('Bash command\ntouch /tmp/aqt/b.txt && mv /tmp/aqt/b.txt /tmp/aqt/c.txt\nCreate b.txt and rename it to c.txt');
    expect(bash.screen.options.map((option) => option.amendable)).toEqual([true, false, false, true]);
  });

  it('rejoins permission rows a narrow pane wrapped', () => {
    expect(labels('perm-bash-narrow')).toEqual(labels('perm-bash').map((label) => label.replaceAll('b.txt', 'd.txt').replaceAll('c.txt', 'e.txt')));
  });

  it('follows the cursor, and offers no note once a row is already open for one', () => {
    expect(read('perm-bash-cursor-no')!.cursor).toBe(3);
    expect(read('perm-write-tab')!.screen.options.some((option) => option.amendable)).toBe(false);
    expect(labels('perm-write-amend')[0]).toBe('Yes, 好');
    expect(labels('perm-bash-no-amend')[3]).toBe('No, 不要搬，停');
  });

  it('reads a question with its steps, descriptions and free-text row', () => {
    const q1 = read('q-multi-q1')!;
    expect(q1).toMatchObject({ toolName: 'AskUserQuestion', cursor: 0 });
    expect(q1.screen).toMatchObject({ kind: 'question', title: '你喜歡哪種水果？', multiSelect: false });
    expect(q1.screen.steps).toEqual([{ label: '水果', answered: false }, { label: '顏色', answered: false }, { label: '動物', answered: false }]);
    expect(q1.screen.options).toEqual([
      { number: 1, label: '蘋果', description: '清脆香甜', freeText: false, amendable: false, checked: null },
      { number: 2, label: '香蕉', description: '軟綿香甜', freeText: false, amendable: false, checked: null },
      { number: 3, label: '', description: null, freeText: true, amendable: false, checked: null },
    ]);
    // "Chat about this", under the options' rule, is not offered.
    expect(read('q-multi-q1-typed')!).toMatchObject({ cursor: 2 });
    expect(labels('q-multi-q1-typed')).toEqual(['蘋果', '香蕉', '芭樂']);
    expect(read('q-multi-q3')!.screen.steps!.map((step) => step.answered)).toEqual([true, true, false]);
  });

  it('reads a single question, rejoining wrapped CJK descriptions without spaces', () => {
    expect(read('q-single')!.screen).toMatchObject({ title: '你喜歡早上還是晚上？', steps: null });
    const narrow = read('q-single-narrow')!.screen;
    expect(narrow.options[0]!.description).toBe('喜歡沿著蜿蜒的步道慢慢往上爬，感受林間清涼的空氣與蟲鳴鳥叫，登頂後俯瞰層層疊疊的山巒與雲海，在寧靜之中享受遠離塵囂的平靜與成就感。');
  });

  it('reads a multi-select question: its boxes and its Next row', () => {
    const q2 = read('q-multi-q2')!.screen;
    expect(q2.multiSelect).toBe(true);
    expect(q2.options.map((option) => [option.number, option.label, option.checked])).toEqual([[1, '紅色', false], [2, '藍色', false], [3, '', false], [null, 'Next', null]]);
    expect(read('q-ms-toggled')!.screen.options[0]!.checked).toBe(true);
    expect(read('q-ms-typed')!.screen.options[2]).toMatchObject({ label: '紫', checked: true, freeText: true });
    expect(read('q-ms-next')!.cursor).toBe(3);
  });

  it('reads the review of the answers before they are submitted', () => {
    const review = read('q-review')!;
    expect(review.screen).toMatchObject({
      kind: 'review',
      title: 'Ready to submit your answers?',
      detail: '● 你喜歡哪種水果？\n→ 芭樂\n● 你喜歡哪些顏色？\n→ 紅色, 紫\n● 你喜歡哪種動物？\n→ 貓',
    });
    expect(labels('q-review')).toEqual(['Submit answers', 'Cancel']);
  });

  it('reads a question whose key hints wrap on a narrow pane', () => {
    // On the free-text row the hints grow ("ctrl+g to edit in Vim") and wrap.
    expect(read('q-narrow-wrapped-footer')).toMatchObject({ cursor: 2, screen: { kind: 'question', title: '晚餐吃什麼？' } });
    expect(labels('q-narrow-wrapped-typed')[2]).toBe('我想吃熱炒配白飯，再來一盤炒青菜跟一碗湯，for dinner.');
  });

  it('only takes the prompt the screen ends with', () => {
    // Anything under it means it was answered and the CLI moved on.
    expect(readClaudeInteraction(`${capture('perm-write')}\n● Done.\n`)).toBeNull();
    expect(readClaudeInteraction(`${capture('q-single')}\n❯ \n`)).toBeNull();
  });
});
