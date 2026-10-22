// The pairing links `hestia pair` prints (and puts in its QR code), and how
// a client reads them back. Shared by the API's CLI (which writes them), the
// web app and the native app (which read them): one definition of the
// format, so a link one side writes is always one the other can read.
//
// Both kinds carry the same two things: the backend's address, in the query,
// and a one-use pairing code (auth.ts's issuePairingCode), after the `#`.
// A browser never sends a fragment to a server, so the code stays out of the
// web frontend host's logs; the app gets it from the OS with the link.
//
//   web:  https://<web frontend>/login?mode=add&url=<backend>#pair=<code>
//   app:  hestia://pair?url=<backend>#code=<code>
//
// A client must not pair on its own when it opens either one: anyone can
// send such a link, and pairing without asking would silently add and
// switch to their backend. It shows the backend's full origin first and
// only calls POST /auth/pair once the user confirms (web: LoginView.vue).

/** The URL scheme the native app registers for its deep links. */
export const APP_LINK_SCHEME = 'hestia';

export const PAIRING_LINK_KINDS = ['web', 'app'] as const;
export type PairingLinkKind = (typeof PAIRING_LINK_KINDS)[number];

export type PairingLink = { kind: PairingLinkKind; backendUrl: string; code: string };

/** The web frontend's add-host form with the backend and the code filled in. */
export function webPairingLink(frontendOrigin: string, backendUrl: string, code: string): string {
  const frontend = frontendOrigin.replace(/\/+$/, '');
  return `${frontend}/login?mode=add&url=${encodeURIComponent(backendUrl)}#pair=${encodeURIComponent(code)}`;
}

/** The native app's deep link: the same add-host confirmation, in the app. */
export function appPairingLink(backendUrl: string, code: string): string {
  return `${APP_LINK_SCHEME}://pair?url=${encodeURIComponent(backendUrl)}#code=${encodeURIComponent(code)}`;
}

function fragmentValue(hash: string, key: string): string | null {
  const match = new RegExp(`^#${key}=(.+)$`).exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/**
 * Either kind of pairing link, read back; null for anything else. An app's
 * own QR scanner should accept both: the web link is what `hestia pair`
 * shows by default.
 */
export function parsePairingLink(link: string): PairingLink | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const backendUrl = url.searchParams.get('url');
  if (!backendUrl) return null;
  if (url.protocol === `${APP_LINK_SCHEME}:`) {
    // `hestia://pair?…` puts "pair" in the host; `hestia:pair?…` in the path.
    if (url.hostname !== 'pair' && url.pathname !== 'pair') return null;
    const code = fragmentValue(url.hash, 'code');
    return code ? { kind: 'app', backendUrl, code } : null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/\/login\/?$/.test(url.pathname) || url.searchParams.get('mode') !== 'add') return null;
  const code = fragmentValue(url.hash, 'pair');
  return code ? { kind: 'web', backendUrl, code } : null;
}
