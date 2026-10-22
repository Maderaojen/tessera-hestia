import type { ModelOption } from '../contract/models.js';
import { awaitNewAnswer, sleepFor } from './model-switch.js';
import type { ModelSupport } from './types.js';
import { t } from '../i18n/index.js';

/**
 * Claude Code has no command or API listing the models an account may use:
 * its /model menu is built into each CLI version. What it documents instead
 * is a set of aliases that always name the latest model of a family, so
 * these are offered; one the account can't use is refused when switching.
 */
// A function: the default's label is worded in the asking app's language.
export const CLAUDE_MODEL_OPTIONS = (): ModelOption[] => [
  { id: 'default', label: t('model.option.claudeDefault'), efforts: [], defaultEffort: null, isDefault: true },
  { id: 'fable', label: 'Fable', efforts: [], defaultEffort: null, isDefault: false },
  { id: 'opus', label: 'Opus', efforts: [], defaultEffort: null, isDefault: false },
  { id: 'sonnet', label: 'Sonnet', efforts: [], defaultEffort: null, isDefault: false },
  { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, isDefault: false },
];

// Claude Code 2.1.283 answers `/model <name>` (verified in an isolated tmux,
// 2026-09-27) under the command, with "⎿  Set model to Sonnet 5 and saved
// as your default for new sessions", or "⎿  Model 'x' not found". A model
// that costs extra asks first instead, e.g. Fable on a Pro account without
// usage credits: "Switch to Fable 5.1?" over "❯ No, keep my current model"
// / "Set up usage credits on claude.ai" and "Enter to confirm · Esc to
// cancel"; Esc answers "⎿  Kept model as …". Captures:
// test/fixtures/model-switch/claude.*.
const SET = /Set model to (.+?)(?: and saved\b|$)/m;
const NOT_FOUND = /Model '([^'\n]*)' not found/;
const OTHER_ANSWER = /⎿\s+(\S.*)$/m;
const ANSWER_TIMEOUT_MS = 5_000;
const DIALOG_SETTLE_MS = 1_500;
const DIALOG_HINTS = /Enter to confirm · Esc to cancel/;
const RULE = /^\s*─{10,}\s*$/;

/**
 * A confirmation Claude Code shows in place of an answer, when the screen
 * ends with one: its question and explanation (the lines above its
 * options), else null.
 */
export function readClaudeModelDialog(pane: string): string | null {
  const lines = pane.replace(/\s+$/, '').split('\n');
  const hints = lines.length - 1;
  if (hints < 0 || !DIALOG_HINTS.test(lines[hints]!)) return null;
  let top = hints;
  while (top > 0 && !RULE.test(lines[top - 1]!)) top -= 1;
  const body = lines.slice(top, hints).map((line) => line.trim()).filter(Boolean);
  const firstOption = body.findIndex((line) => line.startsWith('❯'));
  const text = (firstOption === -1 ? body : body.slice(0, firstOption)).join(' ');
  return text || null;
}

export const claudeModels: ModelSupport = {
  source: 'builtin',
  list: async () => CLAUDE_MODEL_OPTIONS(),
  async switchModel(terminal, option) {
    const sleep = sleepFor(terminal);
    const before = await terminal.capture();
    await terminal.submit(`/model ${option.id}`);
    const answer = await awaitNewAnswer(terminal, before, [SET, NOT_FOUND, OTHER_ANSWER], ANSWER_TIMEOUT_MS, readClaudeModelDialog);
    if (!answer) return { status: 'unsure', message: t('model.switch.noAnswer', { cli: 'Claude Code' }) };
    if (answer.kind === 'screen') {
      // Its explanation loads in after it opens ("Checking usage credits…").
      await sleep(DIALOG_SETTLE_MS);
      const question = readClaudeModelDialog(await terminal.capture()) ?? answer.screen;
      // Anything it asks (so far: about paying for a model) is the user's
      // to decide, in the terminal; Esc keeps the current model.
      await terminal.sendKey('Escape');
      await sleep(500);
      if (readClaudeModelDialog(await terminal.capture())) {
        return { status: 'unsure', message: t('model.switch.claudeConfirmStuck', { question }) };
      }
      return { status: 'rejected', message: t('model.switch.claudeConfirmCancelled', { question }) };
    }
    if (answer.index === 0) return { status: 'switched', label: answer.match[1]!.trim(), effort: null };
    if (answer.index === 1) return { status: 'rejected', message: t('model.switch.claudeNotFound', { model: option.id }) };
    return { status: 'unsure', message: t('model.switch.answered', { cli: 'Claude Code', answer: answer.match[1]!.trim() }) };
  },
};
