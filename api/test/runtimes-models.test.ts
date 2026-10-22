import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../src/contract/models.js';
import { agyModels, parseAgyModels } from '../src/runtimes/agy-models.js';
import { claudeModels, readClaudeModelDialog } from '../src/runtimes/claude-models.js';
import { codexModels, mapCodexModels, readCodexMenu } from '../src/runtimes/codex-models.js';
import type { ModelTerminal } from '../src/runtimes/types.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'model-switch');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

// A pane that answers keys the way a script says: `onInput` gets each
// submitted line / typed text / key and returns the next screen (or
// undefined to leave it).
function scriptedTerminal(first: string, onInput: (input: string, screen: string) => string | undefined) {
  let screen = first;
  const inputs: string[] = [];
  const react = (input: string) => {
    inputs.push(input);
    screen = onInput(input, screen) ?? screen;
  };
  const terminal: ModelTerminal = {
    capture: async () => screen,
    submit: async (text) => react(`submit:${text}`),
    type: async (text) => react(`type:${text}`),
    sendKey: async (key) => react(`key:${key}`),
    sleep: async () => {},
  };
  return { terminal, inputs };
}

const IDLE_CODEX = '› Ask Codex to do anything\n  ? for shortcuts\n';
const codexOption = (id: string, label: string, efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']): ModelOption => (
  { id, label, efforts, defaultEffort: efforts[0] ?? null, isDefault: false }
);

describe('readCodexMenu (Codex 0.157.1 captures)', () => {
  it('reads the model menu without its (default)/(current) marks', () => {
    const menu = readCodexMenu(fixture('codex.model-menu.0.157.1.txt'));
    expect(menu?.kind).toBe('model');
    expect(menu?.options.map((option) => `${option.number}:${option.label}`)).toEqual([
      '1:GPT-6-Astra', '2:GPT-6-Sol', '3:GPT-6-Luna', '4:GPT-5.6-Sol', '5:GPT-5.6-Terra', '6:GPT-5.6-Luna', '7:GPT-5.5',
    ]);
  });

  it('reads effort menus, titled with the model', () => {
    const five = readCodexMenu(fixture('codex.effort-menu.0.157.1.txt'));
    expect(five).toMatchObject({ kind: 'effort', title: 'GPT-6-Astra' });
    expect(five?.options.map((option) => option.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'More reasoning…']);
    const four = readCodexMenu(fixture('codex.effort-menu-4-levels.0.157.1.txt'));
    expect(four).toMatchObject({ kind: 'effort', title: 'GPT-5.5' });
    expect(four?.options.map((option) => `${option.number}:${option.label}`)).toEqual(['1:Low', '2:Medium', '3:High', '4:Extra high']);
  });

  it('reads the advanced reasoning menu', () => {
    const menu = readCodexMenu(fixture('codex.advanced-menu.0.157.1.txt'));
    expect(menu).toMatchObject({ kind: 'advanced', options: [{ number: 1, label: 'Max' }, { number: 2, label: 'Ultra' }] });
  });

  it('sees no menu once it closed', () => {
    expect(readCodexMenu(fixture('codex.changed.0.157.1.txt'))).toBeNull();
    // A closed menu still in scrollback, the input box drawn below it.
    expect(readCodexMenu(`${fixture('codex.model-menu.0.157.1.txt')}\n› Ask Codex to do anything\n`)).toBeNull();
  });
});

describe('model lists', () => {
  it('maps model/list, leaving hidden models out', () => {
    expect(mapCodexModels({
      data: [
        { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
        { id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true, supportedReasoningEfforts: [] },
      ],
      nextCursor: null,
    })).toEqual([{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low', 'medium'], defaultEffort: 'low', isDefault: true }]);
  });

  it('parses `agy models` (Agy 1.2.12 output)', () => {
    expect(parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n')).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', efforts: [], defaultEffort: null, isDefault: false },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', efforts: [], defaultEffort: null, isDefault: false },
    ]);
  });
});

describe('switching by name (Claude Code, Agy)', () => {
  const claudeIdle = '❯ \n';
  const sonnet: ModelOption = { id: 'sonnet', label: 'Sonnet', efforts: [], defaultEffort: null, isDefault: false };

  it('Claude: confirmed by "Set model to"', async () => {
    const { terminal, inputs } = scriptedTerminal(claudeIdle, () => '❯ /model sonnet\n  ⎿  Set model to Sonnet 5 and saved as your default for new sessions\n❯ \n');
    expect(await claudeModels.switchModel(terminal, sonnet, null)).toEqual({ status: 'switched', label: 'Sonnet 5', effort: null });
    expect(inputs).toEqual(['submit:/model sonnet']);
  });

  it('Claude: an earlier answer still on screen is not this one', async () => {
    const earlier = fixture('claude.answers.2.1.283.txt');
    const { terminal } = scriptedTerminal(earlier, () => undefined);
    expect((await claudeModels.switchModel(terminal, sonnet, null)).status).toBe('unsure');
  });

  it('Claude: a model the account lacks is refused', async () => {
    const { terminal } = scriptedTerminal(claudeIdle, () => "❯ /model fable\n  ⎿  Model 'fable' not found\n❯ \n");
    expect((await claudeModels.switchModel(terminal, { ...sonnet, id: 'fable' }, null)).status).toBe('rejected');
  });

  it('Claude: reads the confirmation it asks for a paid model (2.1.283 capture)', () => {
    expect(readClaudeModelDialog(fixture('claude.confirm-dialog.2.1.283.txt'))).toBe(
      'Switch to Fable 5.1? Fable 5.1 runs on usage credits — you have $0.57 in credits. Usage credits are turned off. Re-enable to use Fable 5.1.',
    );
    expect(readClaudeModelDialog(fixture('claude.answers.2.1.283.txt'))).toBeNull();
  });

  it('Claude: cancels such a confirmation with Esc and reports it', async () => {
    const dialog = fixture('claude.confirm-dialog.2.1.283.txt');
    // The same pane before /model fable was typed: its earlier answers stay.
    const idle = `${dialog.slice(0, dialog.lastIndexOf('❯ /model fable'))}❯ \n`;
    const { terminal, inputs } = scriptedTerminal(idle, (input) => input === 'key:Escape'
      ? '❯ /model fable\n  ⎿  Kept model as Sonnet 5\n❯ \n'
      : dialog);
    const result = await claudeModels.switchModel(terminal, { ...sonnet, id: 'fable' }, null);
    expect(result.status).toBe('rejected');
    expect(result).toMatchObject({ message: expect.stringContaining('Switch to Fable 5.1?') });
    expect(inputs).toEqual(['submit:/model fable', 'key:Escape']);
  });

  it('Agy: confirmed by "Model set to", refused by "Invalid model"', async () => {
    const option: ModelOption = { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)', efforts: [], defaultEffort: null, isDefault: false };
    const ok = scriptedTerminal('>\n', () => '> /model\n  ⎿  Model set to Gemini 3.7 Flash (Low)\n>\n');
    expect(await agyModels.switchModel(ok.terminal, option, null)).toEqual({ status: 'switched', label: 'Gemini 3.7 Flash (Low)', effort: null });
    expect(ok.inputs).toEqual(['submit:/model gemini-3.7-flash-low']);
    const bad = scriptedTerminal('>\n', () => '> /model\n  ⎿  Invalid model "x" (available: a, b)\n>\n');
    expect((await agyModels.switchModel(bad.terminal, option, null)).status).toBe('rejected');
  });
});

describe('switching through Codex menus', () => {
  // Codex 0.157.1 as captured: /model opens the model menu, a digit opens
  // that model's effort menu, a digit there switches.
  function codexPane(finalLine = (model: string, effort: string) => `• Model changed to ${model} ${effort}`) {
    const models = fixture('codex.model-menu.0.157.1.txt');
    const efforts = (label: string) => fixture('codex.effort-menu.0.157.1.txt').replace('GPT-6-Astra', label);
    const ids: Record<string, string> = { 1: 'gpt-6-astra', 2: 'gpt-6-sol', 3: 'gpt-6-luna' };
    const labels: Record<string, string> = { 1: 'GPT-6-Astra', 2: 'GPT-6-Sol', 3: 'GPT-6-Luna' };
    const levels: Record<string, string> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'xhigh' };
    let picked = '';
    return scriptedTerminal(IDLE_CODEX, (input, screen) => {
      if (input === 'submit:/model') return models;
      if (input === 'key:Escape') return IDLE_CODEX;
      const digit = input.replace('type:', '');
      const menu = readCodexMenu(screen);
      if (menu?.kind === 'model') { picked = digit; return efforts(labels[digit]!); }
      if (menu?.kind === 'effort' && digit === '5') return fixture('codex.advanced-menu.0.157.1.txt');
      if (menu?.kind === 'effort') return `${IDLE_CODEX}${finalLine(ids[picked]!, levels[digit]!)}\n`;
      if (menu?.kind === 'advanced') return `${IDLE_CODEX}${finalLine(ids[picked]!, digit === '1' ? 'max' : 'ultra')}\n`;
      return undefined;
    });
  }

  it('picks the model and effort by the numbers on screen', async () => {
    const { terminal, inputs } = codexPane();
    expect(await codexModels.switchModel(terminal, codexOption('gpt-6-sol', 'GPT-6-Sol'), 'high'))
      .toEqual({ status: 'switched', label: 'GPT-6-Sol', effort: 'high' });
    expect(inputs).toEqual(['submit:/model', 'type:2', 'type:3']);
  });

  it('goes through "More reasoning…" for max and ultra', async () => {
    const { terminal, inputs } = codexPane();
    expect(await codexModels.switchModel(terminal, codexOption('gpt-6-astra', 'GPT-6-Astra'), 'ultra'))
      .toEqual({ status: 'switched', label: 'GPT-6-Astra', effort: 'ultra' });
    expect(inputs).toEqual(['submit:/model', 'type:1', 'type:5', 'type:2']);
  });

  it('backs out when the model is not on the menu', async () => {
    const { terminal, inputs } = codexPane();
    expect((await codexModels.switchModel(terminal, codexOption('gpt-7', 'GPT-7'), 'low')).status).toBe('rejected');
    expect(inputs).toEqual(['submit:/model', 'key:Escape']);
  });

  it('is unsure when Codex reports a different model', async () => {
    const { terminal } = codexPane(() => '• Model changed to gpt-6-luna medium');
    expect((await codexModels.switchModel(terminal, codexOption('gpt-6-sol', 'GPT-6-Sol'), 'high')).status).toBe('unsure');
  });

  it('is unsure, and presses nothing more, when no menu opens', async () => {
    const { terminal, inputs } = scriptedTerminal(IDLE_CODEX, () => undefined);
    expect((await codexModels.switchModel(terminal, codexOption('gpt-6-sol', 'GPT-6-Sol'), 'high')).status).toBe('unsure');
    expect(inputs).toEqual(['submit:/model']);
  });
});
