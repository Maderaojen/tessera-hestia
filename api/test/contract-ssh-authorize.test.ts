import { describe, expect, it } from 'vitest';
import { parseSshAuthorizeLink, sshAuthorizeLink, type SshAuthorizeLink } from '../src/contract/index.js';

const LINK: SshAuthorizeLink = {
  version: 1,
  username: 'jen',
  addresses: ['box.tail1.ts.net', '100.64.0.1', 'fd7a:115c::1'],
  sshPort: 22,
  hostKeyFingerprints: ['SHA256:uPG2mGtpMXuWtO+XxYmrc5w+HZtd2E/TZQ4PsC3lZVE', 'SHA256:DV1vJVid7mVjYO0Y1Rwop6B01jInQ7P+qJ6JTK4Cqdo'],
  ed25519Seed: 'A'.repeat(42) + 'Q',
  listenerPort: 51234,
  secret: '_-'.repeat(21) + 'g',
  commandName: 'hestia-dev',
  hestiaPort: 4792,
};

describe('ssh-authorize links', () => {
  it('round-trips, under both apps’ schemes, short enough for a QR code', () => {
    const link = sshAuthorizeLink(LINK, 'hestia-dev');
    expect(link.startsWith('hestia-dev://ssh-authorize?v=1&')).toBe(true);
    expect(link.length).toBeLessThan(400);
    expect(parseSshAuthorizeLink(link)).toEqual(LINK);
    expect(parseSshAuthorizeLink(sshAuthorizeLink(LINK))).toEqual(LINK);
    expect(parseSshAuthorizeLink(`  ${sshAuthorizeLink(LINK)}\n`)).toEqual(LINK);
  });

  it('refuses a missing or malformed field', () => {
    const link = new URL(sshAuthorizeLink(LINK));
    for (const field of ['u', 'a', 'p', 'hk', 'ek', 'l', 's', 'n', 'hp', 'v']) {
      const without = new URL(link);
      without.searchParams.delete(field);
      expect(parseSshAuthorizeLink(without.toString()), field).toBeNull();
    }
    const bad = (field: string, value: string) => {
      const url = new URL(link);
      url.searchParams.set(field, value);
      return parseSshAuthorizeLink(url.toString());
    };
    expect(bad('p', '0')).toBeNull();
    expect(bad('l', '70000')).toBeNull();
    expect(bad('ek', 'short')).toBeNull();
    expect(bad('hk', 'MD5:aa')).toBeNull();
    expect(bad('u', 'a b')).toBeNull();
    expect(bad('a', 'evil host/x')).toBeNull();
    expect(bad('n', 'Hestia!')).toBeNull();
  });

  it('refuses an unknown version, another kind of link, and anything too long', () => {
    expect(parseSshAuthorizeLink(sshAuthorizeLink(LINK).replace('v=1', 'v=2'))).toBeNull();
    expect(parseSshAuthorizeLink(sshAuthorizeLink(LINK).replace('ssh-authorize', 'pair'))).toBeNull();
    expect(parseSshAuthorizeLink(sshAuthorizeLink(LINK).replace('hestia://', 'https://'))).toBeNull();
    expect(parseSshAuthorizeLink(`${sshAuthorizeLink(LINK)}&x=${'a'.repeat(2048)}`)).toBeNull();
    expect(parseSshAuthorizeLink('not a link')).toBeNull();
    const many = new URL(sshAuthorizeLink(LINK));
    for (let i = 0; i < 9; i++) many.searchParams.append('a', `h${i}`);
    expect(parseSshAuthorizeLink(many.toString())).toBeNull();
  });
});
