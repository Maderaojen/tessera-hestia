import { describe, expect, it } from 'vitest';
import type { Delegation } from '../../src/contract/delegation.js';
import { formatDelegationAddendum, formatDelegationBrief, formatDelegatorAddendum, formatParentReport, type DelegationBriefInput } from '../../src/delegation/brief.js';

const input: DelegationBriefInput = {
  delegation: {
    id: 'ab12cd34', title: 'Status JSON', task: 'Add a --json flag.\nKeep the old output.', depth: 1,
    workspace: {
      isolation: 'worktree', repoRoot: '/work/hestia', path: '/work/hestia-delegate-ab12cd34/api', worktree: '/work/hestia-delegate-ab12cd34',
      branch: 'delegate/ab12cd34-status-json', baseCommit: 'base0001', headAtDelivery: null,
    },
  },
  parent: { tmuxName: 'hestia-p1', profileLabel: 'Claude Code' },
  parentDirty: true,
  upstream: {
    sessionId: 'p1', conversationId: 'c1', turns: 12,
    view: {
      archiveFile: '/state/dialogue/h/claude/hestia-p1/c1.jsonl', transcriptFile: '/home/u/.claude/projects/p/abc.jsonl', transcriptFormat: 'jsonl',
      recapFile: '/state/dialogue/h/claude/hestia-p1/c1.recap.json', lastRequest: '把 status 加上 --json，交給 Codex', turns: 14, lastIndex: 15,
    },
  },
  reportFile: '/work/hestia-delegate-ab12cd34/api/.hestia/delegations/ab12cd34/report.md',
  canDelegate: false,
};

describe('the delegate\'s brief', () => {
  it('has the task, who it is, the rules, how to deliver and the background', () => {
    const brief = formatDelegationBrief(input);
    expect(brief).toContain('> Add a --json flag.\n> Keep the old output.');
    expect(brief).toContain('`ab12cd34`');
    expect(brief).toContain('tmux `hestia-p1`（Claude Code）');
    expect(brief).toContain('`delegate/ab12cd34-status-json`');
    expect(brief).toContain('`base0001`');
    expect(brief).toContain('不 push、不合併、不部署');
    expect(brief).toContain('不能再把工作指派給別人');
    expect(brief).toContain('那些改動不在這裡');
    expect(brief).toContain('可能還沒有安裝依賴');
    expect(brief).toContain(`hestia delegate done --report-file ${input.reportFile}`);
    expect(brief).toContain('hestia delegate done --blocked');
  });

  it('points at the delegating conversation instead of copying it', () => {
    const brief = formatDelegationBrief(input);
    expect(brief).not.toContain('parent-conversation');
    expect(brief).toContain('## 上游對話紀錄在哪裡');
    expect(brief).toContain('1. `hestia conversation show --upstream`：印出發起對話到指派時為止的 12 輪');
    // The explicit one stops at that turn's own number, which --turns goes by.
    expect(brief).toContain('`hestia conversation show --session p1 --conversation c1 --turns ..15`');
    expect(brief).toContain('2. Hestia 的對話歸檔：`/state/dialogue/h/claude/hestia-p1/c1.jsonl`');
    expect(brief).toContain('3. CLI 自己的轉錄檔：`/home/u/.claude/projects/p/abc.jsonl`');
    expect(brief).toContain('c1.recap.json');
    expect(brief).toContain('> 把 status 加上 --json，交給 Codex');
  });

  it('quotes the last request cut short', () => {
    const long = '很長的要求'.repeat(400);
    const brief = formatDelegationBrief({ ...input, upstream: { ...input.upstream!, view: { ...input.upstream!.view, lastRequest: long } } });
    expect(brief).not.toContain(long);
    expect(brief).toContain('（以下省略）');
  });

  it('says there is no record when the delegating conversation has no turns', () => {
    const empty = { ...input.upstream!.view, lastRequest: null, turns: 0, lastIndex: null };
    const brief = formatDelegationBrief({ ...input, upstream: { ...input.upstream!, turns: 0, view: empty } });
    expect(brief).toContain('沒有發起對話的紀錄');
    expect(brief).not.toContain('hestia conversation show');
  });

  it('says so when the folder is shared, and leaves out what only a worktree has', () => {
    const brief = formatDelegationBrief({
      ...input,
      delegation: { ...input.delegation, workspace: { ...input.delegation.workspace, isolation: 'shared', worktree: null, branch: null, baseCommit: null } },
      upstream: null,
    });
    expect(brief).toContain('和發起者共用同一個目錄');
    expect(brief).toContain('不要切換 branch');
    expect(brief).not.toContain('那些改動不在這裡');
    expect(brief).not.toContain('base commit');
    expect(brief).toContain('沒有發起對話的紀錄');
  });
});

describe('what a continuity handoff brief adds for a delegate', () => {
  const briefFile = '/work/hestia-delegate-ab12cd34/api/.hestia/delegations/ab12cd34/brief.md';

  it('says it is a delegation, where the brief is, and how to deliver', () => {
    const text = formatDelegationAddendum({ delegation: { ...input.delegation, briefFile }, reportFile: input.reportFile });
    expect(text).toContain('Hestia 指派 `ab12cd34`');
    expect(text).toContain('Status JSON');
    expect(text).toContain(briefFile);
    expect(text).toContain('`delegate/ab12cd34-status-json` branch');
    expect(text).toContain(`hestia delegate done --report-file ${input.reportFile}`);
    expect(text).toContain('hestia delegate done --blocked');
    expect(text).toContain('閒置不算完成');
  });

  it('leaves the worktree rules out when the folder is shared', () => {
    const shared = { ...input.delegation.workspace, isolation: 'shared' as const, worktree: null, branch: null, path: '/work/hestia/api' };
    const text = formatDelegationAddendum({ delegation: { ...input.delegation, workspace: shared, briefFile }, reportFile: input.reportFile });
    expect(text).not.toContain('worktree');
    expect(text).not.toContain('commit');
    expect(text).toContain('hestia delegate done --report-file');
  });
});

describe('what a continuity handoff brief adds for a delegating tmux', () => {
  it('lists what it delegated and hasn\'t heard back about, and how results arrive', () => {
    const text = formatDelegatorAddendum([
      { id: 'ab12cd34', title: 'Status JSON', state: 'reviewing', profileLabel: 'Codex CLI', workspace: input.delegation.workspace },
      { id: 'cd34ef56', title: 'Docs', state: 'working', profileLabel: 'Claude Code', workspace: { ...input.delegation.workspace, branch: null } },
    ])!;
    expect(text).toContain('還沒結束的工作');
    expect(text).toContain('`ab12cd34`「Status JSON」：交給 Codex CLI，目前 `reviewing`，branch `delegate/ab12cd34-status-json`');
    expect(text).toContain('`cd34ef56`「Docs」：交給 Claude Code，目前 `working`\n');
    expect(text).toContain('hestia delegate review');
    expect(text).toContain('hestia delegate status');
  });

  it('is nothing with none', () => {
    expect(formatDelegatorAddendum([])).toBeNull();
  });
});

describe('what the delegating conversation reads', () => {
  const delegation = {
    id: 'ab12cd34', title: 'Status JSON', profileLabel: 'Codex CLI', state: 'delivered', stateReason: null, stateDetail: null,
    workspace: { ...input.delegation.workspace, headAtDelivery: 'f00dfeed' },
    reports: [
      { kind: 'understanding', by: 'child', at: '2026-10-06T10:00:00Z', text: 'I will add it.' },
      { kind: 'delivery', by: 'child', at: '2026-10-06T11:00:00Z', text: '## Done\n- added --json' },
    ],
  } as unknown as Delegation;

  it('says what happened, where the work is, how to look at it, and what not to do', () => {
    const report = formatParentReport(delegation, 'delivered');
    expect(report).toContain('# 指派 ab12cd34：已交付，等使用者驗收');
    expect(report).toContain('`delegate/ab12cd34-status-json`（base `base0001`）');
    expect(report).toContain('交付時的 commit：`f00dfeed`');
    expect(report).toContain('git -C /work/hestia-delegate-ab12cd34 diff base0001...delegate/ab12cd34-status-json');
    expect(report).toContain('## 交付報告\n\n## Done\n- added --json');
    expect(report).toContain('不要自己合併');
    expect(report).toContain('hestia delegate stop ab12cd34');
    expect(report).not.toContain('I will add it.');
  });

  it('leaves the delivery out of the user\'s verdict, and says the branch may be merged once accepted', () => {
    const report = formatParentReport({ ...delegation, state: 'accepted' }, 'accepted');
    expect(report).not.toContain('## 交付報告');
    expect(report).toContain('可以照使用者的意思把 `delegate/ab12cd34-status-json` 合併');
  });
});
