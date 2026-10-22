// Stand-in for `claude auth login --claudeai` / `claude auth status --json`,
// with Claude Code 2.1.296's own wording (account-status/claude-login.ts).
// FAKE_LOGIN_MODE: ok (default) | fail (any well-formed code fails) |
// nourl (exits at once) | hang (prints nothing). A code starting with
// "short" is refused the way the CLI refuses one without '#'.
// FAKE_LOGIN_INFO: a file that gets this process's pid, argv and env.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';
import { setInterval, setTimeout } from 'node:timers';

const mode = process.env.FAKE_LOGIN_MODE ?? 'ok';
const args = process.argv.slice(2);
if (process.env.FAKE_LOGIN_INFO) {
  writeFileSync(process.env.FAKE_LOGIN_INFO, JSON.stringify({
    pid: process.pid, args, browser: process.env.BROWSER ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  }));
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: process.env.FAKE_LOGIN_EMAIL ?? 'me@example.com', orgId: 'org-secret-id' }, null, 2)}\n`);
  process.exit(0);
}

if (mode === 'nourl') process.exit(1);
if (mode === 'hang') setInterval(() => undefined, 1000);
else {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc';
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write(`If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`);
  process.stdout.write('Paste code here if prompted > ');
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const [code, state] = line.trim().split('#');
    if (!code || !state || code.startsWith('short')) {
      process.stderr.write('Invalid code. Please make sure the full code was copied.\n');
      return;
    }
    if (mode === 'fail') {
      process.stderr.write(`Login failed: Request failed with status code 400 (secret-${code})\n`);
      process.exit(1);
    }
    setTimeout(() => {
      process.stdout.write('Login successful.\n');
      process.exit(0);
    }, 20);
  });
}
