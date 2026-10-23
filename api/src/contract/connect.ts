// The link `hestia connect` shows in its QR code: one code for both ways a
// phone can reach this computer.
//
//   both halves:  hestia://pair?url=<backend>&v=1&u=…&a=…&p=…&hk=…&ek=…&l=…&s=…&n=…&hp=…#code=<code>
//   URL only:     hestia://pair?url=<backend>#code=<code>      (pairing.ts's link, unchanged)
//   SSH only:     hestia://ssh-authorize?v=1&…                 (sshAuthorize.ts's link, unchanged)
//
// With both, it is a pairing link with the ssh-authorize fields added to its
// query: an app that only knows pairing links reads the URL half and ignores
// the rest (parsePairingLink reads `url` and `#code` only), so an older app
// still connects the way it always did. A newer one tries the URL first and
// falls back to SSH when the URL can't be reached.
//
// The SSH half carries secrets (ek, s): they go only in the app link, never
// in the web frontend's https link (connect's --link web is pairing.ts's
// webPairingLink, the URL half alone).

import { APP_LINK_SCHEME, parsePairingLink } from './pairing.js';
import { parseSshAuthorizeLink, readSshAuthorizeQuery, writeSshAuthorizeQuery, type SshAuthorizeLink } from './sshAuthorize.js';

/** A combined link longer than this is not one the command wrote (the QR code wouldn't fit a terminal either). */
export const CONNECT_LINK_MAX_LENGTH = 2048;

export type ConnectLink = {
  /** The URL half: the backend and a one-use pairing code. */
  url: { backendUrl: string; code: string } | null;
  /** The SSH half: ssh-authorize's fields. */
  ssh: SshAuthorizeLink | null;
};

/** The app link for whichever halves there are (the table above); throws when there are none. */
export function connectAppLink(link: ConnectLink, scheme: string = APP_LINK_SCHEME): string {
  if (link.url) {
    const query = new URLSearchParams();
    query.set('url', link.url.backendUrl);
    if (link.ssh) writeSshAuthorizeQuery(link.ssh, query);
    return `${scheme}://pair?${query.toString()}#code=${encodeURIComponent(link.url.code)}`;
  }
  if (!link.ssh) throw new Error('a connect link needs a URL or SSH');
  const query = new URLSearchParams();
  writeSshAuthorizeQuery(link.ssh, query);
  return `${scheme}://ssh-authorize?${query.toString()}`;
}

/**
 * Any link a phone may be handed to connect: the combined one, a plain
 * pairing link (app or web), or a plain ssh-authorize link; null for
 * anything else. An SSH half that is malformed or of a version this doesn't
 * know is dropped, and the URL half still used, rather than failing the
 * whole link.
 */
export function parseConnectLink(text: string): ConnectLink | null {
  const trimmed = text.trim();
  if (trimmed.length > CONNECT_LINK_MAX_LENGTH) return null;
  const pairing = parsePairingLink(trimmed);
  if (pairing) {
    let ssh: SshAuthorizeLink | null = null;
    // Only the app link carries an SSH half; the web link never does.
    if (pairing.kind === 'app' && new URL(trimmed).searchParams.has('v')) ssh = readSshAuthorizeQuery(new URL(trimmed).searchParams);
    return { url: { backendUrl: pairing.backendUrl, code: pairing.code }, ssh };
  }
  const ssh = parseSshAuthorizeLink(trimmed);
  return ssh ? { url: null, ssh } : null;
}
