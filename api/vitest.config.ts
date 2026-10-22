import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // An optional module's own tests sit in its folder (api/modules/*/test).
    include: ['test/**/*.test.ts', 'modules/*/test/**/*.test.ts'],
    // Keeps every test off the user's real state directory (see the file).
    setupFiles: ['test/setup-state-dir.ts'],
    // Hestia's stores (registry, notes, tag index) are tested for how they
    // behave when a write fails or is still in flight, by mocking
    // node:fs/promises; the writes themselves happen inside the package,
    // which only sees that mock when it's inlined.
    server: { deps: { inline: ['@maderaojen/json-file-store'] } },
  },
});
