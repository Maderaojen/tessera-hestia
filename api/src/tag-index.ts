import { TAG_INDEX_PATH } from './config.js';
import { createTagIndex } from './notes/tag-index.js';

// Hestia's tag index (notes/tag-index.ts) at this backend's path. Kept at
// this path so its callers and the tests that mock it don't change.
const tags = createTagIndex({ path: TAG_INDEX_PATH });

export const { syncNoteTags, removeProjectFromAllTags, remapSessionToProject, listAllTags } = tags;

export async function __resetForTests(): Promise<void> {
  tags.reset();
}
