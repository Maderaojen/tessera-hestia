import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// How long Claude Code keeps an account's transcripts: `cleanupPeriodDays`
// in that account's settings.json (whole days, at least 1, 30 when unset;
// 0 fails Claude Code's own validation — code.claude.com/docs/en/settings-
// reference#cleanupperioddays). A settings file Claude Code can't parse
// pauses its cleanup, so a file that isn't a JSON object is never touched.
// docs/specs/turn-process-levels.md §9.

export const CLAUDE_DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export type RetentionRead =
  | { state: 'ok'; days: number | null; raw: string | null }
  | { state: 'unreadable' };

export function claudeSettingsFile(home: string): string {
  return path.join(home, 'settings.json');
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The value set (null: not set, the CLI's default applies), and the file as read. */
export async function readClaudeRetention(file: string): Promise<RetentionRead> {
  let raw: string | null;
  try {
    raw = await readRaw(file);
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === null) return { state: 'ok', days: null, raw: null };
  const settings = parseObject(raw);
  if (!settings) return { state: 'unreadable' };
  const days = settings.cleanupPeriodDays;
  return { state: 'ok', days: typeof days === 'number' && Number.isInteger(days) ? days : null, raw };
}

export type RetentionWrite = 'written' | 'invalid_days' | 'unreadable' | 'changed';

/**
 * Sets cleanupPeriodDays, leaving every other setting as it is. `expectedDays`
 * is the value the user was looking at: a file changed since (by them, by
 * the CLI) is not overwritten. The file is read again right before it is
 * replaced, and replaced whole by a rename, so a write never lands on top of
 * one made in between.
 */
// How the file was laid out, kept on rewrite: its indent (two or four
// spaces, a tab, or none for a one-line file) and whether it ended with a
// line break. A new file gets two spaces and a final line break.
export function layoutOf(raw: string | null): { indent: string | number; finalNewline: boolean } {
  if (raw === null) return { indent: 2, finalNewline: true };
  const indent = /\n([ \t]+)\S/.exec(raw)?.[1];
  return { indent: indent ?? (raw.trim().includes('\n') ? 2 : 0), finalNewline: raw.endsWith('\n') };
}

export type RetentionWriteHooks = {
  // Tests only: runs after the new file is written beside the old one and
  // before it replaces it — where a change made by someone else must
  // still be caught.
  beforeRename?: () => Promise<void>;
};

export async function writeClaudeRetention(file: string, days: number, expectedDays: number | null, hooks: RetentionWriteHooks = {}): Promise<RetentionWrite> {
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) return 'invalid_days';
  const before = await readClaudeRetention(file);
  if (before.state !== 'ok') return 'unreadable';
  if (before.days !== expectedDays) return 'changed';
  const settings = before.raw === null ? {} : parseObject(before.raw)!;
  const layout = layoutOf(before.raw);
  const next = `${JSON.stringify({ ...settings, cleanupPeriodDays: days }, null, layout.indent || undefined)}${layout.finalNewline ? '\n' : ''}`;
  const mode = before.raw === null ? 0o600 : (await stat(file)).mode & 0o777;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.hestia-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, next, { mode, flag: 'wx' });
  try {
    await hooks.beforeRename?.();
    const again = await readRaw(file).catch(() => undefined);
    if (again !== before.raw) {
      await rm(temp, { force: true });
      return 'changed';
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return 'written';
}
