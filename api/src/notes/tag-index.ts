import { jsonFileStore } from '@maderaojen/json-file-store';
import { diffTags, extractTags, normalizeTag } from '../contract/tags.js';

type TagEntry = { displayText: string; projectIds: string[] };
type TagIndex = Record<string, TagEntry>;

export type TagIndexStore = {
  syncNoteTags(
    projectId: string,
    oldText: string,
    newText: string,
    projectStillUsesTag: (normalizedTag: string) => Promise<boolean> | boolean,
  ): Promise<void>;
  removeProjectFromAllTags(projectId: string): Promise<void>;
  remapSessionToProject(sessionId: string, projectId: string): Promise<void>;
  listAllTags(): Promise<{ tag: string; count: number }[]>;
  reset(): void;
};

// tag-index.json written before this field was renamed still has
// `sessionIds`, not `projectIds` — genuinely absent, not an empty array,
// so every TagEntry-consuming function here would crash on `undefined`
// the first time it touched a pre-existing entry (this is exactly what
// happened in production: remapSessionToProject's `.includes()` call blew
// up on the very first migration run). Same idea as registry.ts's own
// migrateSession() for turnsSourceFile — silently upgrade the shape the
// moment it's loaded, so every other function in this module can keep
// assuming `projectIds` always exists.
function migrateEntry(raw: TagEntry | { displayText: string; sessionIds: string[] }): TagEntry {
  if ('projectIds' in raw) return raw;
  return { displayText: raw.displayText, projectIds: raw.sessionIds };
}

// Genuinely global singular state (one tag index across every project), so
// unlike the notes store this is a single in-memory object behind a single
// persist queue — same shape as registry.ts. Where the file lives is the
// host's to say.
export function createTagIndex(options: { path: string }): TagIndexStore {
  let index: TagIndex = {};

  const file = jsonFileStore<TagIndex>({
    path: options.path,
    empty: () => ({}),
    decode: (raw) => Object.fromEntries(
      Object.entries(raw as Record<string, TagEntry | { displayText: string; sessionIds: string[] }>)
        .map(([tag, entry]) => [tag, migrateEntry(entry)]),
    ),
  });

  async function ensureLoaded(): Promise<void> {
    index = await file.load();
  }

  async function persist(): Promise<void> {
    await file.save(index);
  }

  // The notes store is the only caller, but it isn't imported here — this
  // takes a callback instead, so it stays testable with a fake and doesn't
  // need a real notes file, and to dodge the two forming a circular import.
  //
  // `projectId` is an opaque grouping key to this module; the notes store
  // passes a project id.
  async function syncNoteTags(
    projectId: string,
    oldText: string,
    newText: string,
    projectStillUsesTag: (normalizedTag: string) => Promise<boolean> | boolean,
  ): Promise<void> {
    await ensureLoaded();
    const { added, removed } = diffTags(oldText, newText);
    if (added.length === 0 && removed.length === 0) return;

    const displayByNormalized = new Map(extractTags(newText).map((t) => [normalizeTag(t), t]));

    for (const tag of added) {
      const display = displayByNormalized.get(tag) ?? tag;
      const entry = index[tag] ?? { displayText: display, projectIds: [] };
      entry.displayText = display; // newest literal casing typed wins for display
      if (!entry.projectIds.includes(projectId)) entry.projectIds.push(projectId);
      index[tag] = entry;
    }

    for (const tag of removed) {
      const entry = index[tag];
      if (!entry) continue;
      const stillUsed = await projectStillUsesTag(tag);
      if (stillUsed) continue; // another note in this same project still uses it
      entry.projectIds = entry.projectIds.filter((id) => id !== projectId);
      if (entry.projectIds.length === 0) delete index[tag];
    }

    await persist();
  }

  // 目前沒有呼叫端；為未來可能的「硬刪除專案便箋」功能保留。原本唯一呼叫它的地方
  // (notes-store.ts 的 deleteSessionNotes()) 已經被整個拿掉。
  async function removeProjectFromAllTags(projectId: string): Promise<void> {
    await ensureLoaded();
    let changed = false;
    for (const [tag, entry] of Object.entries(index)) {
      if (!entry.projectIds.includes(projectId)) continue;
      entry.projectIds = entry.projectIds.filter((id) => id !== projectId);
      changed = true;
      if (entry.projectIds.length === 0) delete index[tag];
    }
    if (changed) await persist();
  }

  // Migration helper: replaces every occurrence of `sessionId` in every tag
  // entry's projectIds array with `projectId`, de-duping if the project (via
  // another one of its sessions) already used the same tag.
  async function remapSessionToProject(sessionId: string, projectId: string): Promise<void> {
    await ensureLoaded();
    let changed = false;
    for (const entry of Object.values(index)) {
      if (!entry.projectIds.includes(sessionId)) continue;
      const withoutSession = entry.projectIds.filter((id) => id !== sessionId);
      entry.projectIds = withoutSession.includes(projectId) ? withoutSession : [...withoutSession, projectId];
      changed = true;
    }
    if (changed) await persist();
  }

  // count = number of distinct projects using the tag ("every tag ever used
  // across all sessions" per spec, now project-scoped), not a raw occurrence
  // count.
  async function listAllTags(): Promise<{ tag: string; count: number }[]> {
    await ensureLoaded();
    return Object.values(index).map((entry) => ({ tag: entry.displayText, count: entry.projectIds.length }));
  }

  function reset(): void {
    index = {};
    file.reset();
  }

  return { syncNoteTags, removeProjectFromAllTags, remapSessionToProject, listAllTags, reset };
}
