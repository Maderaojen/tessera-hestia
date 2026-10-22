import type { AccountLoginProtocol } from './types.js';

// `claude auth login --claudeai` driven over pipes, as Claude Code 2.1.296
// does it (read from the CLI's own code and run once against an empty
// config dir; docs/reference/cli-version-alignment.md):
//
//   stdout  "Opening browser to sign in…"
//           "If the browser didn't open, visit: <URL>"   (URL wrapped in an
//                                                          OSC 8 hyperlink)
//           "Paste code here if prompted > "             (no newline)
//   stdin   one line "<code>#<state>"; without both halves the CLI says
//           "Invalid code. Please make sure the full code was copied." on
//           stderr and keeps waiting
//   then    "Login successful." on stdout, exit 0; or "Login failed: …" on
//           stderr, exit 1
//
// The URL is the manual-code one (redirect to platform.claude.com's code
// page, not localhost), so it can be finished on another device.
// `auth status --json` then answers `{ loggedIn, email, … }`.

const URL_LINE = /If the browser didn't open, visit:\s*(\S+)/;
const PROMPT = 'Paste code here if prompted';
// The sign-in page is Anthropic's own; anything else is not followed.
const LOGIN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];

/** The output's visible text: OSC (hyperlinks, titles) and CSI sequences removed. */
export function visibleText(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function isLoginUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && LOGIN_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export const claudeLoginProtocol: AccountLoginProtocol = {
  loginArgs: (email) => ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])],
  statusArgs: ['auth', 'status', '--json'],
  readPrompt(stdout) {
    const text = visibleText(stdout);
    if (!text.includes(PROMPT)) return null;
    const url = URL_LINE.exec(text)?.[1];
    return url && isLoginUrl(url) ? { url } : null;
  },
  // The CLI takes the line trimmed and split at '#': both halves needed.
  codeLooksValid(code) {
    return /^[^\s#]+#[^\s#]+$/.test(code) && code.length <= 4096;
  },
  readOutcome(stdout, stderr) {
    if (/^Login successful\./m.test(stdout)) return 'succeeded';
    if (/^Login failed:/m.test(stderr)) return 'failed';
    if (/^Invalid code\./m.test(stderr)) return 'invalid_code';
    return null;
  },
  readEmail(stdout) {
    try {
      const parsed = JSON.parse(stdout) as { email?: unknown } | null;
      return typeof parsed?.email === 'string' && parsed.email ? parsed.email : null;
    } catch {
      return null;
    }
  },
};
