import { callCodexAppServer, CODEX_APP_SERVER_ARGS } from '../account-status/codex.js';
import type { ModelOption } from '../contract/models.js';
import type { LaunchProfileSnapshot } from '../types.js';
import { awaitNewAnswer, awaitScreen, profileCommand, sleepFor } from './model-switch.js';
import type { ModelSupport, ModelSwitchResult, ModelTerminal } from './types.js';
import { t } from '../i18n/index.js';

const LIST_TIMEOUT_MS = 20_000;

type RawModel = {
  id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown; isDefault?: unknown;
  defaultReasoningEffort?: unknown; supportedReasoningEfforts?: { reasoningEffort?: unknown }[];
};

/**
 * Maps `model/list` (Codex 0.157.1 app-server, verified 2026-09-27): the
 * account's models from OpenAI's backend, in the order the TUI's /model
 * menu shows them. Hidden ones aren't on that menu, so they're left out.
 */
export function mapCodexModels(result: unknown): ModelOption[] {
  const data = (result as { data?: RawModel[] } | undefined)?.data ?? [];
  return data.flatMap((raw) => {
    const id = typeof raw.model === 'string' ? raw.model : typeof raw.id === 'string' ? raw.id : null;
    if (!id || raw.hidden === true || typeof raw.displayName !== 'string') return [];
    const efforts = (raw.supportedReasoningEfforts ?? []).flatMap((entry) => typeof entry.reasoningEffort === 'string' ? [entry.reasoningEffort] : []);
    const defaultEffort = typeof raw.defaultReasoningEffort === 'string' && efforts.includes(raw.defaultReasoningEffort) ? raw.defaultReasoningEffort : null;
    return [{ id, label: raw.displayName, efforts, defaultEffort, isDefault: raw.isDefault === true }];
  });
}

export async function listCodexModels(profile: LaunchProfileSnapshot): Promise<ModelOption[]> {
  const command = profileCommand(profile, CODEX_APP_SERVER_ARGS, profile.home ? { CODEX_HOME: profile.home } : {});
  if (!command) throw new Error('launch profile cannot run codex');
  const [reply] = await callCodexAppServer(command.argv, command.env, [{ method: 'model/list', params: { limit: 100 } }], LIST_TIMEOUT_MS);
  if (reply?.error) throw new Error(reply.error.message ?? 'model/list failed');
  const options = mapCodexModels(reply?.result);
  if (options.length === 0) throw new Error('model/list listed nothing');
  return options;
}

/**
 * Codex's /model menus (0.157.1, verified in an isolated tmux 2026-09-27;
 * captures: test/fixtures/model-switch/codex.*). Typing `/model <name>`
 * does NOT switch: Codex sends it to the model as an ordinary message. The
 * menus are:
 * - "Select Model and Effort": "N. <displayName>" plus " (default)" or
 *   " (current)", a description after two or more spaces;
 * - "Select Reasoning Level for <displayName>": Low / Medium / High /
 *   Extra high, and "More reasoning…" leading to
 * - "Advanced Reasoning": Max / Ultra.
 * The cursor is "› ", key hints ("enter select · esc back", "enter default
 * · s session · esc back") close each menu. A digit key picks that option
 * at once; on an effort menu that also switches, saved as the default
 * ("• Model changed to gpt-6-sol high"). The order follows model/list but
 * is read off the screen every time, never assumed.
 */
export type CodexMenu = { kind: 'model' | 'effort' | 'advanced'; title: string; options: { number: number; label: string }[] };

const MENU_TITLES: { kind: CodexMenu['kind']; pattern: RegExp }[] = [
  { kind: 'model', pattern: /^\s*Select Model and Effort\s*$/ },
  { kind: 'effort', pattern: /^\s*Select Reasoning Level for (.+?)\s*$/ },
  { kind: 'advanced', pattern: /^\s*Advanced Reasoning\s*$/ },
];
const OPTION = /^\s*(?:›\s*)?(\d+)\.\s+(.+?)(?:\s{2,}\S.*)?$/;
const HINTS = /enter (?:select|default)\b.*esc back/;

export function readCodexMenu(pane: string): CodexMenu | null {
  const lines = pane.replace(/\s+$/, '').split('\n');
  let start = -1;
  let kind: CodexMenu['kind'] | null = null;
  let title = '';
  lines.forEach((line, index) => {
    for (const candidate of MENU_TITLES) {
      const match = candidate.pattern.exec(line);
      if (match) { start = index; kind = candidate.kind; title = (match[1] ?? line).trim(); }
    }
  });
  if (start === -1 || !kind) return null;
  const rest = lines.slice(start + 1);
  const hints = rest.findIndex((line) => HINTS.test(line));
  // Still open: the menu's key hints close the screen.
  if (hints === -1 || rest.slice(hints + 1).some((line) => line.trim() !== '')) return null;
  const options = rest.slice(0, hints).flatMap((line) => {
    const match = OPTION.exec(line);
    return match ? [{ number: Number(match[1]), label: match[2]!.replace(/\s*\((?:default|current)\)$/, '').trim() }] : [];
  });
  return options.length > 0 ? { kind, title, options } : null;
}

const EFFORT_LABELS: Record<string, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
};
const MORE_REASONING = 'More reasoning…';
const MENU_TIMEOUT_MS = 4_000;
const CHANGED = /Model changed to (\S+)(?: (\S+))?/;
const ANSWER_TIMEOUT_MS = 4_000;

// Backs out of whatever /model menu is still open, so a failed switch
// never leaves one eating the next message.
async function closeMenus(terminal: ModelTerminal): Promise<void> {
  const sleep = sleepFor(terminal);
  for (let presses = 0; presses < 3; presses += 1) {
    if (!readCodexMenu(await terminal.capture())) return;
    await terminal.sendKey('Escape');
    await sleep(300);
  }
}

async function pick(terminal: ModelTerminal, menu: CodexMenu, label: string): Promise<boolean> {
  const option = menu.options.find((candidate) => candidate.label === label);
  // One key only picks 1–9.
  if (!option || option.number < 1 || option.number > 9) return false;
  await terminal.type(String(option.number));
  return true;
}

async function switchCodexModel(terminal: ModelTerminal, option: ModelOption, effort: string | null): Promise<ModelSwitchResult> {
  const before = await terminal.capture();
  await terminal.submit('/model');
  const models = await awaitScreen(terminal, (pane) => {
    const menu = readCodexMenu(pane);
    return menu?.kind === 'model' ? menu : null;
  }, MENU_TIMEOUT_MS);
  if (!models) {
    await closeMenus(terminal);
    return { status: 'unsure', message: t('model.switch.codexNoModelMenu') };
  }
  if (!await pick(terminal, models, option.label)) {
    await closeMenus(terminal);
    return { status: 'rejected', message: t('model.switch.codexModelMissing', { model: option.label }) };
  }
  if (effort) {
    const effortLabel = EFFORT_LABELS[effort] ?? effort;
    const levels = await awaitScreen(terminal, (pane) => {
      const menu = readCodexMenu(pane);
      return menu?.kind === 'effort' && menu.title === option.label ? menu : null;
    }, MENU_TIMEOUT_MS);
    if (!levels) {
      await closeMenus(terminal);
      return { status: 'unsure', message: t('model.switch.codexNoEffortMenu') };
    }
    let menu = levels;
    if (!menu.options.some((candidate) => candidate.label === effortLabel) && await pick(terminal, menu, MORE_REASONING)) {
      const advanced = await awaitScreen(terminal, (pane) => {
        const next = readCodexMenu(pane);
        return next?.kind === 'advanced' ? next : null;
      }, MENU_TIMEOUT_MS);
      if (!advanced) {
        await closeMenus(terminal);
        return { status: 'unsure', message: t('model.switch.codexNoAdvancedMenu') };
      }
      menu = advanced;
    }
    if (!await pick(terminal, menu, effortLabel)) {
      await closeMenus(terminal);
      return { status: 'rejected', message: t('model.switch.codexEffortMissing', { effort: effortLabel }) };
    }
  }
  const answer = await awaitNewAnswer(terminal, before, [CHANGED], ANSWER_TIMEOUT_MS);
  if (answer?.kind !== 'answer') {
    await closeMenus(terminal);
    return { status: 'unsure', message: t('model.switch.codexNoResult') };
  }
  const [, model, level] = answer.match;
  if (model !== option.id || (effort && level !== effort)) {
    return { status: 'unsure', message: t('model.switch.codexDifferent', { model: level ? `${model} ${level}` : model }) };
  }
  return { status: 'switched', label: option.label, effort: level ?? effort };
}

export const codexModels: ModelSupport = {
  source: 'account',
  list: listCodexModels,
  switchModel: switchCodexModel,
};
