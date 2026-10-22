// What `hestia pair` prints: which pairing links (contract/pairing.ts has
// their format), and which web frontend the web one opens.
import { APP_WEBVIEW_ORIGINS } from '../config.js';
import { appPairingLink, PAIRING_LINK_KINDS, type PairingLinkKind, webPairingLink } from '../contract/pairing.js';
import { t } from '../i18n/index.js';

// Kept under its old name (the web link was the default once).
export const pairingLink = webPairingLink;

// The web frontend a phone is sent to: the first web origin in
// CORS_ALLOWED_ORIGINS (the API's own allowlist), or the official one. The
// app WebView origins are skipped: nothing is served there for a phone's
// browser to open. This includes `http://tauri.localhost`, which otherwise
// matches the web-origin scheme check below.
export function frontendOrigin(corsAllowedOrigins: string | undefined, fallback: string): string {
  const first = (corsAllowedOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .find((origin) => origin && origin !== '*' && /^https?:\/\//.test(origin) && !APP_WEBVIEW_ORIGINS.includes(origin));
  return (first ?? fallback).replace(/\/+$/, '');
}

/**
 * The kinds of link to print, from --link or HESTIA_PAIR_LINK: `app` (the
 * default: the native app is the frontend offered), `web`, or `both` (web
 * first). The first one is the one in the QR code. Null for anything else.
 */
export function pairLinkKinds(value: string | undefined): PairingLinkKind[] | null {
  const choice = (value ?? '').trim().toLowerCase();
  if (choice === 'web') return ['web'];
  if (choice === '' || choice === 'app') return ['app'];
  if (choice === 'both') return [...PAIRING_LINK_KINDS];
  return null;
}

/** Each requested link, in order; the app one with `appScheme`. */
export function pairingLinks(kinds: PairingLinkKind[], frontend: string, backendUrl: string, code: string, appScheme?: string): { kind: PairingLinkKind; link: string }[] {
  return kinds.map((kind) => ({ kind, link: kind === 'app' ? appPairingLink(backendUrl, code, appScheme) : webPairingLink(frontend, backendUrl, code) }));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The backend address for the pairing link (--url or HESTIA_PUBLIC_URL),
 * checked by the same rules the frontend applies to a pairing link's
 * address (its normalizeBaseUrl): https, or http only to
 * this machine, with no credentials, query or fragment, and without a
 * trailing slash or /api. The scheme is required here — only the add-host
 * form's typed input may leave out https://. Null when the frontend would
 * refuse it, so the phone never gets a link that can't work.
 */
export function pairBackendUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${url.origin}${pathname}`;
}

/** Whether the backend is reached through Tailscale (a *.ts.net name). */
export function isTailnetUrl(backendUrl: string): boolean {
  try {
    return new URL(backendUrl).hostname.toLowerCase().endsWith('.ts.net');
  } catch {
    return false;
  }
}

/** What the phone needs before the link works. */
export function phoneReachHint(backendUrl: string): string {
  return isTailnetUrl(backendUrl)
    ? t('cli.pair.reachTailscale')
    : t('cli.pair.reach', { url: backendUrl });
}
