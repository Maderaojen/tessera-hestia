import { describe, expect, it } from 'vitest';
import { formatConversationExport, formatMechanicalBrief, LAST_REPLY_MAX, type BriefInput } from '../../src/continuity/brief.js';
import { LAST_REQUEST_MAX } from '../../src/upstream/brief.js';

const turn = (index: number, user: string, assistant: string, interrupted = false) => ({
  index, user: { text: user, at: null }, assistant: { text: assistant, at: null, ...(interrupted ? { interrupted: true as const } : {}) },
});

const SHOW = 'hestia conversation show --session s1 --conversation c1';

const base: BriefInput = {
  handoff: { trigger: 'soft', toLabel: 'Codex (原生)', briefSource: 'mechanical', briefNote: '請求送到時被截斷了' },
  fromLabel: 'Claude · work',
  cwd: '/p',
  now: new Date('2026-10-05T01:00:00Z'),
  turns: Array.from({ length: 9 }, (_, i) => turn(i + 1, i === 0 ? '幫我加上登入頁' : `第 ${i} 個要求`, `做了 ${i}`)),
  lastTurn: 'complete',
  upstream: {
    sessionId: 's1', conversationId: 'c1',
    view: {
      archiveFile: '/state/dialogue/h/claude/hestia-p/c1.jsonl', transcriptFile: '/home/u/.claude/projects/p/abc.jsonl', transcriptFormat: 'jsonl',
      recapFile: '/state/dialogue/h/claude/hestia-p/c1.recap.json', lastRequest: '第 8 個要求', turns: 9, lastIndex: 9,
    },
  },
  git: {
    branch: { head: 'main', oid: 'abc', detached: false, unborn: false, upstream: 'origin/main', ahead: 2, behind: 0 },
    files: [{ path: 'web/a.ts', origPath: null, staged: null, unstaged: 'modified', submodule: false }],
    unpushed: [{ sha: '0123456789', parents: [], authorName: 'x', authorEmail: 'x', authoredAt: '', subject: 'feat: a' }],
  },
};

describe('formatMechanicalBrief', () => {
  it('says where things stand, where to pick up and where to look for more', () => {
    const text = formatMechanicalBrief(base);
    expect(text).toContain('- 原因：額度快用完（這一輪結束後交接）');
    expect(text).toContain('- 從：Claude · work → 到：Codex (原生)');
    expect(text).toContain('- 對話共 9 輪；最後一輪已經回覆完');
    expect(text).toContain('- 原本的 LLM 寫的交接：沒有（請求送到時被截斷了）');
    expect(text).toContain('用文末「上游對話紀錄在哪裡」的指令讀');
    expect(text).toContain('- 對話摘要：`/state/dialogue/h/claude/hestia-p/c1.recap.json`');
    expect(text).toContain('## 任務來源（這段對話的第一則訊息）\n\n> 幫我加上登入頁');
    expect(text).toContain('## 從哪裡接手\n\n最後一則要求是第 9 輪：\n\n> 第 8 個要求');
    expect(text).toContain('## 最後一輪的回覆（第 9 輪）\n\n> 做了 8');
    // Only the last turn is quoted; the rest is read with the command.
    expect(text).not.toContain('第 5 個要求');
    expect(text).not.toContain('做了 7');
    expect(text).toContain('- 分支：main（upstream origin/main，領先 2、落後 0）');
    expect(text).toContain('- `web/a.ts`（modified）');
    expect(text).toContain('- `01234567` feat: a');
  });

  it('points at the conversation at the end instead of copying it', () => {
    const text = formatMechanicalBrief(base);
    expect(text).not.toContain('.conversation.md');
    const where = text.slice(text.indexOf('## 上游對話紀錄在哪裡'));
    expect(text.indexOf('## 上游對話紀錄在哪裡')).toBeGreaterThan(text.indexOf('## Git 狀態'));
    expect(where).toContain(`1. \`${SHOW}\`：印出這段對話的每一輪`);
    expect(where).toContain('`--last 5`');
    expect(where).toContain('`--turns a..b`');
    expect(where).toContain('2. Hestia 的對話歸檔：`/state/dialogue/h/claude/hestia-p/c1.jsonl`');
    expect(where).toContain('3. CLI 自己的轉錄檔：`/home/u/.claude/projects/p/abc.jsonl`');
  });

  it('an interrupted last turn is called out, and so is a brief the old LLM wrote', () => {
    const text = formatMechanicalBrief({
      ...base, lastTurn: 'interrupted', handoff: { ...base.handoff, briefSource: 'self', briefNote: null },
      turns: [turn(1, '做 X', '做到一半', true)],
    });
    expect(text).toContain('最後一輪做到一半被中斷了');
    expect(text).toContain('- 原本的 LLM 寫的交接：有，在這份文件的上方');
    expect(text).toContain('## 最後一輪的回覆（第 1 輪，被中斷）');
    // Codex doesn't mark it; the handoff knows it interrupted.
    const codex = formatMechanicalBrief({ ...base, lastTurn: 'interrupted', turns: [turn(1, '做 X', '做到一半')] });
    expect(codex).toContain('## 最後一輪的回覆（第 1 輪，被中斷）');
  });

  it('no turns, no repo', () => {
    const text = formatMechanicalBrief({ ...base, turns: [], lastTurn: 'none', git: null });
    expect(text).toContain('這段對話還沒有完成的輪次');
    expect(text).toContain('（工作目錄不在 git repo 裡，或讀不到）');
    expect(text).not.toContain('## 從哪裡接手');
    expect(text).not.toContain('## 最後一輪的回覆');
    expect(text).toContain('## 上游對話紀錄在哪裡');
  });

  it('cuts a user\'s messages at a thousand characters, pointing at that turn', () => {
    const long = '要'.repeat(5000);
    const text = formatMechanicalBrief({ ...base, turns: [turn(4, long, 'y')] });
    expect(text).not.toContain('要'.repeat(LAST_REQUEST_MAX + 1));
    expect(text).toContain('要'.repeat(LAST_REQUEST_MAX));
    expect(text).toContain(`…（以下省略；完整內容：\`${SHOW} --turns 4..4\`）`);
  });

  it('quotes the end of a long last reply, where it stopped', () => {
    const reply = `開頭${'中'.repeat(5000)}停在這裡`;
    const text = formatMechanicalBrief({ ...base, lastTurn: 'interrupted', turns: [turn(3, '做 X', reply, true)] });
    expect(text).toContain('停在這裡');
    expect(text).not.toContain('開頭');
    expect(text).not.toContain('中'.repeat(LAST_REPLY_MAX));
    expect(text).toContain(`（只引最後 ${LAST_REPLY_MAX} 字；前面的內容：\`${SHOW} --turns 3..3\`）`);
  });
});

describe('formatConversationExport', () => {
  it('every turn in full, oldest first', () => {
    const text = formatConversationExport({ ...base, turns: [turn(0, 'x'.repeat(5000), 'first'), turn(1, 'second', 'done')] });
    expect(text).toContain('- 共 2 輪（舊到新）');
    expect(text).toContain('x'.repeat(5000));
    expect(text).not.toContain('以下省略');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });
});
