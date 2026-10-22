// Non-interactive counterpart of set-credentials.ts, for scripts/install.sh:
//
//   node dist/scripts/write-env.js <env-file> [--password-stdin] KEY=VALUE...
//
// Sets the given keys in the env file (see env-file.ts). With
// --password-stdin the password arrives on stdin — never as an argument,
// where any user on the machine could read it from the process list — and
// only its scrypt hash is written, as AUTH_PASSWORD_HASH, exactly as
// set-credentials does.
import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/auth.js';
import { writeEnv } from './env-file.js';
import { localeFromEnv, setDefaultLocale, t } from '../src/i18n/index.js';

setDefaultLocale(localeFromEnv());

function fail(message: string): never {
  console.error(`write-env: ${message}`);
  process.exit(1);
}

const [envPath, ...args] = process.argv.slice(2);
if (!envPath) fail('usage: write-env.ts <env-file> [--password-stdin] KEY=VALUE...');

const values: Record<string, string> = {};
for (const arg of args) {
  if (arg === '--password-stdin') {
    // One line: a trailing newline is how it was sent, not part of it.
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!password) fail(t('cli.credentials.passwordEmpty'));
    values.AUTH_PASSWORD_HASH = hashPassword(password);
    continue;
  }
  const eq = arg.indexOf('=');
  if (eq <= 0) fail(`not KEY=VALUE: ${arg}`);
  const value = arg.slice(eq + 1);
  values[arg.slice(0, eq)] = value;
}

// A value .env can't hold as written (env-file.ts's envValueProblem).
try {
  writeEnv(envPath, values);
} catch (error) {
  fail((error as Error).message);
}
