import path from 'node:path';

type ProjectLike = { id: string; name: string; paths: { path: string }[] };

// The projects a directory belongs to: those with a path that is the
// directory or one of its parents, closest first. Only the closest are
// returned — a project on /work/app beats one on /work — and several only
// when they share that same path.
export function projectsForDirectory<P extends ProjectLike>(projects: P[], directory: string): P[] {
  const target = path.resolve(directory);
  let best: P[] = [];
  let bestLength = -1;
  for (const project of projects) {
    for (const entry of project.paths) {
      const root = path.resolve(entry.path);
      const inside = target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
      if (!inside) continue;
      if (root.length > bestLength) {
        best = [project];
        bestLength = root.length;
      } else if (root.length === bestLength && !best.includes(project)) {
        best.push(project);
      }
    }
  }
  return best;
}
