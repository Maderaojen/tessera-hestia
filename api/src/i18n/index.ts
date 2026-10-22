import { AsyncLocalStorage } from 'node:async_hooks';
import { createTranslator } from '@maderaojen/i18n-vue/core';
import { MESSAGES, PROMPTS, type MessageKey, type PromptKey } from './messages.js';

export type { MessageKey, PromptKey } from './messages.js';

// The API's own text:
// what a person reads — the status and reasons the app shows, notifications,
// the hestia command's output — is in locales/<locale>/<area>.json and
// follows the person's interface language; what the app writes for an LLM or
// a CLI to read (briefs, prompts, lines typed into tmux) is in prompts/, in
// Chinese only, because changing it changes what the LLMs are told.
// scripts/check-i18n.mjs keeps both, and the code, in order.

export type Locale = 'zh-TW' | 'en-US';
export const LOCALES: readonly Locale[] = ['zh-TW', 'en-US'];
export const DEFAULT_LOCALE: Locale = 'zh-TW';

/** The locale a language tag asks for: any Chinese reads Traditional Chinese, any English English; null for anything else. */
export function localeOfTag(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split(/[-_.@]/)[0];
  if (primary === 'zh') return 'zh-TW';
  if (primary === 'en') return 'en-US';
  return null;
}

/**
 * The first language in an Accept-Language header there is text for, by
 * preference (q); null when it names none. The app sends exactly its
 * interface language; a browser's own header lists its languages.
 */
export function localeFromAcceptLanguage(header: string | undefined): Locale | null {
  if (!header) return null;
  const ranked = header.split(',').map((part, index) => {
    const [tag = '', ...params] = part.split(';');
    const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
    return { tag, q: q === undefined ? 1 : Number(q), index };
  }).filter((entry) => entry.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const locale = localeOfTag(tag);
    if (locale) return locale;
  }
  return null;
}

/** The hestia command's language: HESTIA_LOCALE, else the POSIX locale (LC_ALL, LC_MESSAGES, LANG), else Chinese. */
export function localeFromEnv(env: NodeJS.ProcessEnv = process.env): Locale {
  for (const name of ['HESTIA_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name]?.trim();
    // An empty variable doesn't count; the C locale names no language.
    if (!value || value === 'C' || value === 'POSIX' || value.startsWith('C.')) continue;
    return localeOfTag(value) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

// A request's language (i18n/http.ts runs each request inside it), and the
// language for text made outside any request: the host's (i18n/host-locale.ts)
// in the API, the environment's in the hestia command.
const requestLocale = new AsyncLocalStorage<Locale>();
let fallbackLocale: Locale = DEFAULT_LOCALE;

export function setDefaultLocale(locale: Locale): void {
  fallbackLocale = locale;
}

export function defaultLocale(): Locale {
  return fallbackLocale;
}

export function currentLocale(): Locale {
  return requestLocale.getStore() ?? fallbackLocale;
}

/** Runs `fn` (and whatever it starts) with `locale` as the current language. */
export function inLocale<T>(locale: Locale, fn: () => T): T {
  return requestLocale.run(locale, fn);
}

// A key missing in English shows the Chinese; one missing in both, the key.
const translate = createTranslator<Locale, MessageKey>({ messages: MESSAGES, fallbackLocale: DEFAULT_LOCALE });
const promptText = createTranslator<'zh-TW', PromptKey>({ messages: { 'zh-TW': PROMPTS } });

/** Text a person reads, in the current language. */
export function t(key: MessageKey, values?: Record<string, unknown>): string {
  return translate(currentLocale(), key, values);
}

/** Text a person reads, in a given language. */
export function tIn(locale: Locale, key: MessageKey, values?: Record<string, unknown>): string {
  return translate(locale, key, values);
}

/** Text written for an LLM or a CLI to read: always the Chinese in prompts/. */
export function prompt(key: PromptKey, values?: Record<string, unknown>): string {
  return promptText('zh-TW', key, values);
}
