import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandName } from '../src/config.js';

// The hestia command's name for this install (install.sh --command-name,
// HESTIA_COMMAND_NAME in .env): what an LLM in one of its panes is told to
// run, so a second backend on the machine is reached through its own.

describe('commandName', () => {
  it('is hestia unless .env names another, and ignores what isn’t a plain name', () => {
    expect(commandName({})).toBe('hestia');
    expect(commandName({ HESTIA_COMMAND_NAME: '' })).toBe('hestia');
    expect(commandName({ HESTIA_COMMAND_NAME: ' hestia-dev ' })).toBe('hestia-dev');
    expect(commandName({ HESTIA_COMMAND_NAME: 'rm -rf /' })).toBe('hestia');
    expect(commandName({ HESTIA_COMMAND_NAME: '../hestia' })).toBe('hestia');
  });
});

const original = process.env.HESTIA_COMMAND_NAME;
afterEach(() => {
  if (original === undefined) delete process.env.HESTIA_COMMAND_NAME;
  else process.env.HESTIA_COMMAND_NAME = original;
  vi.resetModules();
});

// config.ts reads the environment once at import: the briefs are imported
// again with the name in place.
async function briefs(name: string | undefined) {
  vi.resetModules();
  if (name === undefined) delete process.env.HESTIA_COMMAND_NAME;
  else process.env.HESTIA_COMMAND_NAME = name;
  return { delegation: await import('../src/delegation/brief.js'), fork: await import('../src/fork/brief.js') };
}

const delegation = {
  id: 'ab12cd34', title: 'Status JSON', briefFile: '/w/.hestia/delegations/ab12cd34/brief.md',
  workspace: { isolation: 'worktree' as const, repoRoot: '/w', path: '/w', worktree: '/w', branch: 'delegate/x', baseCommit: 'b', headAtDelivery: null },
};
const fork = { id: 'f1', title: 'Try', briefFile: '/w/fork.md', origin: { tmuxName: 'hestia-p1', conversationId: 'c1', turnsAtFork: 3 } };

describe('the commands in the prompts', () => {
  it('are hestia by default', async () => {
    const { delegation: d, fork: f } = await briefs(undefined);
    const text = d.formatDelegationAddendum({ delegation, reportFile: '/w/report.md' });
    expect(text).toContain('`hestia delegate done --report-file /w/report.md`');
    expect(text).toContain('`hestia delegate status`');
    expect(f.formatForkAddendum(fork as never)).toContain('`hestia conversation show --upstream`');
  });

  it('follow HESTIA_COMMAND_NAME, so a dev backend’s LLM runs hestia-dev', async () => {
    const { delegation: d, fork: f } = await briefs('hestia-dev');
    const text = d.formatDelegationAddendum({ delegation, reportFile: '/w/report.md' });
    expect(text).toContain('`hestia-dev delegate done --report-file /w/report.md`');
    expect(text).toContain('`hestia-dev delegate done --blocked');
    expect(text).not.toMatch(/`hestia delegate/);
    expect(d.formatDelegatorAddendum([{ id: 'ab12cd34', title: 't', state: 'working', profileLabel: null, workspace: delegation.workspace }] as never))
      .toContain('`hestia-dev delegate status [<id>]`');
    expect(f.formatForkAddendum(fork as never)).toContain('`hestia-dev conversation show --upstream`');
  });
});
