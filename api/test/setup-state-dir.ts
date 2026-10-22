import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach } from 'vitest';

// config.ts resolves STATE_DIR (and the dialogue archive under it) from the
// environment when first imported, and otherwise falls back to the user's
// real state directory. Many test files import server/route modules without
// setting HESTIA_STATE_DIR themselves, so they read and wrote the live
// install's files (routes/uploads.test.ts even deleted its uploads/). Every
// test file therefore starts with a throwaway state dir; a file that needs
// its own still sets the variable, which wins over this default.
const fallbackStateDir = mkdtempSync(path.join(os.tmpdir(), 'hestia-test-state-'));

// What the shell hands down never counts: a CLI working inside a Hestia
// tmux inherits the running backend's own paths (its tmux server was
// started by the API service), and a `||=` below would then keep them —
// tests ran against the live install that way, and uploads.test.ts deleted
// its real uploads/. A file that needs its own value sets it itself.
for (const key of ['HESTIA_STATE_DIR', 'HESTIA_DIALOGUE_ROOT', 'HESTIA_SESSION_PREFIX', 'HESTIA_USER_BIN_DIR', 'HESTIA_ARCHITECTURE_DIR']) {
  delete process.env[key];
}

function pointAtFallback(): void {
  process.env.HESTIA_STATE_DIR ||= fallbackStateDir;
}

pointAtFallback();
// Some files delete the variable in afterEach; a module re-imported after
// that (vi.resetModules) must still not resolve to the real directory.
beforeEach(pointAtFallback);

afterAll(() => {
  rmSync(fallbackStateDir, { recursive: true, force: true });
});
