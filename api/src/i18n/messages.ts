// Every text file, imported one by one so the compiler copies them into
// dist/ and types their keys: a mistyped key fails to compile (t and prompt
// only take these). scripts/check-i18n.mjs fails when a file is missing here.
import zhAccount from './locales/zh-TW/account.json' with { type: 'json' };
import zhCli from './locales/zh-TW/cli.json' with { type: 'json' };
import zhContinuity from './locales/zh-TW/continuity.json' with { type: 'json' };
import zhDelegation from './locales/zh-TW/delegation.json' with { type: 'json' };
import zhFork from './locales/zh-TW/fork.json' with { type: 'json' };
import zhFormat from './locales/zh-TW/format.json' with { type: 'json' };
import zhLaunch from './locales/zh-TW/launch.json' with { type: 'json' };
import zhModel from './locales/zh-TW/model.json' with { type: 'json' };
import zhPush from './locales/zh-TW/push.json' with { type: 'json' };
import zhSession from './locales/zh-TW/session.json' with { type: 'json' };
import zhSpawn from './locales/zh-TW/spawn.json' with { type: 'json' };
import zhUsage from './locales/zh-TW/usage.json' with { type: 'json' };
import enAccount from './locales/en-US/account.json' with { type: 'json' };
import enCli from './locales/en-US/cli.json' with { type: 'json' };
import enContinuity from './locales/en-US/continuity.json' with { type: 'json' };
import enDelegation from './locales/en-US/delegation.json' with { type: 'json' };
import enFork from './locales/en-US/fork.json' with { type: 'json' };
import enFormat from './locales/en-US/format.json' with { type: 'json' };
import enLaunch from './locales/en-US/launch.json' with { type: 'json' };
import enModel from './locales/en-US/model.json' with { type: 'json' };
import enPush from './locales/en-US/push.json' with { type: 'json' };
import enSession from './locales/en-US/session.json' with { type: 'json' };
import enSpawn from './locales/en-US/spawn.json' with { type: 'json' };
import enUsage from './locales/en-US/usage.json' with { type: 'json' };
import promptContinuity from './prompts/continuity.json' with { type: 'json' };
import promptDelegation from './prompts/delegation.json' with { type: 'json' };
import promptFork from './prompts/fork.json' with { type: 'json' };
import promptHandoff from './prompts/handoff.json' with { type: 'json' };
import promptRecap from './prompts/recap.json' with { type: 'json' };
import promptTranscript from './prompts/transcript.json' with { type: 'json' };
import promptUpstream from './prompts/upstream.json' with { type: 'json' };

const ZH = [zhAccount, zhCli, zhContinuity, zhDelegation, zhFork, zhFormat, zhLaunch, zhModel, zhPush, zhSession, zhSpawn, zhUsage] as const;
const PROMPT_FILES = [promptContinuity, promptDelegation, promptFork, promptHandoff, promptRecap, promptTranscript, promptUpstream] as const;

/** A key of the text a person reads (locales/zh-TW, the same in en-US). */
export type MessageKey = keyof typeof zhAccount | keyof typeof zhCli | keyof typeof zhContinuity | keyof typeof zhDelegation
  | keyof typeof zhFork | keyof typeof zhFormat | keyof typeof zhLaunch | keyof typeof zhModel | keyof typeof zhPush | keyof typeof zhSession
  | keyof typeof zhSpawn | keyof typeof zhUsage;
/** A key of the text written for an LLM or a CLI (prompts/). */
export type PromptKey = keyof typeof promptContinuity | keyof typeof promptDelegation | keyof typeof promptFork
  | keyof typeof promptHandoff | keyof typeof promptRecap | keyof typeof promptTranscript | keyof typeof promptUpstream;

type Dictionary = Record<string, string>;
const merge = (files: readonly object[]): Dictionary => Object.assign({}, ...files) as Dictionary;

export const MESSAGES: Record<'zh-TW' | 'en-US', Dictionary> = {
  'zh-TW': merge(ZH),
  'en-US': merge([enAccount, enCli, enContinuity, enDelegation, enFork, enFormat, enLaunch, enModel, enPush, enSession, enSpawn, enUsage]),
};

export const PROMPTS: Dictionary = merge(PROMPT_FILES);
