import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from '../child-env.js';
import type { ModelOption } from '../contract/models.js';
import { awaitNewAnswer, profileCommand } from './model-switch.js';
import type { ModelSupport } from './types.js';
import { t } from '../i18n/index.js';

const execFileAsync = promisify(execFile);
const LIST_TIMEOUT_MS = 30_000;

/**
 * What turns off Agy's self-update for every run of it, `agy models`
 * included (verified 1.3.3; agy.ts updateCheckOff).
 */
export const AGY_UPDATE_CHECK_OFF_ENV: Readonly<Record<string, string>> = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

/**
 * `agy models` (Agy 1.2.12, verified 2026-09-27) asks Google which models
 * the signed-in account can use, and prints one per line as
 * "<id>\t<label>", e.g. "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
 * after a "Fetching available models..." line. The effort is part of the
 * id, so there is nothing to choose separately. The list matches the
 * in-CLI /model menu.
 */
export function parseAgyModels(stdout: string): ModelOption[] {
  return stdout.split('\n').flatMap((line) => {
    const [id, label] = line.trim().split('\t');
    if (!id || !label || !/^[\w.-]+$/.test(id)) return [];
    return [{ id, label: label.trim(), efforts: [], defaultEffort: null, isDefault: false }];
  });
}

// Agy 1.2.12 answers `/model <id>` under the (argument-less) echo of the
// command with "⎿  Model set to Gemini 3.7 Flash (Low)", or "⎿  Invalid
// model "x" (available: …)". Captures: test/fixtures/model-switch/agy.*.
const SET = /Model set to (.+)$/m;
const INVALID = /Invalid model "([^"\n]*)"/;
const OTHER_ANSWER = /⎿\s+(\S.*)$/m;
const ANSWER_TIMEOUT_MS = 5_000;

export const agyModels: ModelSupport = {
  source: 'account',
  async list(profile) {
    const command = profileCommand(profile, ['models'], {}, AGY_UPDATE_CHECK_OFF_ENV);
    if (!command) throw new Error('launch profile cannot run agy');
    const { stdout } = await execFileAsync(command.argv[0]!, command.argv.slice(1), {
      timeout: LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...childEnv(), ...command.env },
    });
    const options = parseAgyModels(stdout);
    if (options.length === 0) throw new Error('agy models listed nothing');
    return options;
  },
  async switchModel(terminal, option) {
    const before = await terminal.capture();
    await terminal.submit(`/model ${option.id}`);
    const answer = await awaitNewAnswer(terminal, before, [SET, INVALID, OTHER_ANSWER], ANSWER_TIMEOUT_MS);
    if (answer?.kind !== 'answer') return { status: 'unsure', message: t('model.switch.noAnswer', { cli: 'Agy' }) };
    if (answer.index === 0) return { status: 'switched', label: answer.match[1]!.trim(), effort: null };
    if (answer.index === 1) return { status: 'rejected', message: t('model.switch.agyRejected', { model: option.id }) };
    return { status: 'unsure', message: t('model.switch.answered', { cli: 'Agy', answer: answer.match[1]!.trim() }) };
  },
};
