import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexResume, codexCliRuntime, readCodexResumeConflict } from '../src/runtimes/codex-cli.js';
import { readCodexStartupPrompt } from '../src/runtimes/codex-cli.js';

const SID = '01a10a0a-577d-78f0-b390-d594bfdf9eac';
const CAPTURES = path.join(import.meta.dirname, 'fixtures', 'resume-conflicts');
const captures = readdirSync(CAPTURES).filter((name) => name.endsWith('.txt')).map((name) => {
  const [runtime, expected] = name.split('.') as [string, string];
  return { name, runtime, expected, pane: readFileSync(path.join(CAPTURES, name), 'utf8') };
});

describe('resume conflict captures (test/fixtures/resume-conflicts)', () => {
  it('are all Codex captures named <runtime>.<conflict|none>.<label>.txt', () => {
    expect(captures.length).toBeGreaterThan(0);
    for (const { name, runtime, expected } of captures) {
      expect(runtime, name).toBe('codex');
      expect(['conflict', 'none'], name).toContain(expected);
    }
  });

  it.each(captures)('$name', ({ expected, pane }) => {
    expect(readCodexResumeConflict(pane)).toBe(expected === 'conflict');
    // Not a trust prompt either: the poller must not answer it as one.
    expect(readCodexStartupPrompt(pane)).toBeNull();
  });

  it('ignores the sentence when it is only quoted in the conversation above', () => {
    const pane = [
      '› What does Codex say when a thread is busy?',
      '• It says "This conversation is open in another app" and offers r retry, f fork or exit.',
      '',
      '› Ask Codex to do anything',
      '  GPT-6-Luna high · /work · Workspace',
      '  ? for shortcuts',
    ].join('\n');
    expect(readCodexResumeConflict(pane)).toBe(false);
  });
});

describe('codexCliRuntime resume', () => {
  it('resumes in place, without the shared daemon, in the session folder', () => {
    expect(codexCliRuntime.resume).toEqual({ kind: 'in_place' });
    expect(buildCodexResume(SID, '/work/p')).toEqual({
      argv: ['codex', 'resume', '--no-daemon', '-C', '/work/p', SID], providerSessionId: SID,
    });
  });

  it('refuses anything but a thread id and an absolute folder', () => {
    expect(() => buildCodexResume('--last', '/work/p')).toThrow();
    expect(() => buildCodexResume(SID, 'relative')).toThrow();
  });

  it('leaves the conflict screen with Escape, never by typing', () => {
    expect(codexCliRuntime.resumeConflict?.dismissKey).toBe('Escape');
  });
});
