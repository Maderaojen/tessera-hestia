import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type ConnectDeps, type PairingCodeStatus } from '../../src/cli/connect.js';
import { parseConnectLink, sshAuthorizeMacInput, type ConnectLink, type SshAuthorizeLink } from '../../src/contract/index.js';

// hestia connect in a temporary HOME, with a fake API (pairing codes kept in
// a map) and no sshd: the URL half, the SSH half, both, neither, and one QR
// code letting one phone in.

const PHONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJhX2VybVRXe2xun4hFTTx/w5QMT4Up2B7e6/FphBP6p phone';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB+Nh/1mdBbj0I7hdK8Fjs2R7PwuE0nSp53W/r8qClpq root@host';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'hestia-connect-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Harness = {
  deps: ConnectDeps;
  out: string[];
  codes: Map<string, PairingCodeStatus>;
  cancelled: string[];
  answer: (yes: boolean) => void;
  asked: Promise<string>;
  keysFile: () => string | null;
};

function harness(overrides: Partial<ConnectDeps> = {}): Harness {
  const out: string[] = [];
  const hostKeyDir = path.join(home, 'etc-ssh');
  mkdirSync(hostKeyDir, { recursive: true });
  writeFileSync(path.join(hostKeyDir, 'ssh_host_ed25519_key.pub'), `${HOST_KEY}\n`);
  const files = { sshDir: path.join(home, '.ssh'), uid: process.getuid!() };
  const codes = new Map<string, PairingCodeStatus>();
  const cancelled: string[] = [];
  let issued = 0;
  let answer: (yes: boolean) => void = () => {};
  let markAsked: (question: string) => void = () => {};
  const asked = new Promise<string>((resolve) => { markAsked = resolve; });
  const issue = () => {
    const code = `CODE${++issued}`;
    codes.set(code, { status: 'pending', expiresInMs: 180_000 });
    return code;
  };
  const deps: ConnectDeps = {
    uid: process.getuid!(),
    username: 'jen',
    home,
    files,
    hestiaPort: 4792,
    commandName: 'hestia-dev',
    scheme: 'hestia-dev',
    remoteLoginSetting: false,
    sshdConfigPath: path.join(hostKeyDir, 'sshd_config'),
    hostKeyDir,
    now: () => new Date(),
    out: (line) => out.push(line),
    interactive: true,
    confirm: (question, signal) => new Promise((resolve) => {
      answer = resolve;
      signal.addEventListener('abort', () => resolve(false));
      markAsked(question);
    }),
    banner: async () => ({ kind: 'banner', text: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13' }),
    tailscaleStatus: async () => ({ Self: { DNSName: 'quasar.tail1.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } }),
    localAddresses: () => ['quasar'],
    issuePairingCode: async () => issue(),
    onInterrupt: () => () => {},
    envUrl: 'https://quasar.tail1.ts.net:8443',
    envLinkKind: undefined,
    frontendOrigin: 'https://hestia.example.com',
    hostName: 'quasar',
    newPairingCode: async () => ({ code: issue(), expiresInMs: 180_000 }),
    pairingStatus: async (code) => codes.get(code) ?? { status: 'expired' },
    cancelPairingCode: async (code) => {
      cancelled.push(code);
      if (codes.get(code)?.status === 'pending') codes.set(code, { status: 'expired' });
    },
    revokePairing: async () => true,
    status: () => {},
    ask: async () => '',
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    columns: 120,
    ...overrides,
  };
  return {
    deps,
    out,
    codes,
    cancelled,
    answer: (yes) => answer(yes),
    asked,
    keysFile: () => {
      const file = path.join(files.sshDir, 'authorized_keys');
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
  };
}

/** The link the command printed (the "or paste" line), read back. */
async function printedLink(h: Harness): Promise<ConnectLink> {
  for (let i = 0; i < 200; i++) {
    const line = h.out.join('\n').split('\n').find((each) => each.includes('hestia-dev://'));
    if (line) return parseConnectLink(line.slice(line.indexOf('hestia-dev://')))!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no link printed:\n${h.out.join('\n')}`);
}

function signed(link: SshAuthorizeLink) {
  const label = 'hestia-iPhone';
  return { publicKey: PHONE, label, mac: createHmac('sha256', Buffer.from(link.secret, 'base64url')).update(sshAuthorizeMacInput(PHONE, label)).digest('base64url') };
}

describe('hestia connect', () => {
  it('one QR code with both halves; the phone comes in by the URL, the SSH half closes and leaves nothing behind', async () => {
    const h = harness();
    const run = connect([], h.deps);
    const link = await printedLink(h);
    expect(link.url).toEqual({ backendUrl: 'https://quasar.tail1.ts.net:8443', code: 'CODE1' });
    expect(link.ssh).toMatchObject({ username: 'jen', addresses: ['quasar.tail1.ts.net', '100.64.0.1'], hestiaPort: 4792 });
    expect(h.keysFile()).toMatch(/hestia-authorize-/);

    h.codes.set('CODE1', { status: 'used', usedAt: Date.now(), device: 'iPhone · Hestia Dev' });
    expect(await run).toBe(0);
    expect(h.out.join('\n')).toContain('✓ iPhone · Hestia Dev 已連上 quasar');
    // The one-time line is gone, and nothing else was written.
    expect(h.keysFile()).toBe('');
    // The listener is closed.
    await expect(fetch(`http://127.0.0.1:${link.ssh!.listenerPort}/`, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('a request over SSH takes the QR code’s pairing code back; after y the phone gets a new one', async () => {
    const h = harness();
    const run = connect([], h.deps);
    const link = await printedLink(h);
    const response = fetch(`http://127.0.0.1:${link.ssh!.listenerPort}/`, { method: 'POST', body: JSON.stringify(signed(link.ssh!)) });
    await h.asked;
    expect(h.cancelled).toEqual(['CODE1']);
    expect(h.codes.get('CODE1')).toEqual({ status: 'expired' });
    h.answer(true);
    const body = (await (await response).json()) as { ok: boolean; pairingCode: string };
    expect(body).toMatchObject({ ok: true, result: 'added', pairingCode: 'CODE2' });
    h.codes.set('CODE2', { status: 'used', usedAt: Date.now(), device: 'iPhone' });
    expect(await run).toBe(0);
    expect(h.out.join('\n')).toContain('✓ iPhone 已連上 quasar');
    expect(h.keysFile()).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:4792" ${PHONE.split(' ').slice(0, 2).join(' ')} hestia-iPhone\n`);
  });

  it('--no-ssh is the URL half alone, and authorized_keys is never touched', async () => {
    const h = harness();
    const run = connect(['--no-ssh'], h.deps);
    const link = await printedLink(h);
    expect(link).toEqual({ url: { backendUrl: 'https://quasar.tail1.ts.net:8443', code: 'CODE1' }, ssh: null });
    expect(h.out.join('\n')).not.toContain('沒有 SSH 備用');
    h.codes.set('CODE1', { status: 'used', usedAt: Date.now(), device: null });
    expect(await run).toBe(0);
    expect(h.keysFile()).toBeNull();
  });

  it('--no-wait: the URL half alone, saying why there is no SSH fallback, and no waiting', async () => {
    const h = harness();
    expect(await connect(['--no-wait'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('沒有 SSH 備用：--no-wait');
    expect((await printedLink(h)).ssh).toBeNull();
    expect(h.keysFile()).toBeNull();
  });

  it('with no address for this computer, the SSH half alone, and why there is no URL', async () => {
    const h = harness({ envUrl: undefined });
    const run = connect([], h.deps);
    const link = await printedLink(h);
    expect(link.url).toBeNull();
    expect(link.ssh).not.toBeNull();
    expect(h.out.join('\n')).toContain('沒有網址：');
    const response = fetch(`http://127.0.0.1:${link.ssh!.listenerPort}/`, { method: 'POST', body: JSON.stringify(signed(link.ssh!)) });
    await h.asked;
    h.answer(true);
    await response;
    h.codes.set('CODE1', { status: 'used', usedAt: Date.now(), device: 'Pixel' });
    expect(await run).toBe(0);
  });

  it('with neither half, it fails and says both reasons', async () => {
    const h = harness({ envUrl: undefined, banner: async () => ({ kind: 'refused' }) as never });
    expect(await connect([], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toContain('手機沒有辦法連到這台電腦');
    expect(text).toContain('網址：');
    expect(text).toContain('SSH：');
    expect(h.keysFile()).toBeNull();
  });

  it('N at the question ends it, and only the one-time line was ever there', async () => {
    const h = harness();
    const run = connect([], h.deps);
    const link = await printedLink(h);
    void fetch(`http://127.0.0.1:${link.ssh!.listenerPort}/`, { method: 'POST', body: JSON.stringify(signed(link.ssh!)) }).catch(() => {});
    await h.asked;
    h.answer(false);
    expect(await run).toBe(1);
    expect(h.keysFile()).toBe('');
  });

  it('time up with no phone: says so, cleans up', async () => {
    const h = harness();
    const run = connect([], h.deps);
    await printedLink(h);
    h.codes.set('CODE1', { status: 'expired' });
    expect(await run).toBe(1);
    expect(h.out.join('\n')).toContain('hestia-dev connect');
    expect(h.keysFile()).toBe('');
  });

  it('r after connecting takes that login back', async () => {
    const revoked: string[] = [];
    const h = harness({ ask: async () => 'r', revokePairing: async (code) => { revoked.push(code); return true; } });
    const run = connect(['--no-ssh'], h.deps);
    await printedLink(h);
    h.codes.set('CODE1', { status: 'used', usedAt: Date.now(), device: null });
    expect(await run).toBe(0);
    expect(revoked).toEqual(['CODE1']);
  });

  it('says so when the terminal is narrower than the QR code', async () => {
    const h = harness({ columns: 30 });
    expect(await connect(['--no-wait'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('終端機太窄');
  });

  it('--help names this install’s command', async () => {
    const h = harness();
    expect(await connect(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('usage: hestia-dev connect');
  });
});
