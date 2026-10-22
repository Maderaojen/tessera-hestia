import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_CAPABILITIES, ERROR_CODES, RECAP_ERROR_CODES, RECAP_STATUSES, RUNTIME_IDS, RUNTIME_LABELS, TRASH_LAST_MESSAGE_CHARS } from '../src/contract/index.js';
import { errorBody } from '../src/routes/errors.js';
import { getRuntimeDriver, runtimeDrivers } from '../src/runtimes/index.js';

const CONTRACT_DIR = path.join(import.meta.dirname, '../src/contract');
const SRC_DIR = path.join(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sourceFiles(path.join(dir, entry.name))
    : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []);
}

describe('the shared contract', () => {
  // The web app bundles these files too: anything they import has to exist
  // there, and a Node built-in or an API module wouldn't.
  it('imports nothing outside itself', () => {
    for (const file of readdirSync(CONTRACT_DIR).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(path.join(CONTRACT_DIR, file), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/(?:[\w-]+\.js|prompts\/[\w-]+\.json)$/);
      }
    }
  });

  it('knows every runtime the API drives, under the label its driver declares', () => {
    for (const driver of runtimeDrivers()) {
      expect(RUNTIME_IDS).toContain(driver.runtimeId);
      expect(RUNTIME_LABELS[driver.runtimeId as keyof typeof RUNTIME_LABELS]).toBe(driver.label);
    }
    expect(getRuntimeDriver('legacy-unknown')).toBeUndefined();
  });

  it('every failed call answers with a code, through routes/errors.ts', () => {
    for (const file of sourceFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.relative(SRC_DIR, file)).not.toMatch(/\.json\(\{\s*error\s*:/);
    }
  });

  it('an error body keeps the legacy `error` text for cached PWAs', () => {
    expect(errorBody('session_dead', 'session is dead')).toEqual({ code: 'session_dead', message: 'session is dead', error: 'session is dead' });
    expect(errorBody('no_running_cli', 'x', { status: 'dead' }).params).toEqual({ status: 'dead' });
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('declares the trash: its capability and error codes', () => {
    expect(API_CAPABILITIES).toContain('session_trash');
    expect(ERROR_CODES).toContain('session_not_trashed');
    expect(ERROR_CODES).toContain('recovery_cwd_missing');
    expect(TRASH_LAST_MESSAGE_CHARS).toBe(200);
  });

  it('declares conversation recaps: their capability, error codes and statuses', () => {
    expect(API_CAPABILITIES).toContain('recap');
    for (const code of ['recap_disabled', 'recap_unavailable', 'recap_item_not_found']) expect(ERROR_CODES).toContain(code);
    expect(RECAP_STATUSES).toEqual(['implemented', 'accepted', 'planned', 'not_implemented', 'uncertain']);
    expect(RECAP_ERROR_CODES).toEqual(['invalid_output', 'run_failed', 'run_timeout', 'account_limited', 'model_rejected', 'profile_unavailable', 'runner_unavailable']);
  });
});
