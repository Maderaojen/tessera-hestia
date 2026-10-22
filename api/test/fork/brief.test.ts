import { describe, expect, it } from 'vitest';
import type { Fork } from '../../src/contract/fork.js';
import type { RepoFileChange } from '../../src/contract/repo.js';
import { formatForkAddendum, formatForkBrief, LAST_REQUEST_MAX, type ForkBriefInput } from '../../src/fork/brief.js';

const fork: ForkBriefInput['fork'] = {
  id: 'f1f1f1f1',
  title: '兩欄的設定頁',
  createdAt: '2026-10-08T10:00:00.000Z',
  origin: { sessionId: 'main', conversationId: 'c1', tmuxName: 'hestia-main', profileId: 'native:claude', turnsAtFork: 12, commit: 'base0001' },
  memory: 'brief',
  instruction: null,
  profileLabel: 'Codex CLI',
  workspace: { isolation: 'worktree', repoRoot: '/work/hestia', path: '/work/hestia-fork-f1f1f1f1/api', worktree: '/work/hestia-fork-f1f1f1f1', branch: 'fork/f1f1f1f1', baseCommit: 'base0001' },
};

// Text that is only in the main line's conversation, never in the brief.
const EARLIER = '第一輪的祕密內容：請把 API 換成 GraphQL';
const LAST = '把設定頁的排版改成兩欄，然後'.repeat(100);

const input = (patch: Partial<ForkBriefInput> = {}): ForkBriefInput => ({
  fork,
  parent: { cwd: '/work/hestia/api', profileLabel: 'Claude Code' },
  parentDirty: [{ path: 'web/src/App.vue', origPath: null, staged: null, unstaged: 'modified' } as RepoFileChange],
  upstream: {
    archiveFile: '/state/dialogue/h/claude/hestia-main/c1.jsonl', transcriptFile: '/home/u/.claude/projects/p/abc.jsonl', transcriptFormat: 'jsonl',
    recapFile: '/state/dialogue/h/claude/hestia-main/c1.recap.json', lastRequest: LAST,
  },
  ...patch,
});

describe('a branch line\'s brief', () => {
  it('says what it is, where it came from and where it works now', () => {
    const brief = formatForkBrief(input());
    expect(brief).toContain('# 支線：兩欄的設定頁');
    expect(brief).toContain('不是交接、也不是指派');
    expect(brief).toContain('`hestia-main`（Claude Code）');
    expect(brief).toContain('當時共 12 輪');
    expect(brief).toContain('`/work/hestia-fork-f1f1f1f1`');
    expect(brief).toContain('`fork/f1f1f1f1`');
    expect(brief).toContain('base commit：`base0001`');
    expect(brief).toContain('現在請改用 `/work/hestia-fork-f1f1f1f1/api`，**不要改主線資料夾裡的檔案**');
    expect(brief).toContain('- `web/src/App.vue`（modified）');
    expect(brief).toContain('不 push、不合併、不部署');
    expect(brief).toContain('等使用者的指示');
  });

  it('points at the upstream instead of copying it: one cut quote, and where to read', () => {
    const brief = formatForkBrief(input());
    expect(brief).not.toContain(EARLIER);
    expect(brief).toContain('hestia conversation show --upstream');
    expect(brief).toContain('/state/dialogue/h/claude/hestia-main/c1.jsonl');
    expect(brief).toContain('/home/u/.claude/projects/p/abc.jsonl');
    expect(brief).toContain('c1.recap.json');
    // The last request, cut to about a thousand characters.
    expect(brief).toContain('（以下省略）');
    expect(brief).not.toContain(LAST);
    const quoted = brief.split('\n').filter((line) => line.startsWith('> ')).join('');
    expect(quoted.length).toBeLessThan(LAST_REQUEST_MAX + 50);
  });

  it('with the CLI\'s own fork, only says where it works now and has no upstream section', () => {
    const brief = formatForkBrief(input({ fork: { ...fork, memory: 'native', instruction: '先比較兩種做法' } }));
    expect(brief).toContain('你記憶裡的檔案路徑在 `/work/hestia/api`；現在請改用');
    expect(brief).not.toContain('上游對話紀錄在哪裡');
    expect(brief).toContain('> 先比較兩種做法');
  });

  it('warns about a shared folder, and calls Agy\'s record a database', () => {
    const shared = formatForkBrief(input({
      fork: { ...fork, workspace: { isolation: 'shared', repoRoot: null, path: '/work/notes', worktree: null, branch: null, baseCommit: null } },
      upstream: { ...input().upstream!, transcriptFile: '/home/u/.gemini/db.sqlite', transcriptFormat: 'sqlite' },
    }));
    expect(shared).toContain('和主線共用同一個資料夾');
    expect(shared).toContain('兩邊會改到同一批檔案');
    expect(shared).not.toContain('web/src/App.vue');
    expect(shared).toContain('SQLite 資料庫，不建議直接讀');
  });

  it('adds to a continuity handoff that the tmux is a branch line', () => {
    const addendum = formatForkAddendum({ ...fork, briefFile: '/work/hestia-fork-f1f1f1f1/api/.hestia/forks/f1f1f1f1/brief.md' } as Fork);
    expect(addendum).toContain('這是一條支線');
    expect(addendum).toContain('hestia conversation show --upstream');
  });
});
