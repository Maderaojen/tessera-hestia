import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePublicKey } from '../../src/ssh-access/authorizedKeys.js';
import { checkAuthorizeRequest, macMatches, parseSshAuthorizeArgs, sshAuthorize, type SshAuthorizeDeps } from '../../src/cli/sshAuthorize.js';
import { parseSshAuthorizeLink, sshAuthorizeMacInput, type SshAuthorizeLink } from '../../src/contract/sshAuthorize.js';

// The whole command in a temporary HOME: its own ~/.ssh, its own host keys,
// no sshd (the banner is given) and no app (the test posts to the
// listener on 127.0.0.1 itself, as the app does through its tunnel).

const PHONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJhX2VybVRXe2xun4hFTTx/w5QMT4Up2B7e6/FphBP6p phone';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB+Nh/1mdBbj0I7hdK8Fjs2R7PwuE0nSp53W/r8qClpq root@host';

type Harness = {
  deps: SshAuthorizeDeps;
  out: string[];
  /** Resolves the y/N question the next time it is asked. */
  answer: (yes: boolean) => void;
  asked: Promise<string>;
  interrupt: () => void;
  file: () => string;
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'hestia-ssh-authorize-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(overrides: Partial<SshAuthorizeDeps> = {}): Harness {
  const out: string[] = [];
  const hostKeyDir = path.join(home, 'etc-ssh');
  mkdirSync(hostKeyDir, { recursive: true });
  writeFileSync(path.join(hostKeyDir, 'ssh_host_ed25519_key.pub'), `${HOST_KEY}\n`);
  let answer: (yes: boolean) => void = () => {};
  let markAsked: (question: string) => void = () => {};
  const asked = new Promise<string>((resolve) => { markAsked = resolve; });
  let interrupt = () => {};
  const files = { sshDir: path.join(home, '.ssh'), uid: process.getuid!() };
  const deps: SshAuthorizeDeps = {
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
    tailscaleStatus: async () => ({ Self: { DNSName: 'box.tail1.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } }),
    localAddresses: () => ['box'],
    issuePairingCode: async () => 'PAIRCODE',
    onInterrupt: (cleanup) => {
      interrupt = cleanup;
      return () => { interrupt = () => {}; };
    },
    ...overrides,
  };
  return {
    deps,
    out,
    answer: (yes) => answer(yes),
    asked,
    interrupt: () => interrupt(),
    file: () => readFileSync(path.join(files.sshDir, 'authorized_keys'), 'utf8'),
  };
}

/** The link the command printed, once it has. */
async function printedLink(h: Harness): Promise<SshAuthorizeLink> {
  for (let i = 0; i < 200; i++) {
    const line = h.out.join('\n').split('\n').find((each) => each.includes('hestia-dev://ssh-authorize?'));
    if (line) return parseSshAuthorizeLink(line.slice(line.indexOf('hestia-dev://')))!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no link printed:\n${h.out.join('\n')}`);
}

function post(link: SshAuthorizeLink, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`http://127.0.0.1:${link.listenerPort}/`, { method: 'POST', body: JSON.stringify(body) })
    .then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> }));
}

const mac = (link: SshAuthorizeLink, publicKey: string, label: string) =>
  createHmac('sha256', Buffer.from(link.secret, 'base64url')).update(sshAuthorizeMacInput(publicKey, label)).digest('base64url');

const signed = (link: SshAuthorizeLink, publicKey = PHONE, label = 'hestia-iPhone') => ({ publicKey, label, mac: mac(link, publicKey, label) });

describe('hestia ssh-authorize', () => {
  it('--help names the command this install goes by', async () => {
    const h = harness();
    expect(await sshAuthorize(['--help'], h.deps)).toEqual({ exitCode: 0, pairingCode: null });
    expect(h.out.join('\n')).toContain('usage: hestia-dev ssh-authorize [--address HOST]');
    expect(h.out.join('\n')).not.toMatch(/\bhestia ssh-authorize/);
  });

  it('scan, check, y: the key is added restricted to this install, and the one-time line is gone', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    expect(link).toMatchObject({ username: 'jen', addresses: ['box.tail1.ts.net', '100.64.0.1'], sshPort: 22, commandName: 'hestia-dev', hestiaPort: 4792 });
    expect(link.hostKeyFingerprints).toEqual([parsePublicKey(HOST_KEY)!.fingerprint]);
    // While waiting: one line, the one-time key, forwarding only to the listener.
    const waiting = h.file();
    expect(waiting).toMatch(new RegExp(`^restrict,port-forwarding,permitopen="127\\.0\\.0\\.1:${link.listenerPort}",expiry-time="\\d{12}Z" ssh-ed25519 \\S+ hestia-authorize-\\S+\\n$`));

    const response = post(link, signed(link));
    expect(await h.asked).toContain('4792');
    expect(h.out.join('\n')).toContain(parsePublicKey(PHONE)!.fingerprint);
    h.answer(true);
    expect(await response).toEqual({ status: 200, json: { ok: true, result: 'added', pairingCode: 'PAIRCODE', port: 4792, name: 'hestia-dev' } });
    expect(await run).toEqual({ exitCode: 0, pairingCode: 'PAIRCODE' });
    expect(h.file()).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:4792" ${PHONE.split(' ').slice(0, 2).join(' ')} hestia-iPhone\n`);
  });

  it('turns away a wrong mac and keeps waiting for the right one', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    expect(await post(link, { ...signed(link), mac: mac(link, PHONE, 'something else') })).toEqual({ status: 403, json: { ok: false, code: 'bad_mac' } });
    expect(await post(link, { ...signed(link), mac: 'short' })).toEqual({ status: 403, json: { ok: false, code: 'bad_mac' } });
    expect(await post(link, { publicKey: PHONE })).toEqual({ status: 400, json: { ok: false, code: 'bad_request' } });
    const response = post(link, signed(link));
    await h.asked;
    h.answer(true);
    expect((await response).json.ok).toBe(true);
    expect((await run).exitCode).toBe(0);
  });

  it('answers the app’s WebView origins (CORS), and no other page', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const url = `http://127.0.0.1:${link.listenerPort}/`;
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    const evil = await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify(signed(link)) });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const response = fetch(url, { method: 'POST', headers: { Origin: 'https://localhost', 'Content-Type': 'text/plain' }, body: JSON.stringify(signed(link)) });
    await h.asked;
    h.answer(true);
    const answered = await response;
    expect(answered.headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect(((await answered.json()) as { ok: boolean }).ok).toBe(true);
    await run;
  });

  it('turns away keys it doesn’t take, even signed', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const short = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQCVLjs6652vOh6FVPgYn3xFN8HTyRa47lywWUa1B88ZPsoUxXyl6mINx6gqRHE0vGCWe1FpQk696Vk7SCFPvAJ2kKiAAKt0ocW0hLqu73RX0ZDbPionfmES02zqaK4SVlmZVqCCvvqw8/k93hRgeLY27EO0Fr71HaeQc1MltAbJKQ==';
    expect(await post(link, signed(link, short))).toEqual({ status: 400, json: { ok: false, code: 'key_unsupported' } });
    h.interrupt();
    expect((await run).exitCode).toBe(1);
  });

  it('only the first request that passes counts', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const first = post(link, signed(link));
    await h.asked;
    expect(await post(link, signed(link))).toEqual({ status: 409, json: { ok: false, code: 'busy' } });
    h.answer(true);
    expect((await first).json.ok).toBe(true);
    await run;
  });

  it('N writes nothing, and the one-time line still goes', async () => {
    const h = harness();
    mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    writeFileSync(path.join(home, '.ssh', 'authorized_keys'), '# mine\n');
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const response = post(link, signed(link));
    await h.asked;
    h.answer(false);
    expect(await response).toEqual({ status: 200, json: { ok: false, code: 'declined' } });
    expect(await run).toEqual({ exitCode: 1, pairingCode: null });
    expect(h.file()).toBe('# mine\n');
  });

  it('Ctrl-C while waiting removes the one-time line and closes the listener', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    h.interrupt();
    expect((await run).exitCode).toBe(1);
    expect(h.file()).toBe('');
    await expect(fetch(`http://127.0.0.1:${link.listenerPort}/`, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('Ctrl-C at the question: nothing added, the app is told no', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const response = post(link, signed(link)).catch(() => null);
    await h.asked;
    h.interrupt();
    expect((await run).exitCode).toBe(1);
    expect(h.file()).toBe('');
    const answered = await response;
    if (answered) expect(answered.json).toEqual({ ok: false, code: 'declined' });
  });

  it('the app giving up ends the question', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${link.listenerPort}/`, { method: 'POST', body: JSON.stringify(signed(link)), signal: controller.signal }).catch(() => 'aborted');
    await h.asked;
    controller.abort();
    expect(await response).toBe('aborted');
    expect((await run).exitCode).toBe(1);
    expect(h.file()).toBe('');
  });

  it('an error while writing still removes the one-time line', async () => {
    const h = harness();
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const response = post(link, signed(link));
    await h.asked;
    // ~/.ssh turns loose between the start and the write: the write stops.
    const { chmodSync } = await import('node:fs');
    chmodSync(path.join(home, '.ssh', 'authorized_keys'), 0o666);
    h.answer(true);
    expect(await response).toEqual({ status: 500, json: { ok: false, code: 'write_failed' } });
    expect((await run).exitCode).toBe(1);
    expect(h.out.join('\n')).toContain('chmod go-w');
    // The cleanup is refused the same way: the line stays (and expires), and the command says so.
    expect(h.out.join('\n')).toMatch(/hestia-authorize-/);
  });

  it('merges the port into a line Hestia wrote for the other install', async () => {
    const h = harness();
    mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    const existing = `restrict,port-forwarding,permitopen="127.0.0.1:4791" ${PHONE}\n`;
    writeFileSync(path.join(home, '.ssh', 'authorized_keys'), existing);
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const response = post(link, signed(link));
    await h.asked;
    h.answer(true);
    expect((await response).json.result).toBe('merged');
    await run;
    expect(h.file()).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:4791",permitopen="127.0.0.1:4792" ${PHONE}\n`);
  });

  it('a key already allowed without restrictions is left alone', async () => {
    const h = harness();
    mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    writeFileSync(path.join(home, '.ssh', 'authorized_keys'), `${PHONE}\n`);
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const response = post(link, signed(link));
    await h.asked;
    h.answer(true);
    const { json } = await response;
    expect(json).toMatchObject({ ok: true, result: 'present_unrestricted', pairingCode: 'PAIRCODE' });
    expect(json.suggestedLine).toContain('permitopen="127.0.0.1:4792"');
    await run;
    expect(h.file()).toBe(`${PHONE}\n`);
  });

  it('without a pairing code the key is still added', async () => {
    const h = harness({ issuePairingCode: async () => null });
    const run = sshAuthorize([], h.deps);
    const link = await printedLink(h);
    const response = post(link, signed(link));
    await h.asked;
    h.answer(true);
    expect((await response).json).toMatchObject({ ok: true, result: 'added', pairingCode: null });
    expect(await run).toEqual({ exitCode: 0, pairingCode: null });
  });

  it('stops before anything when run as root, without a terminal, without sshd, or with a loose file', async () => {
    const root = harness({ uid: 0 });
    expect((await sshAuthorize([], root.deps)).exitCode).toBe(1);
    const noTty = harness({ interactive: false });
    expect((await sshAuthorize([], noTty.deps)).exitCode).toBe(1);
    const noSshd = harness({ banner: async () => ({ kind: 'refused' }), remoteLoginSetting: true });
    expect((await sshAuthorize([], noSshd.deps)).exitCode).toBe(1);
    expect(noSshd.out.join('\n')).toMatch(/Remote Login|遠端登入/);
    const old = harness({ banner: async () => ({ kind: 'banner', text: 'SSH-2.0-OpenSSH_7.4' }) });
    expect((await sshAuthorize([], old.deps)).exitCode).toBe(1);
    const dropbear = harness({ banner: async () => ({ kind: 'banner', text: 'SSH-2.0-dropbear_2022.83' }) });
    expect((await sshAuthorize([], dropbear.deps)).exitCode).toBe(1);
    mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    writeFileSync(path.join(home, '.ssh', 'authorized_keys'), '', { mode: 0o666 });
    const { chmodSync } = await import('node:fs');
    chmodSync(path.join(home, '.ssh', 'authorized_keys'), 0o666);
    const loose = harness();
    expect((await sshAuthorize([], loose.deps)).exitCode).toBe(1);
    expect(loose.out.join('\n')).toContain(`chmod go-w ${path.join(home, '.ssh', 'authorized_keys')}`);
    expect(readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe('');
  });

  it('stops when sshd reads another authorized keys file', async () => {
    const h = harness();
    writeFileSync(h.deps.sshdConfigPath, 'AuthorizedKeysFile /etc/ssh/keys/%u\n');
    expect((await sshAuthorize([], h.deps)).exitCode).toBe(1);
    writeFileSync(h.deps.sshdConfigPath, 'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2\n');
    expect((await sshAuthorize(['--public-key', PHONE], h.deps)).exitCode).toBe(0);
  });

  it('--public-key writes the same restricted line without a QR code', async () => {
    const h = harness({ interactive: false });
    expect(await sshAuthorize(['--public-key', PHONE], h.deps)).toEqual({ exitCode: 0, pairingCode: null });
    expect(h.file()).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:4792" ${PHONE}\n`);
    expect((await sshAuthorize(['--public-key', 'ssh-dss AAAA'], h.deps)).exitCode).toBe(1);
  });

  it('reads its options', () => {
    expect(parseSshAuthorizeArgs(['--address', 'a', '--address', 'b', '--ssh-port', '2222', '--timeout', '60'])).toEqual({ addresses: ['a', 'b'], sshPort: 2222, timeoutS: 60, publicKey: null });
    expect(() => parseSshAuthorizeArgs(['--yes'])).toThrow();
    expect(() => parseSshAuthorizeArgs(['--timeout', '5'])).toThrow();
    expect(() => parseSshAuthorizeArgs(['--public-key', PHONE, '--address', 'x'])).toThrow();
  });

  it('checks the mac in constant time against the exact key and label', () => {
    const secret = Buffer.alloc(32, 7);
    const good = createHmac('sha256', secret).update(sshAuthorizeMacInput(PHONE, 'x')).digest('base64url');
    expect(macMatches(secret, PHONE, 'x', good)).toBe(true);
    expect(macMatches(secret, PHONE, 'y', good)).toBe(false);
    expect(macMatches(secret, `${PHONE} `, 'x', good)).toBe(false);
    expect(macMatches(secret, PHONE, 'x', `${good}A`)).toBe(false);
  });

  it('checks the app’s request before asking anyone: shape, size, mac, key type; the label made safe', () => {
    const secret = Buffer.alloc(32, 9);
    const mac = (publicKey: string, label: string) => createHmac('sha256', secret).update(sshAuthorizeMacInput(publicKey, label)).digest('base64url');
    const body = (publicKey: string, label: string, given = mac(publicKey, label)) => JSON.stringify({ publicKey, label, mac: given });
    const good = checkAuthorizeRequest(body(PHONE, 'Jen’s phone\nrm -rf'), secret);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.key.fingerprint).toBe(parsePublicKey(PHONE)!.fingerprint);
      expect(good.label).not.toContain('\n');
    }
    expect(checkAuthorizeRequest('not json', secret)).toEqual({ ok: false, status: 400, code: 'bad_request' });
    expect(checkAuthorizeRequest('null', secret)).toEqual({ ok: false, status: 400, code: 'bad_request' });
    expect(checkAuthorizeRequest(JSON.stringify({ publicKey: PHONE, label: 'x' }), secret)).toEqual({ ok: false, status: 400, code: 'bad_request' });
    expect(checkAuthorizeRequest(body(PHONE, 'x'.repeat(257)), secret)).toEqual({ ok: false, status: 400, code: 'bad_request' });
    expect(checkAuthorizeRequest(body(PHONE, 'x', mac(PHONE, 'y')), secret)).toEqual({ ok: false, status: 403, code: 'bad_mac' });
    expect(checkAuthorizeRequest(body('ssh-dss AAAA x', 'x'), secret)).toEqual({ ok: false, status: 400, code: 'key_unsupported' });
  });
});
