// Interactive setup for the login credentials in .env. Run via
// `npm run set-credentials`, which runs the built copy (dist/scripts/), so
// it works in a release bundle too, where dev dependencies aren't
// installed. The plaintext password only ever exists in
// memory for the duration of this process — it's hashed (scrypt) before
// anything touches disk, so .env never holds a readable password.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';
import { writeEnv } from './env-file.js';
import { hostPlatform } from '../src/host-platform/index.js';
import { localeFromEnv, setDefaultLocale, t } from '../src/i18n/index.js';

// In the terminal's language, like the hestia command.
setDefaultLocale(localeFromEnv());

// api/.env (a link into the state folder once installed), from either
// scripts/ or dist/scripts/.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.basename(path.dirname(scriptDir)) === 'dist' ? path.join(scriptDir, '..', '..') : path.join(scriptDir, '..');
const envPath = path.join(apiDir, '.env');

// Hand-rolled line reader (not readline) so one prompt can mask its input
// while another doesn't, using a single shared stdin listener for the
// process's whole lifetime. A single write to a piped/redirected stdin can
// deliver several lines in one 'data' event; a naive per-prompt listener
// that detaches after its own '\n' silently drops everything after it,
// hanging the next prompt forever. Buffering unconsumed chars in
// `overflow` and draining it at the start of each new prompt avoids that.
class LineReader {
  private overflow = '';
  private line = '';
  private waiting: { resolve: (v: string) => void; reject: (e: Error) => void; mask: boolean } | null = null;
  private readonly wasRaw: boolean;

  constructor() {
    this.wasRaw = Boolean(process.stdin.isRaw);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', (chunk: string) => {
      for (const char of chunk) {
        if (this.waiting) this.consumeChar(char);
        else this.overflow += char;
      }
    });
  }

  private consumeChar(char: string): void {
    const w = this.waiting;
    if (!w) return;
    if (char === '\n' || char === '\r') {
      const result = this.line;
      this.line = '';
      this.waiting = null;
      process.stdout.write('\n');
      w.resolve(result);
      return;
    }
    if (char === '') {
      // Ctrl-C
      this.line = '';
      this.waiting = null;
      process.stdout.write('\n');
      w.reject(new Error(t('cli.credentials.cancelled')));
      return;
    }
    if (char === '' || char === '\b') {
      if (this.line.length > 0) {
        this.line = this.line.slice(0, -1);
        if (w.mask) process.stdout.write('\b \b');
      }
      return;
    }
    this.line += char;
    process.stdout.write(w.mask ? '*' : char);
  }

  readLine(question: string, mask: boolean): Promise<string> {
    process.stdout.write(question);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, mask };
      const carried = this.overflow;
      this.overflow = '';
      for (let i = 0; i < carried.length; i++) {
        if (!this.waiting) {
          // Line resolved before the carried-over chars ran out — the rest
          // belongs to whatever prompt comes next, not this one.
          this.overflow += carried.slice(i);
          break;
        }
        this.consumeChar(carried[i]);
      }
    });
  }

  close(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(this.wasRaw);
    process.stdin.pause();
  }
}

async function main(): Promise<void> {
  console.log(`${t('cli.credentials.title')}\n`);

  const reader = new LineReader();
  try {
    const username = (await reader.readLine(t('cli.credentials.username'), false)).trim();
    if (!username) throw new Error(t('cli.credentials.usernameEmpty'));
    if (username.includes('#')) throw new Error(t('cli.credentials.usernameHash'));

    const password = await reader.readLine(t('cli.credentials.password'), true);
    if (!password) throw new Error(t('cli.credentials.passwordEmpty'));

    const confirm = await reader.readLine(t('cli.credentials.passwordAgain'), true);
    if (password !== confirm) throw new Error(t('cli.credentials.passwordMismatch'));

    const passwordHash = hashPassword(password);
    writeEnv(envPath, { AUTH_USERNAME: username, AUTH_PASSWORD_HASH: passwordHash });

    console.log(`\n${t('cli.credentials.written', { path: envPath })}`);
    console.log(t('cli.credentials.hashed'));
    const restart = hostPlatform().service.restartCommand();
    console.log(restart ? t('cli.credentials.restart', { command: restart }) : t('cli.credentials.restartGeneric'));
  } finally {
    reader.close();
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
