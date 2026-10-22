import { describe, expect, it } from 'vitest';
import { branchName, defaultTitle, slugify, worktreeFolderName } from '../../src/spawn/naming.js';

describe('spawn naming', () => {
  it('takes a title from the first line\'s first clause, cut to 32 columns (a CJK character is two)', () => {
    expect(defaultTitle('  Try another layout\nmore')).toBe('Try another layout');
    expect(defaultTitle('開一條支線的modal內部設計有點亂，需要參考交接的設計，並且modal在出現ime時會超出畫面')).toBe('開一條支線的modal內部設計有點亂');
    expect(defaultTitle('Fix the login. Then the logout')).toBe('Fix the login');
    expect(defaultTitle('Bump to v1.2 and ship')).toBe('Bump to v1.2 and ship');
    expect(defaultTitle('好，依你建議調整')).toBe('好，依你建議調整');
    expect(defaultTitle('y'.repeat(40))).toBe(`${'y'.repeat(31)}…`);
    expect(defaultTitle('把狀態輸出全部改成機器可以讀的格式而且要相容舊版')).toBe('把狀態輸出全部改成機器可以讀的…');
    expect(defaultTitle('')).toBe('');
  });

  it('slugs only the ASCII words', () => {
    expect(slugify('Try Another Layout!')).toBe('try-another-layout');
    expect(slugify('換個版面')).toBe('');
  });

  it('names a delegation\'s and a branch line\'s branch apart', () => {
    expect(branchName('delegate', 'ab12cd34', 'Fix login')).toBe('delegate/ab12cd34-fix-login');
    expect(branchName('fork', 'ab12cd34', 'Try another layout')).toBe('fork/ab12cd34-try-another-layout');
    expect(branchName('fork', 'ab12cd34', '換個版面')).toBe('fork/ab12cd34');
  });

  it('names the worktree folder beside the repo by kind', () => {
    expect(worktreeFolderName('delegate', 'hestia', 'ab12cd34')).toBe('hestia-delegate-ab12cd34');
    expect(worktreeFolderName('fork', 'hestia', 'ab12cd34')).toBe('hestia-fork-ab12cd34');
  });
});
