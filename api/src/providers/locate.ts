import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Recursively lists every file under `root` whose basename matches
// `predicate`. Used for providers (Codex, Gemini) that don't let us pin a
// session id at launch, so the only way to find "the transcript we just
// created" is to look at everything and pick the newest.
export async function walkFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && predicate(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

export async function newestFileSince(files: string[], sinceMs: number): Promise<string | null> {
  let best: { file: string; mtimeMs: number } | null = null;
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      continue; // disappeared mid-scan
    }
    if (mtimeMs < sinceMs) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
  }
  return best?.file ?? null;
}
