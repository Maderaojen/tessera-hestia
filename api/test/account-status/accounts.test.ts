import { describe, expect, it } from 'vitest';
import { accountsFromJanusList, commandOnPath, probePath } from '../../src/account-status/accounts.js';

// Shape of `janus list --json` on this host (2026-09).
const JANUS_LIST = [
  { source: 'janus', name: 'claude-work', provider: 'claude', command: 'claude-work', home: '/h/.claude-work', state: 'ready', conversation_root: '/h/.claude-work/projects' },
  { source: 'janus', name: 'codex-home', provider: 'codex', command: 'codex-home', home: '/h/.codex-home', state: 'ready', conversation_root: '/h/.codex-home/sessions' },
  { source: 'native', name: 'default', provider: 'codex', command: 'codex', home: '/h/.codex', state: 'external', conversation_root: '/h/.codex/sessions' },
  { source: 'native', name: 'default', provider: 'copilot', command: 'copilot', home: '/h/.copilot', state: 'external', conversation_root: '/h/.copilot' },
  { source: 'janus', name: 'claude-work', provider: 'claude', home: '/dup' },
  { name: 42 },
];

describe('accountsFromJanusList', () => {
  it('launches Janus accounts through `janus run` and native ones directly', () => {
    const accounts = accountsFromJanusList(JANUS_LIST, '/usr/bin/janus');
    expect(accounts.map((a) => a.id)).toEqual([
      'janus:claude:claude-work', 'janus:codex:codex-home', 'native:codex:default', 'native:copilot:default',
    ]);
    expect(accounts[0]).toMatchObject({ launch: ['/usr/bin/janus', 'run', 'claude-work'], env: { PATH: probePath() } });
    expect(accounts[2]).toMatchObject({ launch: ['codex'], env: { PATH: probePath(), CODEX_HOME: '/h/.codex' }, unsetEnv: [] });
    expect(accountsFromJanusList([{ source: 'native', name: 'default', provider: 'claude', home: '/h/.claude' }], 'j')[0].unsetEnv)
      .toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('extends a bare service PATH with ~/.local/bin and the running node\'s bin dir', async () => {
    const extended = probePath('/usr/bin:/bin', '/opt/nvm/v22/bin/node').split(':');
    expect(extended).toEqual(['/usr/bin', '/bin', expect.stringMatching(/\/\.local\/bin$/), '/opt/nvm/v22/bin']);
    expect(probePath('/opt/nvm/v22/bin:/bin', '/opt/nvm/v22/bin/node').split(':').filter((d) => d === '/opt/nvm/v22/bin')).toHaveLength(1);
    expect(await commandOnPath('node', '')).toBe(false);
    expect(await commandOnPath('node', probePath('', process.execPath))).toBe(true);
  });

  it('ignores non-array output', () => {
    expect(accountsFromJanusList({ oops: true }, '/usr/bin/janus')).toEqual([]);
  });
});
