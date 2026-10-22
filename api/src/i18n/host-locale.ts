import { jsonFileStore } from '@maderaojen/json-file-store';
import { INTERFACE_LOCALE_PATH } from '../config.js';
import { LOCALES, defaultLocale, setDefaultLocale, type Locale } from './index.js';

// The host's interface language: the one its person's app last used. Text
// the API makes with no request to answer — a notification, a session's
// last error, a handoff's or a delegation's status — is written in it.
// One person uses a host, so one language serves; kept on disk so a restart
// doesn't fall back to Chinese.
const store = jsonFileStore<{ locale: Locale } | null>({ path: INTERFACE_LOCALE_PATH, empty: () => null });

export async function loadHostLocale(): Promise<void> {
  const saved = await store.load().catch(() => null);
  if (saved && LOCALES.includes(saved.locale)) setDefaultLocale(saved.locale);
}

export function rememberHostLocale(locale: Locale): void {
  if (locale === defaultLocale()) return;
  setDefaultLocale(locale);
  void store.save({ locale }).catch((err: unknown) => console.warn('[i18n] could not save the interface language', err));
}
