// The link `hestia ssh-authorize` shows in its QR code, how an app reads it
// back, and what the app sends to the command.
// Shared by the API's CLI (which writes the link and checks the request) and
// the app (which reads the link and makes the request), like pairing.ts.
//
//   hestia://ssh-authorize?v=1&u=<user>&a=<address>&a=…&p=<ssh port>
//     &hk=<SHA256:…>&hk=…&ek=<one-time key seed>&l=<listener port>
//     &s=<one-time secret>&n=<command name>&hp=<Hestia port>
//
// ek and s are 32 bytes each, base64url without padding. Together they are
// what lets a phone hand the command a public key: ek signs in to sshd with
// a line that can only forward to the command's own listener on port l, and
// s is the HMAC key the request is signed with. Neither reaches the Hestia
// API. The scheme names the app the same way pairing links do; either app
// reads both from its own scanner.
//
// A client must not do anything on its own when it opens such a link: it
// shows the account and address first and only connects once the user
// confirms (the command then asks again, in the server's own terminal).

import { APP_LINK_SCHEMES } from './pairing.js';

export const SSH_AUTHORIZE_LINK_VERSION = 1;
/** A link longer than this is not one the command wrote. */
export const SSH_AUTHORIZE_LINK_MAX_LENGTH = 2048;
const MAX_ADDRESSES = 8;
const MAX_HOST_KEYS = 4;

export type SshAuthorizeLink = {
  version: 1;
  /** The account the key is added for. */
  username: string;
  /** Where the app may reach sshd, most likely first. */
  addresses: string[];
  sshPort: number;
  /** The server's host key fingerprints (`SHA256:…`): the host key the app meets must be one of them. */
  hostKeyFingerprints: string[];
  /** The one-time ed25519 key's 32-byte seed, base64url. */
  ed25519Seed: string;
  /** The command's own listener on the server's 127.0.0.1. */
  listenerPort: number;
  /** The HMAC key for the request, base64url. */
  secret: string;
  /** Which install: `hestia`, `hestia-dev`, … */
  commandName: string;
  /** That install's API port on the server's loopback. */
  hestiaPort: number;
};

/** What the app POSTs to the command's listener. */
export type SshAuthorizeRequest = {
  /** `<type> <base64>`, optionally followed by a comment (ignored). */
  publicKey: string;
  /** The comment the command writes on the line. */
  label: string;
  /** base64url HMAC-SHA256(secret, sshAuthorizeMacInput(publicKey, label)). */
  mac: string;
};

export const SSH_AUTHORIZE_RESULTS = ['added', 'merged', 'present_unrestricted', 'present_other'] as const;
export type SshAuthorizeResult = (typeof SSH_AUTHORIZE_RESULTS)[number];

export const SSH_AUTHORIZE_ERROR_CODES = [
  'bad_request',
  'bad_mac',
  'key_unsupported',
  'busy',
  'declined',
  'write_failed',
] as const;
export type SshAuthorizeErrorCode = (typeof SSH_AUTHORIZE_ERROR_CODES)[number];

export type SshAuthorizeResponse =
  | {
    ok: true;
    result: SshAuthorizeResult;
    /** A pairing code for this install, or null when the API couldn't issue one. */
    pairingCode: string | null;
    port: number;
    name: string;
    /** For present_other: the line the command suggests (the user decides). */
    suggestedLine?: string;
  }
  | { ok: false; code: SshAuthorizeErrorCode };

/** The bytes the request's mac covers: a fixed context, the key, the label. */
export function sshAuthorizeMacInput(publicKey: string, label: string): string {
  return `hestia-ssh-authorize-v1\n${publicKey}\n${label}`;
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const USERNAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const COMMAND_NAME = /^[a-z0-9-]{1,32}$/;
// A DNS name, an IPv4 address or an IPv6 address (no brackets, no zone).
const ADDRESS = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|[0-9A-Fa-f:.]{2,45})$/;

function port(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Writes the link's fields into a query (the ssh-authorize link's, or connect.ts's combined one). */
export function writeSshAuthorizeQuery(link: SshAuthorizeLink, query: URLSearchParams): void {
  query.set('v', String(link.version));
  query.set('u', link.username);
  for (const address of link.addresses) query.append('a', address);
  query.set('p', String(link.sshPort));
  for (const fingerprint of link.hostKeyFingerprints) query.append('hk', fingerprint);
  query.set('ek', link.ed25519Seed);
  query.set('l', String(link.listenerPort));
  query.set('s', link.secret);
  query.set('n', link.commandName);
  query.set('hp', String(link.hestiaPort));
}

/** The link's fields read back from a query; null when any is missing or malformed, or the version isn't one this reads. */
export function readSshAuthorizeQuery(q: URLSearchParams): SshAuthorizeLink | null {
  if (q.get('v') !== String(SSH_AUTHORIZE_LINK_VERSION)) return null;
  const username = q.get('u');
  const addresses = q.getAll('a');
  const hostKeyFingerprints = q.getAll('hk');
  const ed25519Seed = q.get('ek');
  const secret = q.get('s');
  const commandName = q.get('n');
  const sshPort = port(q.get('p'));
  const listenerPort = port(q.get('l'));
  const hestiaPort = port(q.get('hp'));
  if (!username || !USERNAME.test(username)) return null;
  if (addresses.length === 0 || addresses.length > MAX_ADDRESSES || !addresses.every((a) => ADDRESS.test(a))) return null;
  if (hostKeyFingerprints.length === 0 || hostKeyFingerprints.length > MAX_HOST_KEYS || !hostKeyFingerprints.every((f) => FINGERPRINT.test(f))) return null;
  if (!ed25519Seed || !BASE64URL_32.test(ed25519Seed) || !secret || !BASE64URL_32.test(secret)) return null;
  if (!commandName || !COMMAND_NAME.test(commandName)) return null;
  if (sshPort === null || listenerPort === null || hestiaPort === null) return null;
  return { version: 1, username, addresses, sshPort, hostKeyFingerprints, ed25519Seed, listenerPort, secret, commandName, hestiaPort };
}

/** The app link (scheme `hestia` or `hestia-dev`). */
export function sshAuthorizeLink(link: SshAuthorizeLink, scheme: string = APP_LINK_SCHEMES[0]!): string {
  const query = new URLSearchParams();
  writeSshAuthorizeQuery(link, query);
  return `${scheme}://ssh-authorize?${query.toString()}`;
}

/** An ssh-authorize link read back; null for anything else, or anything malformed. */
export function parseSshAuthorizeLink(text: string): SshAuthorizeLink | null {
  const trimmed = text.trim();
  if (trimmed.length > SSH_AUTHORIZE_LINK_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!APP_LINK_SCHEMES.some((scheme) => url.protocol === `${scheme}:`)) return null;
  // `hestia://ssh-authorize?…` puts it in the host; `hestia:ssh-authorize?…` in the path.
  if (url.hostname !== 'ssh-authorize' && url.pathname !== 'ssh-authorize') return null;
  return readSshAuthorizeQuery(url.searchParams);
}
