import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);

// Run in a child Node process so the regression proves there is no uncaught
// stream exception killing the API, rather than relying on a mock listener.
async function probe(args: string[]): Promise<string> {
  const script = `import { git, GitError } from './src/git/run.ts';
    try { const out = await git(process.cwd(), ${JSON.stringify(args)}, { input: 'x'.repeat(4 * 1024 * 1024) }); console.log(JSON.stringify({ out })); }
    catch (error) { if (!(error instanceof GitError)) throw error; console.log(JSON.stringify({ kind: error.kind })); }`;
  const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 10_000 });
  return result.stdout;
}
describe('git runner stdin lifecycle', () => {
  it('does not crash when a successful git command exits without reading queued input', async () => {
    expect(JSON.parse(await probe(['--version'])).out).toMatch(/^git version/);
  });
  it('preserves the git error when the process rejects a command before reading queued input', async () => {
    expect(JSON.parse(await probe(['hestia-no-such-subcommand'])).kind).toBe('failed');
  });
});
