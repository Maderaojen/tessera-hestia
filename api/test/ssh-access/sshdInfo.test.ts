import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostKeyFingerprints,
  localAddresses,
  openSshVersion,
  readsDefaultFile,
  readSshdBanner,
  readSshdConfig,
  sshdPort,
  supportsExpiryTime,
  tailscaleAddresses,
} from '../../src/ssh-access/sshdInfo.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'hestia-sshd-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sshd_config', () => {
  it('reads keywords, Include (relative, with *), and stops at Match', async () => {
    mkdirSync(path.join(dir, 'sshd_config.d'));
    writeFileSync(path.join(dir, 'sshd_config.d', '10-port.conf'), 'Port 2222\n');
    writeFileSync(path.join(dir, 'sshd_config.d', 'skip.txt'), 'Port 1\n');
    writeFileSync(path.join(dir, 'sshd_config'), '# c\nInclude sshd_config.d/*.conf\nPort 22\nAuthorizedKeysFile=.ssh/authorized_keys\nMatch User x\n  AuthorizedKeysFile /other\n');
    const entries = (await readSshdConfig(path.join(dir, 'sshd_config')))!;
    expect(entries).toEqual([['port', '2222'], ['port', '22'], ['authorizedkeysfile', '.ssh/authorized_keys']]);
    expect(sshdPort(entries)).toBe(2222);
    expect(sshdPort(null)).toBe(22);
    expect(await readSshdConfig(path.join(dir, 'missing'))).toBeNull();
  });

  it('knows whether ~/.ssh/authorized_keys is read', () => {
    const home = '/home/alex';
    expect(readsDefaultFile(null, home, 'alex')).toBe(true);
    expect(readsDefaultFile([], home, 'alex')).toBe(true);
    expect(readsDefaultFile([['authorizedkeysfile', '.ssh/authorized_keys .ssh/authorized_keys2']], home, 'alex')).toBe(true);
    expect(readsDefaultFile([['authorizedkeysfile', '%h/.ssh/authorized_keys']], home, 'alex')).toBe(true);
    expect(readsDefaultFile([['authorizedkeysfile', '/home/%u/.ssh/authorized_keys']], home, 'alex')).toBe(true);
    expect(readsDefaultFile([['authorizedkeysfile', '/etc/ssh/keys/%u']], home, 'alex')).toBe(false);
    expect(readsDefaultFile([['authorizedkeysfile', '.ssh/keys']], home, 'alex')).toBe(false);
  });
});

describe('the banner', () => {
  it('reads OpenSSH versions; expiry-time needs 7.7', () => {
    expect(openSshVersion('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13')).toEqual([9, 6]);
    expect(openSshVersion('SSH-2.0-OpenSSH_10.3')).toEqual([10, 3]);
    expect(openSshVersion('SSH-2.0-dropbear_2022.83')).toBeNull();
    expect(supportsExpiryTime([7, 7])).toBe(true);
    expect(supportsExpiryTime([7, 6])).toBe(false);
    expect(supportsExpiryTime([10, 0])).toBe(true);
  });

  it('reads the identification line, and tells a closed port from a silent one', async () => {
    const server = net.createServer((socket) => socket.end('hello\r\nSSH-2.0-OpenSSH_9.6\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await readSshdBanner(port)).toEqual({ kind: 'banner', text: 'SSH-2.0-OpenSSH_9.6' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await readSshdBanner(port)).toEqual({ kind: 'refused' });
  });
});

describe('host keys and addresses', () => {
  it('fingerprints ed25519 and ECDSA host keys, never RSA', async () => {
    writeFileSync(path.join(dir, 'ssh_host_ed25519_key.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJhX2VybVRXe2xun4hFTTx/w5QMT4Up2B7e6/FphBP6p root@x\n');
    writeFileSync(path.join(dir, 'ssh_host_rsa_key.pub'), 'ssh-rsa AAAA root@x\n');
    expect(await hostKeyFingerprints(dir)).toEqual(['SHA256:uPG2mGtpMXuWtO+XxYmrc5w+HZtd2E/TZQ4PsC3lZVE']);
  });

  it('takes Tailscale’s name and IPv4 address, else the host name and IPv4 addresses', () => {
    expect(tailscaleAddresses({ Self: { DNSName: 'box.tail1.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } })).toEqual(['box.tail1.ts.net', '100.64.0.1']);
    expect(tailscaleAddresses(null)).toEqual([]);
    expect(localAddresses('box', {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
      en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    })).toEqual(['box', '192.168.1.5']);
  });
});
