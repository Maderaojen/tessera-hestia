// Pure text-parsing rules for the notes scratchpad's tags, shared by the
// API (tag-index.ts persists what these find) and the web app (filters,
// the composer): one definition, so the two sides can't read a note's tags
// differently.

// '#' followed by one-or-more "word" characters. \w alone is ASCII-only, so
// CJK tag content (e.g. #介面) needs Unicode property escapes explicitly —
// \p{L} (letter) + \p{N} (number) + underscore covers both Latin and CJK
// without pulling in punctuation that isn't part of the tag.
const TAG_PATTERN = /#([\p{L}\p{N}_]+)/gu;

export function normalizeTag(tag: string): string {
  return tag.toLowerCase();
}

// Dedups by normalized form, first-seen order, first-seen casing kept for
// display (so typing #UI then later #ui in the same text still shows "UI").
export function extractTags(text: string): string[] {
  const seen = new Map<string, string>(); // normalized -> display
  for (const match of text.matchAll(TAG_PATTERN)) {
    const literal = match[1] as string;
    const key = normalizeTag(literal);
    if (!seen.has(key)) seen.set(key, literal);
  }
  return [...seen.values()];
}

export function stripTags(text: string): string {
  return text
    .replace(TAG_PATTERN, '')
    .replace(/[ \t]+/g, ' ') // collapse the doubled space a removed inline tag leaves behind
    .replace(/ +\n/g, '\n') // trailing space before a line break, same reason
    .trim();
}

// Normalized-tag diff between two versions of a note's text. Re-typing the
// same tag with different casing (#UI -> #ui) is neither an add nor a
// remove: a tag present (normalized) in both versions is unchanged, so this
// is plain set arithmetic on the normalized forms.
export function diffTags(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const oldTags = new Set(extractTags(oldText).map(normalizeTag));
  const newTags = new Set(extractTags(newText).map(normalizeTag));
  const added = [...newTags].filter((t) => !oldTags.has(t));
  const removed = [...oldTags].filter((t) => !newTags.has(t));
  return { added, removed };
}
