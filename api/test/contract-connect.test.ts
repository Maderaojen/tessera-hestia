import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import {
  appPairingLink,
  connectAppLink,
  parseConnectLink,
  parsePairingLink,
  parseSshAuthorizeLink,
  sshAuthorizeLink,
  webPairingLink,
  type SshAuthorizeLink,
} from '../src/contract/index.js';

// The link hestia connect puts in its QR code: a pairing link that may also
// carry ssh-authorize's fields.

const SSH: SshAuthorizeLink = {
  version: 1,
  username: 'jen',
  addresses: ['quasar.taild0e999.ts.net', '100.101.102.103'],
  sshPort: 22,
  hostKeyFingerprints: ['SHA256:uPG2mGtpMXuWtO+XxYmrc5w+HZtd2E/TZQ4PsC3lZVE', 'SHA256:DV1vJVid7mVjYO0Y1Rwop6B01jInQ7P+qJ6JTK4Cqdo'],
  ed25519Seed: 'A'.repeat(42) + 'Q',
  listenerPort: 51234,
  secret: '_-'.repeat(21) + 'g',
  commandName: 'hestia-dev',
  hestiaPort: 4792,
};
const URL_HALF = { backendUrl: 'https://quasar.taild0e999.ts.net:8443', code: 'Ab3_dE-9fGhIjKlMnOpQrs' };

describe('connect links', () => {
  it('with both halves: a pairing link carrying the SSH fields, read back whole', () => {
    const link = connectAppLink({ url: URL_HALF, ssh: SSH }, 'hestia-dev');
    expect(link.startsWith('hestia-dev://pair?url=')).toBe(true);
    expect(link).toMatch(/#code=/);
    expect(parseConnectLink(link)).toEqual({ url: URL_HALF, ssh: SSH });
  });

  it('an app that knows only pairing links reads the URL half and nothing else', () => {
    const link = connectAppLink({ url: URL_HALF, ssh: SSH });
    expect(parsePairingLink(link)).toEqual({ kind: 'app', ...URL_HALF });
    expect(parseSshAuthorizeLink(link)).toBeNull();
  });

  it('with one half, the link is exactly that half’s own link', () => {
    expect(connectAppLink({ url: URL_HALF, ssh: null })).toBe(appPairingLink(URL_HALF.backendUrl, URL_HALF.code));
    expect(connectAppLink({ url: null, ssh: SSH }, 'hestia-dev')).toBe(sshAuthorizeLink(SSH, 'hestia-dev'));
    expect(() => connectAppLink({ url: null, ssh: null })).toThrow();
  });

  it('reads every link a phone may be handed: combined, pairing (app or web), ssh-authorize', () => {
    expect(parseConnectLink(appPairingLink(URL_HALF.backendUrl, URL_HALF.code))).toEqual({ url: URL_HALF, ssh: null });
    expect(parseConnectLink(webPairingLink('https://hestia.example.com', URL_HALF.backendUrl, URL_HALF.code))).toEqual({ url: URL_HALF, ssh: null });
    expect(parseConnectLink(sshAuthorizeLink(SSH))).toEqual({ url: null, ssh: SSH });
    expect(parseConnectLink('https://example.com/')).toBeNull();
    expect(parseConnectLink('not a link')).toBeNull();
  });

  it('a broken or unknown SSH half is dropped and the URL half still used', () => {
    const link = new URL(connectAppLink({ url: URL_HALF, ssh: SSH }));
    link.searchParams.set('v', '9');
    expect(parseConnectLink(link.toString())).toEqual({ url: URL_HALF, ssh: null });
    link.searchParams.set('v', '1');
    link.searchParams.delete('ek');
    expect(parseConnectLink(link.toString())).toEqual({ url: URL_HALF, ssh: null });
  });

  it('two addresses and two host keys stay small enough for an 80-column terminal', () => {
    const link = connectAppLink({ url: URL_HALF, ssh: SSH }, 'hestia-dev');
    expect(link.length).toBeLessThanOrEqual(440);
    expect(encode(link).version).toBeLessThanOrEqual(13);
  });

  it('a web link never carries the SSH secrets', () => {
    const web = webPairingLink('https://hestia.example.com', URL_HALF.backendUrl, URL_HALF.code);
    for (const key of ['ek', 's', 'hk']) expect(new URL(web).searchParams.has(key)).toBe(false);
  });
});
