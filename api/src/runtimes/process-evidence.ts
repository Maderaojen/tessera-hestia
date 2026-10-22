import path from 'node:path';
import { hostPlatform, type ProcessInspection, type ProcessView } from '../host-platform/index.js';

export type { ProcessInspection, ProcessView };

/**
 * Read-only look at one process, fenced by its start time: the view is
 * trusted only when the same process (same PID *and* start time) existed
 * before and after `inspect` ran. How the process is read is the
 * platform's (host-platform/: /proc on Linux, ps and lsof on macOS,
 * nothing elsewhere); every implementation reports failures (including
 * `inspect` throwing) instead of throwing, so identity observers fail
 * closed.
 */
export function inspectProcess<T>(pid: number, inspect: (view: ProcessView) => T | Promise<T>): Promise<ProcessInspection<T>> {
  return hostPlatform().inspector.inspect(pid, inspect);
}

/** Open files that are `<dir>/<name>` directly inside `dir` (deleted files excluded). */
export function openFilesIn(openFiles: readonly string[], dir: string): string[] {
  const resolved = path.resolve(dir);
  return openFiles.filter((target) => !target.endsWith(' (deleted)') && path.dirname(target) === resolved);
}
