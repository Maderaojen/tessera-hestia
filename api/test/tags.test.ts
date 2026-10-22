import { describe, expect, it } from 'vitest';
import { diffTags, extractTags, normalizeTag, stripTags } from '../src/contract/tags.js';

describe('extractTags', () => {
  it('finds ASCII tags', () => {
    expect(extractTags('fix the #login bug in #auth flow')).toEqual(['login', 'auth']);
  });

  it('finds CJK tags', () => {
    expect(extractTags('重新設計 #介面 的排版')).toEqual(['介面']);
  });

  it('dedups by normalized form, keeping first-seen casing for display', () => {
    expect(extractTags('need #UI polish, also #ui spacing')).toEqual(['UI']);
  });

  it('returns tags in first-seen order', () => {
    expect(extractTags('#b then #a then #b again')).toEqual(['b', 'a']);
  });

  it('returns an empty array when there are no tags', () => {
    expect(extractTags('just plain text')).toEqual([]);
  });
});

describe('normalizeTag', () => {
  it('lowercases', () => {
    expect(normalizeTag('UI')).toBe('ui');
    expect(normalizeTag('介面')).toBe('介面');
  });
});

describe('stripTags', () => {
  it('removes tag tokens and leaves clean text', () => {
    expect(stripTags('foo #tag bar')).toBe('foo bar');
  });

  it('removes multiple tags without leaving doubled whitespace', () => {
    expect(stripTags('#a foo #b bar #c')).toBe('foo bar');
  });

  it('handles a CJK tag inline', () => {
    expect(stripTags('重新設計 #介面 的排版')).toBe('重新設計 的排版');
  });

  it('handles text that is only tags', () => {
    expect(stripTags('#only #tags')).toBe('');
  });
});

describe('diffTags', () => {
  it('reports a newly added tag', () => {
    expect(diffTags('plain text', 'plain text #new')).toEqual({ added: ['new'], removed: [] });
  });

  it('reports a removed tag', () => {
    expect(diffTags('has #old tag', 'has tag')).toEqual({ added: [], removed: ['old'] });
  });

  it('reports no change when nothing changed', () => {
    expect(diffTags('has #same tag', 'has #same tag, edited')).toEqual({ added: [], removed: [] });
  });

  it('treats re-typing the same tag with different casing as no change', () => {
    expect(diffTags('need #UI polish', 'need #ui polish, more detail')).toEqual({ added: [], removed: [] });
  });

  it('reports both an add and a remove in the same edit', () => {
    expect(diffTags('has #old', 'has #new')).toEqual({ added: ['new'], removed: ['old'] });
  });
});
