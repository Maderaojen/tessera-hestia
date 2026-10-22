import type { NextFunction, Request, Response } from 'express';
import { defaultLocale, inLocale, localeFromAcceptLanguage } from './index.js';
import { rememberHostLocale } from './host-locale.js';

/**
 * Answers each request in the language it asks for (Accept-Language, which
 * the app's API client sets to its interface language), else the host's.
 * Accept-Language needs no CORS allowance, so a newer app still talks to an
 * older backend.
 */
export function interfaceLocale(req: Request, _res: Response, next: NextFunction): void {
  inLocale(localeFromAcceptLanguage(req.headers['accept-language']) ?? defaultLocale(), next);
}

/**
 * Behind the login: a request carrying the bearer header comes from the
 * app's own API client, so its language becomes the host's. Streams and
 * images authenticate through the URL and send the browser's own
 * preference; the hestia command uses its own token.
 */
export function rememberInterfaceLocale(req: Request, _res: Response, next: NextFunction): void {
  const asked = localeFromAcceptLanguage(req.headers['accept-language']);
  if (asked && req.headers.authorization?.startsWith('Bearer ')) rememberHostLocale(asked);
  next();
}
