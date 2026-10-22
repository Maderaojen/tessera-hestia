import path from 'node:path';
import { createDeniedPaths } from '@maderaojen/fs-guard';
import { HOME, STATE_DIR } from '../config.js';

// What the project files and git view never read, even when a project path
// happens to contain it (repo-paths.ts): this backend's own state and
// secrets, and the user's keys. Also where no delegation or branch line
// worktree is put (spawn/workspace.ts), since one there could never be
// read. The fence itself is @maderaojen/fs-guard's; the list is this app's.

export function deniedPaths(): string[] {
  return [STATE_DIR, path.resolve(process.cwd(), '.env'), path.join(HOME, '.ssh'), path.join(HOME, '.gnupg')];
}

export const denied = createDeniedPaths(deniedPaths);

/** Whether `target` is one of them or under one, as written (symlinks aren't followed). */
export function isDeniedPath(target: string): boolean {
  return denied.isDenied(target);
}
