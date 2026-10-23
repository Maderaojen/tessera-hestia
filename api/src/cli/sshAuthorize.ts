// `hestia ssh-authorize`: adds the phone's SSH key to this account's
// authorized_keys by scanning a QR code (ADR 0040 decision 4).
//
//   hestia ssh-authorize [--address HOST]... [--ssh-port N] [--timeout SECONDS]
//   hestia ssh-authorize --public-key 'ssh-ed25519 AAAA… name'
//
// The phone can only reach this machine over SSH, and its key isn't allowed
// in yet. So the command makes a one-time ed25519 key and allows it in for a
// few minutes, with a line that can only forward to a listener the command
// opens on 127.0.0.1 (not to Hestia's API); the QR code carries that key's
// seed, an HMAC secret, the host key fingerprints and where to connect. The
// app connects with the one-time key, posts its own public key signed with
// the secret, the person checks the fingerprint here and types y, and only
// then is the real, restricted line written. The one-time line is removed
// however the run ends. The answer carries a pairing code, so the app logs
// in to this install in the same go.
//
// There is no --yes: someone who photographs the QR code can send their own
// key, and the person comparing the fingerprint here is what stops them.
import { createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderUnicodeCompact } from 'uqr';
import {
  sshAuthorizeLink,
  sshAuthorizeMacInput,
  type SshAuthorizeErrorCode,
  type SshAuthorizeResponse,
} from '../contract/sshAuthorize.js';
import { APP_WEBVIEW_ORIGINS } from '../config.js';
import { t, type MessageKey } from '../i18n/index.js';
import {
  addOneTimeLine,
  authorizeKey,
  checkSshDir,
  KeyFileError,
  oneTimeComment,
  oneTimeLine,
  parsePublicKey,
  readKeyFile,
  removeOneTimeLine,
  safeComment,
  type KeyFileErrorCode,
  type KeyFiles,
  type PublicKey,
} from './authorizedKeys.js';
import {
  hostKeyFingerprints,
  openSshVersion,
  readsDefaultFile,
  readSshdConfig,
  sshdPort,
  supportsExpiryTime,
  tailscaleAddresses,
  type SshdBanner,
} from './sshdInfo.js';

/** A usage text under the name this install's command goes by (hestia-dev for dev). */
export function usageNamed(usage: string, commandName: string): string {
  return usage.replace(/\bhestia (?=[a-z-])/g, `${commandName} `);
}

export const SSH_AUTHORIZE_USAGE = [
  'usage: hestia ssh-authorize [--address HOST]... [--ssh-port N] [--timeout SECONDS]',
  "       hestia ssh-authorize --public-key 'ssh-ed25519 AAAA… name'",
].join('\n');

const DEFAULT_TIMEOUT_S = 180;

/** CORS for the app's WebView origins (config.ts APP_WEBVIEW_ORIGINS); nothing for a request without an Origin. */
function cors(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  return origin && APP_WEBVIEW_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}
const MAX_ADDRESSES = 4;
const MAX_BODY = 16 * 1024;

/** Everything the command touches outside itself; main.ts gives the real ones, the tests their own. */
export type SshAuthorizeDeps = {
  uid: number;
  username: string;
  home: string;
  files: KeyFiles;
  /** This install's API port and command name, and the scheme its app opens. */
  hestiaPort: number;
  commandName: string;
  scheme: string;
  /** sshd not answering may be macOS's Remote Login being off (host-platform's sshd). */
  remoteLoginSetting: boolean;
  sshdConfigPath: string;
  hostKeyDir: string;
  now: () => Date;
  out: (line: string) => void;
  /** Whether there is a person at a terminal to ask. */
  interactive: boolean;
  /** Asks y/N; false on anything but y, or when `signal` aborts. */
  confirm: (question: string, signal: AbortSignal) => Promise<boolean>;
  banner: (port: number) => Promise<SshdBanner>;
  tailscaleStatus: () => Promise<unknown>;
  localAddresses: () => string[];
  /** A pairing code from this install's API; null when it can't give one. */
  issuePairingCode: () => Promise<string | null>;
  /** Calls `cleanup` on Ctrl-C and the like; returns how to stop listening. */
  onInterrupt: (cleanup: () => void) => () => void;
  /** Where the listener listens; the tests' own. Default 127.0.0.1:0. */
  listen?: { host: string; port: number };
};

export type SshAuthorizeOutcome = { exitCode: number; pairingCode: string | null };

type Options = { addresses: string[]; sshPort: number | null; timeoutS: number; publicKey: string | null };

class UsageError extends Error {}

export function parseSshAuthorizeArgs(args: string[]): Options {
  const options: Options = { addresses: [], sshPort: null, timeoutS: DEFAULT_TIMEOUT_S, publicKey: null };
  const need = (i: number) => {
    const value = args[i];
    if (value === undefined) throw new UsageError(`${args[i - 1]} needs a value`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--address') options.addresses.push(need(++i));
    else if (arg === '--ssh-port') {
      const port = Number(need(++i));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--ssh-port must be a port number');
      options.sshPort = port;
    } else if (arg === '--timeout') {
      const seconds = Number(need(++i));
      if (!Number.isInteger(seconds) || seconds < 30 || seconds > 900) throw new UsageError('--timeout must be 30 to 900 seconds');
      options.timeoutS = seconds;
    } else if (arg === '--public-key') options.publicKey = need(++i);
    else throw new UsageError(`unknown option ${arg}`);
  }
  if (options.publicKey !== null && (options.addresses.length > 0 || options.sshPort !== null)) {
    throw new UsageError('--public-key takes no other options');
  }
  return options;
}

const KEY_FILE_TEXT: Record<KeyFileErrorCode, MessageKey> = {
  ssh_dir_symlink: 'cli.sshAuthorize.file.dirSymlink',
  ssh_dir_not_dir: 'cli.sshAuthorize.file.dirNotDir',
  ssh_dir_owner: 'cli.sshAuthorize.file.dirOwner',
  ssh_dir_mode: 'cli.sshAuthorize.file.dirMode',
  file_symlink: 'cli.sshAuthorize.file.symlink',
  file_not_regular: 'cli.sshAuthorize.file.notRegular',
  file_owner: 'cli.sshAuthorize.file.owner',
  file_mode: 'cli.sshAuthorize.file.mode',
  not_utf8: 'cli.sshAuthorize.file.notUtf8',
  locked: 'cli.sshAuthorize.file.locked',
  changed_while_writing: 'cli.sshAuthorize.file.changed',
  verify_failed: 'cli.sshAuthorize.file.verifyFailed',
};

/** Why a key file stopped the run, in the person's words, with the chmod when there is one. */
function keyFileProblem(error: KeyFileError): string {
  const text = t(KEY_FILE_TEXT[error.code], { path: error.path });
  return error.chmod ? `${text}\n  ${error.chmod}` : text;
}

/** Runs the command; never exits the process itself. */
export async function sshAuthorize(args: string[], deps: SshAuthorizeDeps): Promise<SshAuthorizeOutcome> {
  const failed = (message: string): SshAuthorizeOutcome => {
    deps.out(`hestia: ${message}`);
    return { exitCode: 1, pairingCode: null };
  };
  if (args.includes('--help') || args.includes('-h')) {
    deps.out(usageNamed(SSH_AUTHORIZE_USAGE, deps.commandName));
    return { exitCode: 0, pairingCode: null };
  }
  let options: Options;
  try {
    options = parseSshAuthorizeArgs(args);
  } catch (error) {
    if (error instanceof UsageError) return failed(`${error.message}\n${usageNamed(SSH_AUTHORIZE_USAGE, deps.commandName)}`);
    throw error;
  }
  // The key goes to whoever runs Hestia, never to root's account.
  if (deps.uid === 0) return failed(t('cli.sshAuthorize.root'));
  const config = await readSshdConfig(deps.sshdConfigPath);
  if (!readsDefaultFile(config, deps.home, deps.username)) return failed(t('cli.sshAuthorize.otherKeysFile', { path: deps.sshdConfigPath }));
  if (options.publicKey !== null) return byPublicKey(options.publicKey, deps);
  return byQrCode(options, config, deps);
}

/** --public-key: the person pasted the key themselves; same checks, same line. */
async function byPublicKey(text: string, deps: SshAuthorizeDeps): Promise<SshAuthorizeOutcome> {
  const key = parsePublicKey(text);
  if (!key) return { exitCode: (deps.out(`hestia: ${t('cli.sshAuthorize.keyUnsupported')}`), 1), pairingCode: null };
  const comment = text.trim().split(/\s+/).slice(2).join(' ');
  try {
    const outcome = await authorizeKey(deps.files, key, deps.hestiaPort, comment || 'hestia', deps.now());
    reportOutcome(outcome, key, deps);
    return { exitCode: 0, pairingCode: null };
  } catch (error) {
    if (error instanceof KeyFileError) return { exitCode: (deps.out(`hestia: ${keyFileProblem(error)}`), 1), pairingCode: null };
    throw error;
  }
}

function reportOutcome(outcome: Awaited<ReturnType<typeof authorizeKey>>, key: PublicKey, deps: SshAuthorizeDeps): void {
  const vars = { fingerprint: key.fingerprint, port: deps.hestiaPort };
  if (outcome.result === 'added') deps.out(t('cli.sshAuthorize.added', vars));
  else if (outcome.result === 'merged') deps.out(t('cli.sshAuthorize.merged', vars));
  else {
    deps.out(t(outcome.result === 'present_unrestricted' ? 'cli.sshAuthorize.presentUnrestricted' : 'cli.sshAuthorize.presentOther', vars));
    deps.out(`  ${outcome.suggested}`);
  }
}

async function addresses(options: Options, deps: SshAuthorizeDeps): Promise<string[]> {
  if (options.addresses.length > 0) return options.addresses.slice(0, 8);
  const tailnet = tailscaleAddresses(await deps.tailscaleStatus().catch(() => null));
  return (tailnet.length > 0 ? tailnet : deps.localAddresses()).slice(0, MAX_ADDRESSES);
}

/** The one-time ed25519 key: its 32-byte seed and its public key's base64 wire encoding. */
function oneTimeKey(): { seed: Buffer; publicBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const name = Buffer.from('ssh-ed25519');
  const blob = Buffer.alloc(4 + name.length + 4 + raw.length);
  blob.writeUInt32BE(name.length, 0);
  name.copy(blob, 4);
  blob.writeUInt32BE(raw.length, 4 + name.length);
  raw.copy(blob, 8 + name.length);
  return { seed, publicBase64: blob.toString('base64') };
}

/** The request's mac, checked in constant time. */
export function macMatches(secret: Buffer, publicKey: string, label: string, mac: string): boolean {
  const expected = createHmac('sha256', secret).update(sshAuthorizeMacInput(publicKey, label), 'utf8').digest();
  const given = /^[A-Za-z0-9_-]{43}$/.test(mac) ? Buffer.from(mac, 'base64url') : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function byQrCode(options: Options, config: [string, string][] | null, deps: SshAuthorizeDeps): Promise<SshAuthorizeOutcome> {
  const fail = (message: string): SshAuthorizeOutcome => ({ exitCode: (deps.out(`hestia: ${message}`), 1), pairingCode: null });
  if (!deps.interactive) return fail(t('cli.sshAuthorize.needsTerminal'));
  const sshPort = options.sshPort ?? sshdPort(config);
  const banner = await deps.banner(sshPort);
  if (banner.kind !== 'banner') {
    const hint = deps.remoteLoginSetting ? `\n  ${t('cli.sshAuthorize.remoteLoginHint')}` : '';
    return fail(t('cli.sshAuthorize.sshdUnreachable', { port: sshPort }) + hint);
  }
  const version = openSshVersion(banner.text);
  if (!version || !supportsExpiryTime(version)) return fail(t('cli.sshAuthorize.sshdTooOld', { banner: banner.text }));
  const fingerprints = await hostKeyFingerprints(deps.hostKeyDir);
  if (fingerprints.length === 0) return fail(t('cli.sshAuthorize.noHostKeys', { dir: deps.hostKeyDir }));
  const reach = await addresses(options, deps);
  if (reach.length === 0) return fail(t('cli.sshAuthorize.noAddress'));
  // A file the run would stop at is said now, before a QR code is shown.
  try {
    await checkSshDir(deps.files);
    await readKeyFile(deps.files);
  } catch (error) {
    if (error instanceof KeyFileError) return fail(keyFileProblem(error));
    throw error;
  }

  const { seed, publicBase64 } = oneTimeKey();
  const secret = randomBytes(32);
  const comment = oneTimeComment();
  const started = deps.now();
  const expires = new Date(started.getTime() + options.timeoutS * 1000);

  // How the run ends: settled once, by the app's request, the timeout or Ctrl-C.
  let settle!: (result: { kind: 'done'; pairingCode: string | null } | { kind: 'declined' | 'expired' | 'interrupted' | 'error' }) => void;
  const finished = new Promise<Parameters<typeof settle>[0]>((resolve) => { settle = resolve; });
  let state: 'waiting' | 'confirming' | 'over' = 'waiting';
  const abort = new AbortController();

  const respond = (res: http.ServerResponse, status: number, body: SshAuthorizeResponse) => {
    res.writeHead(status, { ...cors(res.req), 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: http.ServerResponse, status: number, code: SshAuthorizeErrorCode) => respond(res, status, { ok: false, code });

  const server = http.createServer((req, res) => {
    // The app's WebView fetches from its own origin; a page in a browser on this machine is turned away.
    const origin = req.headers.origin;
    if (origin !== undefined && !APP_WEBVIEW_ORIGINS.includes(origin)) return refuse(res, 403, 'bad_request');
    if (req.method === 'OPTIONS' && req.url === '/') {
      res.writeHead(204, { ...cors(req), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method !== 'POST' || req.url !== '/') return refuse(res, 404, 'bad_request');
    if (state !== 'waiting') return refuse(res, 409, 'busy');
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => void handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, text: string) => {
    if (state !== 'waiting') return refuse(res, 409, 'busy');
    let body: { publicKey?: unknown; label?: unknown; mac?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return refuse(res, 400, 'bad_request');
    }
    if (typeof body?.publicKey !== 'string' || typeof body.label !== 'string' || typeof body.mac !== 'string' || body.label.length > 256 || body.publicKey.length > 8192) {
      return refuse(res, 400, 'bad_request');
    }
    if (!macMatches(secret, body.publicKey, body.label, body.mac)) return refuse(res, 403, 'bad_mac');
    const key = parsePublicKey(body.publicKey);
    if (!key) return refuse(res, 400, 'key_unsupported');
    // The first request that passes is the one; any other is turned away from here on.
    state = 'confirming';
    const label = safeComment(body.label);
    // The app giving up (its connection gone) ends the question too.
    const gone = () => abort.abort();
    res.on('close', gone);
    deps.out('');
    deps.out(t('cli.sshAuthorize.received', { fingerprint: key.fingerprint, label }));
    const yes = await deps.confirm(t('cli.sshAuthorize.confirm', { user: deps.username, port: deps.hestiaPort }), abort.signal);
    if (!yes || abort.signal.aborted) {
      res.off('close', gone);
      if (!res.writableEnded) refuse(res, 200, 'declined');
      deps.out(t('cli.sshAuthorize.declined'));
      state = 'over';
      return settle({ kind: abort.signal.aborted ? 'interrupted' : 'declined' });
    }
    try {
      const outcome = await authorizeKey(deps.files, key, deps.hestiaPort, label, deps.now());
      reportOutcome(outcome, key, deps);
      const pairingCode = await deps.issuePairingCode().catch(() => null);
      if (pairingCode === null) deps.out(t('cli.sshAuthorize.noPairingCode'));
      respond(res, 200, {
        ok: true,
        result: outcome.result,
        pairingCode,
        port: deps.hestiaPort,
        name: deps.commandName,
        ...(outcome.result === 'present_unrestricted' || outcome.result === 'present_other' ? { suggestedLine: outcome.suggested } : {}),
      });
      state = 'over';
      settle({ kind: 'done', pairingCode });
    } catch (error) {
      refuse(res, 500, 'write_failed');
      deps.out(`hestia: ${error instanceof KeyFileError ? keyFileProblem(error) : String(error)}`);
      state = 'over';
      settle({ kind: 'error' });
    }
  };

  const where = deps.listen ?? { host: '127.0.0.1', port: 0 };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(where.port, where.host, () => resolve());
  });
  const listenerPort = (server.address() as AddressInfo).port;
  const stopInterrupt = deps.onInterrupt(() => {
    abort.abort();
    state = 'over';
    settle({ kind: 'interrupted' });
  });
  let added = false;
  try {
    try {
      await addOneTimeLine(deps.files, oneTimeLine(publicBase64, listenerPort, expires, comment), started);
      added = true;
    } catch (error) {
      if (error instanceof KeyFileError) return fail(keyFileProblem(error));
      throw error;
    }
    const link = sshAuthorizeLink({
      version: 1,
      username: deps.username,
      addresses: reach,
      sshPort,
      hostKeyFingerprints: fingerprints,
      ed25519Seed: seed.toString('base64url'),
      listenerPort,
      secret: secret.toString('base64url'),
      commandName: deps.commandName,
      hestiaPort: deps.hestiaPort,
    }, deps.scheme);
    seed.fill(0);
    printQr(link, fingerprints, options.timeoutS, deps);
    // Only while waiting: a person answering the question isn't cut off.
    const timer = setTimeout(() => {
      if (state !== 'waiting') return;
      state = 'over';
      settle({ kind: 'expired' });
    }, options.timeoutS * 1000);
    const result = await finished;
    clearTimeout(timer);
    if (result.kind === 'expired') deps.out(t('cli.sshAuthorize.expired'));
    if (result.kind === 'interrupted') deps.out(t('cli.sshAuthorize.interrupted'));
    return result.kind === 'done' ? { exitCode: 0, pairingCode: result.pairingCode } : { exitCode: 1, pairingCode: null };
  } finally {
    stopInterrupt();
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    secret.fill(0);
    if (added) {
      await removeOneTimeLine(deps.files, comment, deps.now()).catch((error: unknown) => {
        deps.out(`hestia: ${error instanceof KeyFileError ? keyFileProblem(error) : String(error)}`);
        deps.out(t('cli.sshAuthorize.cleanupFailed', { comment }));
      });
    }
  }
}

function printQr(link: string, fingerprints: string[], timeoutS: number, deps: SshAuthorizeDeps): void {
  // White on black, as `hestia pair` draws it (see main.ts).
  const qr = renderUnicodeCompact(link, { border: 2 }).split('\n').map((line) => `  \x1b[97;40m${line}\x1b[0m`);
  deps.out([
    '',
    `  ${t('cli.sshAuthorize.scan')}`,
    '',
    ...qr,
    '',
    `  ${t('cli.sshAuthorize.link')}${link}`,
    `  ${t('cli.sshAuthorize.hostKeys')}${fingerprints.join(', ')}`,
    `  ${t('cli.sshAuthorize.validFor', { minutes: Math.round(timeoutS / 60) })}`,
    `  ${t('cli.sshAuthorize.secret')}`,
    '',
    `  ${t('cli.sshAuthorize.waiting')}`,
  ].join('\n'));
}
