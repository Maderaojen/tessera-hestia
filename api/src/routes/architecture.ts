import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { sendError } from './errors.js';

// The maintainer's own architecture map, for a page only their own build of
// the frontend has. Off unless HESTIA_ARCHITECTURE_DIR names a folder (then
// this router isn't mounted at all and the path is a plain 404); not part of
// the API contract.
//
// The folder holds `vision.json` and, optionally, `maps/*.json`. They are
// read again on every request and sent as they are, so editing a file shows
// on the next reload without a build, a deploy or a restart. The backend
// doesn't know their shape: the page that draws them checks it. A file
// that isn't JSON is left out and named in `unreadable` (with the parser's
// words), so the page can say which one to fix.
export type ArchitectureResponse = { vision: unknown; maps: unknown[]; unreadable: string[] };

type Read = { ok: true; value: unknown } | { ok: false; problem: string };

async function readJson(file: string, label: string): Promise<Read> {
  const text = await readFile(file, 'utf8');
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, problem: `${label}: ${(error as Error).message}` };
  }
}

async function mapFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(dir, 'maps'))).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function architectureRouter(dir: string): Router {
  const router = Router();
  router.get('/', async (_req, res, next) => {
    try {
      const vision = await readJson(path.join(dir, 'vision.json'), 'vision.json');
      const names = await mapFiles(dir);
      const maps = await Promise.all(names.map((name) => readJson(path.join(dir, 'maps', name), `maps/${name}`)));
      const body: ArchitectureResponse = {
        vision: vision.ok ? vision.value : null,
        maps: maps.flatMap((map) => (map.ok ? [map.value] : [])),
        unreadable: [vision, ...maps].flatMap((read) => (read.ok ? [] : [read.problem])),
      };
      res.set('Cache-Control', 'no-store').json(body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        sendError(res, 404, 'not_found', 'vision.json is not in the architecture folder');
        return;
      }
      next(error);
    }
  });
  return router;
}
