// `hestia connect`: one QR code a phone scans to connect to this computer,
// whichever way it can reach it.
//
//   hestia connect [--url BACKEND_URL] [--address HOST]... [--ssh-port N] [--no-ssh] [--link app|web|both] [--no-wait]
//
// The code carries both halves when it can (contract/connect.ts): the URL
// half (this backend's address and a one-use pairing code, as `hestia pair`)
// and the SSH half (`hestia ssh-authorize`'s one-time key and listener). The
// app tries the URL first and falls back to SSH. A half that can't be
// offered is left out with one line saying why; with neither, it fails.
//
// One QR code lets one phone in: once the pairing code is used, the SSH half
// closes; once a request comes in over SSH, the pairing code is taken back
// (the phone gets a new one after the y here). It ends with one line: which
// device connected, and the chance to take that login back.
import { connectAppLink, webPairingLink, type ConnectLink, type PairingLinkKind } from '../contract/index.js';
import { t } from '../i18n/index.js';
import { pairBackendUrl, pairLinkKinds } from './pairLink.js';
import { openAuthorizeSession, sshPreflight, type AuthorizeResult, type AuthorizeSession, type SshAuthorizeDeps } from './sshAuthorize.js';
import { terminalQr } from './terminalQr.js';
import { usageNamed } from './usage.js';

export const CONNECT_USAGE = 'usage: hestia connect [--url BACKEND_URL] [--address HOST]... [--ssh-port N] [--no-ssh] [--link app|web|both] [--no-wait]';

// A combined QR code stays within an 80-column terminal with two addresses
// and two host keys (version 13; the plan's §6.2).
const MAX_ADDRESSES = 2;
const MAX_HOST_KEYS = 2;
const LINK_LIMIT = 440;

export type PairingCodeStatus =
  | { status: 'pending'; expiresInMs: number }
  | { status: 'used'; usedAt: number; device: string | null }
  | { status: 'expired' };

/** ssh-authorize's world, plus the API calls and the terminal the URL half needs. */
export type ConnectDeps = SshAuthorizeDeps & {
  /** The backend address from the environment (HESTIA_PUBLIC_URL) and the link kind (HESTIA_PAIR_LINK). */
  envUrl: string | undefined;
  envLinkKind: string | undefined;
  frontendOrigin: string;
  /** This computer's name, as the phone and the last line say it. */
  hostName: string;
  /** A new pairing code; null when the API can't be reached. */
  newPairingCode: () => Promise<{ code: string; expiresInMs: number } | null>;
  pairingStatus: (code: string) => Promise<PairingCodeStatus | null>;
  cancelPairingCode: (code: string) => Promise<void>;
  revokePairing: (code: string) => Promise<boolean>;
  /** One line that rewrites itself (the countdown); '' clears it. */
  status: (line: string) => void;
  /** Asks a question and returns the answer ('' on Enter, Ctrl-D or after `timeoutMs`). */
  ask: (question: string, timeoutMs: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** The terminal's width, when there is one. */
  columns: number | undefined;
};

type Options = { url: string | null; addresses: string[]; sshPort: number | null; ssh: boolean; kinds: PairingLinkKind[]; wait: boolean };

class UsageError extends Error {}

export function parseConnectArgs(args: string[], env: { url: string | undefined; linkKind: string | undefined }): Options {
  const options: Options = { url: env.url ?? null, addresses: [], sshPort: null, ssh: true, kinds: ['app'], wait: true };
  let linkChoice = env.linkKind;
  const need = (i: number) => {
    const value = args[i];
    if (value === undefined) throw new UsageError(`${args[i - 1]} needs a value`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--url') options.url = need(++i);
    else if (arg === '--address') options.addresses.push(need(++i));
    else if (arg === '--ssh-port') {
      const port = Number(need(++i));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--ssh-port must be a port number');
      options.sshPort = port;
    } else if (arg === '--no-ssh') options.ssh = false;
    else if (arg === '--link') linkChoice = need(++i);
    else if (arg === '--no-wait') options.wait = false;
    else throw new UsageError(`unknown option ${arg}`);
  }
  const kinds = pairLinkKinds(linkChoice);
  if (!kinds) throw new UsageError(`--link must be web, app or both (got ${JSON.stringify(linkChoice)})`);
  options.kinds = kinds;
  return options;
}

/** How many columns the drawn QR code takes (its widest line, colours left out). */
function qrWidth(lines: string[]): number {
  return Math.max(0, ...lines.map((line) => [...line.replace(/\x1b\[[0-9;]*m/g, '')].length));
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Runs the command; never exits the process itself. 0 once a phone connected. */
export async function connect(args: string[], deps: ConnectDeps): Promise<number> {
  const usage = usageNamed(CONNECT_USAGE, deps.commandName);
  if (args.includes('--help') || args.includes('-h')) {
    deps.out(usage);
    return 0;
  }
  let options: Options;
  try {
    options = parseConnectArgs(args, { url: deps.envUrl, linkKind: deps.envLinkKind });
  } catch (error) {
    if (error instanceof UsageError) {
      deps.out(`hestia: ${error.message}\n${usage}`);
      return 1;
    }
    throw error;
  }

  // The URL half: this backend's address and a pairing code.
  let urlHalf: { backendUrl: string; code: string } | null = null;
  let urlProblem: string | null = null;
  const backendUrl = options.url ? pairBackendUrl(options.url) : null;
  if (!options.url) urlProblem = t('cli.connect.noUrl');
  else if (!backendUrl) urlProblem = t('cli.connect.badUrl', { url: options.url });
  else {
    const issued = await deps.newPairingCode();
    if (issued) urlHalf = { backendUrl, code: issued.code };
    else urlProblem = t('cli.connect.noApi');
  }

  // The SSH half: only with a person here to say y, and a listener that lives on.
  let session: AuthorizeSession | null = null;
  let sshProblem: string | null = null;
  // A request over SSH takes the URL half's code back: one QR code, one phone.
  let cameOverSsh = false;
  if (!options.ssh) { /* --no-ssh: the URL half alone, nothing said */ }
  else if (!options.wait) sshProblem = t('cli.connect.sshNoWait');
  else {
    const pre = await sshPreflight({ addresses: options.addresses, sshPort: options.sshPort }, deps, MAX_ADDRESSES);
    if (!pre.ok) sshProblem = pre.problem;
    else {
      const ready = { ...pre.ready, fingerprints: pre.ready.fingerprints.slice(0, MAX_HOST_KEYS) };
      const opened = await openAuthorizeSession(ready, 180, deps, {
        received: () => {
          cameOverSsh = true;
          deps.status('');
          if (urlHalf) void deps.cancelPairingCode(urlHalf.code).catch(() => {});
        },
      });
      if ('problem' in opened) sshProblem = opened.problem;
      else session = opened;
    }
  }

  try {
    if (!urlHalf && !session) {
      deps.out(`hestia: ${t('cli.connect.noRoute')}`);
      if (urlProblem) deps.out(`  ${t('cli.connect.urlProblem', { reason: urlProblem })}`);
      if (sshProblem) deps.out(`  ${t('cli.connect.sshProblem', { reason: sshProblem })}`);
      return 1;
    }

    let link = connectAppLink({ url: urlHalf, ssh: session?.link ?? null } satisfies ConnectLink, deps.scheme);
    // Two host keys and two addresses fit; a long DNS name can still push it over.
    if (session && link.length > LINK_LIMIT && session.link.addresses.length > 1) {
      session.link.addresses = session.link.addresses.slice(0, 1);
      link = connectAppLink({ url: urlHalf, ssh: session.link }, deps.scheme);
    }
    const webLink = urlHalf ? webPairingLink(deps.frontendOrigin, urlHalf.backendUrl, urlHalf.code) : null;
    // The QR code holds the first kind asked for; the web link only ever has the URL half.
    const qrLink = options.kinds[0] === 'web' && webLink ? webLink : link;
    const qr = terminalQr(qrLink, { color: deps.interactive });
    const routes = [
      urlHalf ? t('cli.connect.viaUrl', { url: urlHalf.backendUrl }) : null,
      session ? t('cli.connect.viaSsh') : null,
    ].filter(Boolean).join(t('cli.connect.routeSeparator'));
    deps.out([
      '',
      `  ${t('cli.connect.scan')}`,
      '',
      ...qr,
      '',
      `  ${t('cli.connect.routes', { host: deps.hostName, routes })}`,
      `  ${t('cli.connect.validFor')}`,
      ...(options.kinds.includes('app') || !webLink ? [`  ${t('cli.connect.orPaste')}${link}`] : []),
      ...(options.kinds.includes('web') && webLink ? [`  ${t('cli.connect.orBrowser')}${webLink}`] : []),
      ...(options.ssh && sshProblem ? [`  ${t('cli.connect.sshSkipped', { reason: sshProblem.split('\n')[0]! })}`] : []),
      ...(urlProblem ? [`  ${t('cli.connect.urlSkipped', { reason: urlProblem })}`] : []),
      ...(deps.columns !== undefined && deps.columns < qrWidth(qr) ? [`  ${t('cli.connect.narrow')}`] : []),
    ].join('\n'));

    if (!options.wait || !deps.interactive) return 0;
    deps.out('');
    return await waitForPhone(urlHalf?.code ?? null, session, () => cameOverSsh, deps);
  } finally {
    session?.close();
    await session?.cleanup();
  }
}

/** Until a phone comes in by either half (or time is up), then the one line, and the chance to take it back. */
async function waitForPhone(code: string | null, session: AuthorizeSession | null, cameOverSsh: () => boolean, deps: ConnectDeps): Promise<number> {
  let sessionResult: AuthorizeResult | null = null;
  void session?.finished.then((result) => { sessionResult = result; });
  const deadline = deps.now().getTime() + 180_000;
  // Waiting on the QR code's pairing code, and the SSH half at the same time.
  while (!cameOverSsh()) {
    if (code) {
      const state = await deps.pairingStatus(code);
      if (state?.status === 'used') {
        deps.status('');
        return finish(code, state.device, deps);
      }
      if (state?.status === 'expired' && !cameOverSsh()) break;
      if (state?.status === 'pending') deps.status(t('cli.connect.waiting', { left: clock(state.expiresInMs) }));
    } else {
      deps.status(t('cli.connect.waiting', { left: clock(deadline - deps.now().getTime()) }));
    }
    if (sessionResult || (!code && deps.now().getTime() >= deadline)) break;
    await deps.sleep(1000);
  }
  deps.status('');
  if (!cameOverSsh()) {
    deps.out(`  ${t('cli.connect.expired', { command: deps.commandName })}`);
    return 1;
  }
  // Over SSH: the question was asked here; the phone was given a new code with the answer.
  const result = await session!.finished;
  if (result.kind !== 'done') {
    if (result.kind === 'interrupted') deps.out(t('cli.sshAuthorize.interrupted'));
    return 1;
  }
  if (!result.pairingCode) return 0;
  for (;;) {
    const state = await deps.pairingStatus(result.pairingCode);
    if (state?.status === 'used') return finish(result.pairingCode, state.device, deps);
    if (!state || state.status === 'expired') {
      deps.out(`  ${t('cli.connect.expired', { command: deps.commandName })}`);
      return 1;
    }
    await deps.sleep(1000);
  }
}

/** The one line, and a minute to take that login back (someone else scanned it). */
async function finish(code: string, device: string | null, deps: ConnectDeps): Promise<number> {
  deps.out(`  ${t('cli.connect.connected', { device: device ?? t('cli.pair.unknownDevice'), host: deps.hostName })}`);
  const answer = await deps.ask(`  ${t('cli.connect.revokeAsk')}`, 60_000).catch(() => '');
  if (answer.trim().toLowerCase() !== 'r') return 0;
  const revoked = await deps.revokePairing(code).catch(() => false);
  deps.out(`  ${revoked ? t('cli.connect.revoked') : t('cli.pair.revokeMissing')}`);
  return 0;
}
