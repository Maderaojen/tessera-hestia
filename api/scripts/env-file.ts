// Shared by set-credentials.ts and write-env.ts (the installer's
// non-interactive path): set KEY=VALUE lines in a .env file in place,
// keeping every other line, and keep the file readable by this user only —
// it holds the password hash.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Values are written bare, and node's .env parser (what --env-file uses)
// reads a bare `#` as the start of a comment and stops a value at a line
// break: such a value would come back cut short (a username `me#2` read as
// `me`, and the login never matching). Refused instead of quoted, so every
// reader of the file, the installer's shell fallback included, agrees.
export function envValueProblem(value: string): string | null {
  if (value.includes('#')) return 'cannot contain #';
  if (/[\r\n]/.test(value)) return 'cannot contain a line break';
  return null;
}

export function writeEnv(envPath: string, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    const problem = envValueProblem(value);
    if (problem) throw new Error(`${key} ${problem}`);
  }
  const keys = new Set(Object.keys(values));
  const seen = new Set<string>();
  let lines: string[] = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];

  // AUTH_PASSWORD is the old plaintext key the hash replaces — drop it
  // entirely rather than leaving a stale plaintext copy alongside the hash.
  // Blank lines are dropped too (re-added once, at the end, by the join
  // below) so removing a key never leaves a gap in the middle of the file.
  lines = lines.filter((line) => line !== '' && !line.startsWith('AUTH_PASSWORD='));

  lines = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const key = line.slice(0, eq);
    if (keys.has(key)) {
      seen.add(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });

  for (const key of keys) {
    if (!seen.has(key)) lines.push(`${key}=${values[key]}`);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}
