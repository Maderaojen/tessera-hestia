#!/usr/bin/env node
// hestia — the app's command for this machine's terminal.
//
//   hestia open [dir] [--claude|--codex|--gemini|--agy] [--project NAME] [--no-attach]
//   hestia pair [--url BACKEND_URL] [--link web|app|both] [--no-wait]
//   hestia delegate (start|stop|done|review|status) …   (see delegate.ts)
//   hestia conversation show …                           (see conversation.ts)
//   hestia ssh-authorize [--address HOST]… [--public-key KEY] (see sshAuthorize.ts)
//
// Opens a tmux for the project the directory (default: here) belongs to,
// registered with the app so it shows up on the phone too, and attaches to
// it. The project is the one whose path is closest to the directory; with
// none, a new one is made (named after the folder unless --project says
// otherwise), asking first when there's a terminal to ask in. A CLI flag
// has the app start that CLI in it — started by hand inside the tmux
// instead, the app can't follow its conversation.
//
// `pair` shows a QR code (and the link in it) that logs a phone in to this
// backend without typing the password: the app's add-host form with this
// backend's address and a one-use pairing code good for three minutes (see
// auth.ts's issuePairingCode). In a terminal it then waits for the code to
// be used and says which device used it, offering to take that login back
// (--no-wait just prints and exits). The address is --url, else
// HESTIA_PUBLIC_URL from the API's .env (scripts/install.sh writes
// it once Tailscale serves the API), checked like the frontend's add-host
// form checks it (pairLink.ts pairBackendUrl). --link (default HESTIA_PAIR_LINK, else
// app) picks the web frontend's link, the native app's hestia:// deep link,
// or both; the QR code holds the first (contract/pairing.ts).
//
// It talks to the API on this machine (HOST/PORT from the API's .env) with
// the token the API writes at
// start (see auth.ts's issueLocalToolToken).
import { execFile, spawnSync } from 'node:child_process';
import os from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { renderUnicodeCompact } from 'uqr';
import { appLinkScheme, COMMAND_NAME, DEFAULT_FRONTEND_ORIGIN, HOST, LOCAL_TOOL_TOKEN_PATH, localApiOrigin, PORT } from '../config.js';
import { hostPlatform } from '../host-platform/index.js';
import { attachCommand } from './attach.js';
import { CONVERSATION_USAGE, conversationCommand } from './conversation.js';
import { defaultTmuxName, DELEGATE_USAGE, delegateCommand, fileReader } from './delegate.js';
import { frontendOrigin, pairBackendUrl, pairingLinks, pairLinkKinds, phoneReachHint } from './pairLink.js';
import { projectsForDirectory } from './projectMatch.js';
import { SSH_AUTHORIZE_USAGE, sshAuthorize, usageNamed } from './sshAuthorize.js';
import { localAddresses, readSshdBanner } from './sshdInfo.js';
import { currentLocale, localeFromEnv, setDefaultLocale, t } from '../i18n/index.js';

// The command speaks the terminal's language (HESTIA_LOCALE, else LANG…),
// and asks the API to answer in it too.
setDefaultLocale(localeFromEnv());

type Project = { id: string; name: string; paths: { path: string; primary: boolean }[] };
type Session = { id: string; tmuxName: string; tmuxSocket?: string | null };

const CLI_FLAGS: Record<string, string> = {
  '--claude': 'native:claude',
  '--codex': 'native:codex',
  '--gemini': 'native:gemini',
  '--agy': 'native:agy',
};

const USAGE = usageNamed([
  'usage: hestia open [dir] [--claude|--codex|--gemini|--agy] [--project NAME] [--no-attach]',
  '       hestia pair [--url BACKEND_URL] [--link web|app|both] [--no-wait]',
  DELEGATE_USAGE.replace('usage: ', '       '),
  CONVERSATION_USAGE.replace('usage: ', '       '),
  ...SSH_AUTHORIZE_USAGE.split('\n').map((line) => line.replace(/^(usage: | {7})/, '       ')),
].join('\n'), COMMAND_NAME);

function fail(message: string): never {
  console.error(`hestia: ${message}`);
  process.exit(1);
}

const API_ORIGIN = localApiOrigin(HOST, PORT);

async function api<T>(token: string, route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_ORIGIN}/api${route}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Hestia-Token': token, 'Accept-Language': currentLocale() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => fail(`can't reach the API at ${API_ORIGIN} — is it running?`));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    // The code too, so an LLM running `hestia delegate` can tell why (limit_reached, quota_too_low…).
    const text = body.error ?? `${res.status} ${res.statusText}`;
    fail(body.code && !['internal_error'].includes(body.code) ? `${body.code}: ${text}` : text);
  }
  return (await res.json()) as T;
}

async function localToolToken(): Promise<string> {
  return (await readFile(LOCAL_TOOL_TOKEN_PATH, 'utf8').catch(() => fail(`no token at ${LOCAL_TOOL_TOKEN_PATH} — is the API running?`))).trim();
}

// Colors only for a terminal, and never with NO_COLOR (https://no-color.org).
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');

type PairingStatus =
  | { status: 'pending'; expiresInMs: number }
  | { status: 'used'; usedAt: number; device: string | null }
  | { status: 'expired' };

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Until the code is used or expires, the countdown on one line; then who
// used it, and the chance to take that login back.
async function waitForPairing(token: string, code: string): Promise<void> {
  const status = () => api<PairingStatus>(token, '/auth/pairing-code/status', { method: 'POST', body: { code } });
  let state = await status();
  while (state.status === 'pending') {
    process.stdout.write(`\r\x1b[2K  ${dim(t('cli.pair.waiting', { left: clock(state.expiresInMs) }))}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await status();
  }
  process.stdout.write('\r\x1b[2K');
  if (state.status === 'expired') {
    console.log(`  ${yellow(t('cli.pair.expired'))}${t('cli.pair.expiredAgain')}`);
    return;
  }
  const at = new Date(state.usedAt).toLocaleTimeString(currentLocale(), { hour12: false });
  console.log(`  ${green(t('cli.pair.paired'))}${t('cli.pair.pairedDevice', { device: bold(state.device ?? t('cli.pair.unknownDevice')), at })}`);
  if (!process.stdin.isTTY) return;
  // Ctrl-D at the prompt is the same as Enter.
  const answer = await ask(`  ${dim(t('cli.pair.revokeAsk'))}`).catch(() => '');
  if (answer.toLowerCase() !== 'r') return;
  const { revoked } = await api<{ revoked: boolean }>(token, '/auth/pairing-code/revoke', { method: 'POST', body: { code } });
  console.log(revoked ? `  ${green(t('cli.pair.revoked'))}${t('cli.pair.revokedDetail')}` : `  ${yellow(t('cli.pair.revokeMissing'))}`);
}

async function pair(args: string[]): Promise<void> {
  let url = process.env.HESTIA_PUBLIC_URL;
  let urlSource = t('cli.pair.urlFromEnv');
  let linkChoice = process.env.HESTIA_PAIR_LINK;
  let linkSource = 'HESTIA_PAIR_LINK';
  let wait = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') { url = args[++i] ?? fail('--url needs an address'); urlSource = '--url'; }
    else if (args[i] === '--link') { linkChoice = args[++i] ?? fail('--link needs web, app or both'); linkSource = '--link'; }
    else if (args[i] === '--no-wait') wait = false;
    else fail(`unknown option ${args[i]}\n${USAGE}`);
  }
  const kinds = pairLinkKinds(linkChoice) ?? fail(`${linkSource} must be web, app or both (got ${JSON.stringify(linkChoice)})`);
  if (!url) fail(t('cli.pair.noUrl'));
  const backendUrl = pairBackendUrl(url)
    ?? fail(t('cli.pair.badUrl', { source: urlSource, url }));
  const token = await localToolToken();
  const { code, expiresInMs } = await api<{ code: string; expiresInMs: number }>(token, '/auth/pairing-code', { method: 'POST' });
  const links = pairingLinks(kinds, frontendOrigin(process.env.CORS_ALLOWED_ORIGINS, DEFAULT_FRONTEND_ORIGIN), backendUrl, code, appLinkScheme(process.env));
  const link = links[0]!.link;
  // White modules on black, set explicitly: the compact renderer draws the
  // light parts, so on a light-themed terminal it would come out inverted,
  // which many phone cameras won't read. Only for a terminal: in a file the
  // escapes would be noise.
  const qr = renderUnicodeCompact(link, { border: 2 }).split('\n').map((line) => (process.stdout.isTTY ? `  \x1b[97;40m${line}\x1b[0m` : line));
  const minutes = Math.round(expiresInMs / 60_000);
  console.log([
    `${t('cli.pair.backend')}${cyan(backendUrl)}${dim(t('cli.pair.backendSource', { source: urlSource }))}`,
    '',
    bold(t('cli.pair.scan')),
    '',
    ...qr,
    '',
    ...links.map((each) => `${dim(t(each.kind === 'app' ? 'cli.pair.openInApp' : 'cli.pair.openInBrowser'))}${cyan(each.link)}`),
    '',
    dim(t('format.text.bullet', { text: phoneReachHint(backendUrl) })),
    dim(t('cli.pair.validFor', { minutes })),
    dim(t('cli.pair.secret')),
    dim(t('cli.pair.ssh')),
  ].map((line) => (line ? `  ${line}` : line)).join('\n'));
  if (wait && process.stdout.isTTY) {
    console.log('');
    await waitForPairing(token, code);
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Where the new tmux goes: a project id, or a name to find or create.
async function chooseProject(projects: Project[], directory: string, named: string | null): Promise<{ projectId: string } | { projectName: string }> {
  if (named) return { projectName: named };
  const matches = projectsForDirectory(projects, directory);
  if (matches.length === 1) return { projectId: matches[0]!.id };
  const folderName = path.basename(directory);
  if (!process.stdin.isTTY) {
    if (matches.length > 1) fail(`more than one project has this path (${matches.map((p) => p.name).join(', ')}); pick one with --project`);
    return { projectName: folderName };
  }
  if (matches.length > 1) {
    console.log(t('cli.open.manyProjects'));
    matches.forEach((project, index) => console.log(`  ${index + 1}. ${project.name}`));
    const picked = Number(await ask(t('cli.open.pick')));
    const project = matches[picked - 1];
    if (!project) fail('no such choice');
    return { projectId: project.id };
  }
  const answer = await ask(t('cli.open.newProject', { folder: folderName }));
  return { projectName: answer || folderName };
}

async function open(args: string[]): Promise<void> {
  let dir: string | null = null;
  let profileId: string | null = null;
  let named: string | null = null;
  let attach = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg in CLI_FLAGS) profileId = CLI_FLAGS[arg]!;
    else if (arg === '--project') named = args[++i] ?? fail('--project needs a name');
    else if (arg === '--no-attach') attach = false;
    else if (arg.startsWith('-')) fail(`unknown option ${arg}\n${USAGE}`);
    else dir = arg;
  }
  const directory = await realpath(path.resolve(dir ?? process.cwd())).catch(() => fail(`no such directory: ${dir}`));
  const token = await localToolToken();

  const { projects } = await api<{ projects: Project[] }>(token, '/projects');
  const target = await chooseProject(projects, directory, named);
  const session = await api<Session>(token, '/sessions', { method: 'POST', body: { cwd: directory, ...target } });
  if (profileId) await api(token, `/sessions/${session.id}/launch`, { method: 'POST', body: { profileId } });

  const projectName = 'projectName' in target ? target.projectName : projects.find((p) => p.id === target.projectId)?.name;
  console.log(t('cli.open.opened', { tmux: session.tmuxName, project: projectName }));
  if (!attach) return;
  const { command, env } = attachCommand(session, process.env);
  process.exit(spawnSync('tmux', command, { stdio: 'inherit', env }).status ?? 0);
}

// The machine's Tailscale status, for the addresses ssh-authorize offers; null without Tailscale.
function tailscaleStatus(): Promise<unknown> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

// Ctrl-C at the y/N question: the same as Ctrl-C anywhere else in the run.
async function confirm(question: string, signal: AbortSignal): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'));
  try {
    return (await rl.question(question, { signal })).trim().toLowerCase() === 'y';
  } catch {
    process.stdout.write('\n');
    return false;
  } finally {
    rl.close();
  }
}

async function sshAuthorizeCommand(args: string[]): Promise<void> {
  const user = os.userInfo();
  const files = { sshDir: path.join(user.homedir, '.ssh'), uid: user.uid };
  let token: string | null = null;
  const outcome = await sshAuthorize(args, {
    uid: process.getuid?.() ?? user.uid,
    username: user.username,
    home: user.homedir,
    files,
    hestiaPort: PORT,
    commandName: COMMAND_NAME,
    scheme: appLinkScheme(process.env),
    remoteLoginSetting: hostPlatform().sshd.remoteLoginSetting,
    sshdConfigPath: '/etc/ssh/sshd_config',
    hostKeyDir: '/etc/ssh',
    now: () => new Date(),
    out: (line) => console.log(line),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm,
    banner: (port) => readSshdBanner(port),
    tailscaleStatus,
    localAddresses: () => localAddresses(),
    issuePairingCode: async () => {
      token = (await readFile(LOCAL_TOOL_TOKEN_PATH, 'utf8').catch(() => '')).trim() || null;
      if (!token) return null;
      const res = await fetch(`${API_ORIGIN}/api/auth/pairing-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hestia-Token': token, 'Accept-Language': currentLocale() },
      }).catch(() => null);
      if (!res?.ok) return null;
      return ((await res.json()) as { code?: string }).code ?? null;
    },
    onInterrupt: (cleanup) => {
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signals) process.on(signal, cleanup);
      return () => { for (const signal of signals) process.off(signal, cleanup); };
    },
  });
  // Then like `hestia pair`: who used the code, and the chance to take it back.
  if (outcome.pairingCode && token && process.stdout.isTTY) {
    console.log('');
    await waitForPairing(token, outcome.pairingCode);
  }
  process.exit(outcome.exitCode);
}

const [command, ...rest] = process.argv.slice(2);
if (command === '--help' || command === '-h' || command === 'help') console.log(USAGE);
else if (command === 'open') await open(rest);
else if (command === 'pair') await pair(rest);
else if (command === 'ssh-authorize') await sshAuthorizeCommand(rest);
else if (command === 'delegate') {
  const token = await localToolToken();
  await delegateCommand(rest, {
    api: (route, init) => api(token, route, init),
    fail,
    env: process.env,
    tmuxName: () => defaultTmuxName(process.env),
    readFile: fileReader,
    log: (line) => console.log(line),
  });
} else if (command === 'conversation') {
  const token = await localToolToken();
  await conversationCommand(rest, {
    api: (route, init) => api(token, route, init),
    fail,
    env: process.env,
    tmuxName: () => defaultTmuxName(process.env),
    now: () => new Date(),
    log: (text) => console.log(text),
  });
} else fail(USAGE);
