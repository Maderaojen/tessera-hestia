// What `hestia ssh-authorize` needs to know about this machine's sshd: its port, whether it answers and is new
// enough for expiry-time, whether it reads ~/.ssh/authorized_keys at all,
// its host key fingerprints, and the addresses a phone might reach it at.
// Each piece reads files or the network through a small function, so the
// tests give them their own.
import { readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fingerprintOf } from './authorizedKeys.js';

/** The first OpenSSH with authorized_keys' expiry-time (release notes of 7.7, 2018). */
export const EXPIRY_TIME_SINCE = [7, 7] as const;

/** sshd_config's keyword lines, Include expanded (relative paths from /etc/ssh, `*` in the last part), Match blocks left out. */
export async function readSshdConfig(file: string, read = (p: string) => readFile(p, 'utf8'), depth = 0): Promise<[string, string][] | null> {
  let text: string;
  try {
    text = await read(file);
  } catch {
    return null;
  }
  const entries: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    // A Match block applies to some connections only; the global settings are what count here.
    if (keyword === 'match') break;
    if (keyword === 'include' && depth < 4) {
      for (const pattern of value.split(/\s+/)) {
        const absolute = path.isAbsolute(pattern) ? pattern : path.join(path.dirname(file), pattern);
        for (const each of await expand(absolute)) {
          entries.push(...((await readSshdConfig(each, read, depth + 1)) ?? []));
        }
      }
      continue;
    }
    entries.push([keyword, value]);
  }
  return entries;
}

async function expand(pattern: string): Promise<string[]> {
  const base = path.basename(pattern);
  if (!base.includes('*')) return [pattern];
  const dir = path.dirname(pattern);
  const re = new RegExp(`^${base.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => re.test(name)).sort().map((name) => path.join(dir, name));
}

/** sshd takes the first value it sees for a keyword. */
export function firstValue(entries: [string, string][], keyword: string): string | null {
  return entries.find(([k]) => k === keyword)?.[1] ?? null;
}

/** The port sshd listens on: sshd_config's first Port, else 22. */
export function sshdPort(entries: [string, string][] | null): number {
  const value = entries && firstValue(entries, 'port');
  const port = value ? Number(value.split(/\s+/)[0]) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
}

/**
 * Whether sshd reads `<home>/.ssh/authorized_keys` for `username`: true with
 * no AuthorizedKeysFile (the default lists it), or when one of the files it
 * lists is that one (%h, %u, %% and ~ expanded; relative to the home).
 */
export function readsDefaultFile(entries: [string, string][] | null, home: string, username: string): boolean {
  const value = entries && firstValue(entries, 'authorizedkeysfile');
  if (!value) return true;
  const wanted = path.join(home, '.ssh', 'authorized_keys');
  return value.split(/\s+/).some((token) => {
    const expanded = token.replace(/%%|%h|%u|%U/g, (m) => (m === '%%' ? '%' : m === '%h' ? home : m === '%u' ? username : String(process.getuid?.() ?? ''))).replace(/^~(?=\/|$)/, home);
    return path.resolve(home, expanded) === wanted;
  });
}

export type SshdBanner = { kind: 'banner'; text: string } | { kind: 'refused' } | { kind: 'silent' };

/** The identification line sshd sends first, read from 127.0.0.1:port. */
export function readSshdBanner(port: number, timeoutMs = 3000): Promise<SshdBanner> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = '';
    const done = (result: SshdBanner) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ kind: 'silent' }), timeoutMs);
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Lines before the SSH- one are allowed (RFC 4253 §4.2).
      const line = buffer.split(/\r?\n/).find((each) => each.startsWith('SSH-'));
      if (line !== undefined && /\r?\n/.test(buffer.slice(buffer.indexOf(line)))) done({ kind: 'banner', text: line.trim() });
      else if (buffer.length > 4096) done({ kind: 'silent' });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' ? { kind: 'refused' } : { kind: 'silent' }));
    socket.on('close', () => done({ kind: 'silent' }));
  });
}

/** The OpenSSH version in a banner (`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3`); null for another server. */
export function openSshVersion(banner: string): [number, number] | null {
  const match = /^SSH-2\.0-OpenSSH_(\d+)\.(\d+)/.exec(banner);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function supportsExpiryTime(version: [number, number]): boolean {
  return version[0] > EXPIRY_TIME_SINCE[0] || (version[0] === EXPIRY_TIME_SINCE[0] && version[1] >= EXPIRY_TIME_SINCE[1]);
}

/**
 * The SHA256 fingerprints of the host's ed25519 and ECDSA keys (readable by
 * everyone). Not RSA: the iOS app can't use an RSA host key.
 */
export async function hostKeyFingerprints(dir: string, read = (p: string) => readFile(p, 'utf8')): Promise<string[]> {
  const fingerprints: string[] = [];
  for (const name of ['ssh_host_ed25519_key.pub', 'ssh_host_ecdsa_key.pub']) {
    const text = await read(path.join(dir, name)).catch(() => null);
    const base64 = text?.trim().split(/\s+/)[1];
    if (base64 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fingerprints.push(fingerprintOf(Buffer.from(base64, 'base64')));
  }
  return fingerprints;
}

/** `tailscale status --json`'s own DNS name and 100.x address, when there are any. */
export function tailscaleAddresses(status: unknown): string[] {
  const self = (status as { Self?: { DNSName?: unknown; TailscaleIPs?: unknown } } | null)?.Self;
  if (!self) return [];
  const out: string[] = [];
  if (typeof self.DNSName === 'string' && self.DNSName) out.push(self.DNSName.replace(/\.$/, ''));
  if (Array.isArray(self.TailscaleIPs)) {
    for (const ip of self.TailscaleIPs) if (typeof ip === 'string' && net.isIPv4(ip)) out.push(ip);
  }
  return out;
}

/** Without Tailscale: the host name and every non-loopback IPv4 address. */
export function localAddresses(hostname = os.hostname(), interfaces = os.networkInterfaces()): string[] {
  const ips = Object.values(interfaces).flatMap((list) => list ?? []).filter((each) => each.family === 'IPv4' && !each.internal).map((each) => each.address);
  return [hostname, ...ips].filter((each, index, all) => each && all.indexOf(each) === index);
}
