import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { DIALOGUE_ROOT, STATE_DIR } from '../src/config.js';

// Run from inside a Hestia tmux, the shell carries the live backend's
// HESTIA_STATE_DIR / HESTIA_DIALOGUE_ROOT; test/setup-state-dir.ts must win.
describe('test state isolation', () => {
  it('never resolves to a directory outside the temp dir, whatever the shell exported', () => {
    expect(STATE_DIR.startsWith(os.tmpdir())).toBe(true);
    expect(DIALOGUE_ROOT.startsWith(os.tmpdir())).toBe(true);
  });
});
