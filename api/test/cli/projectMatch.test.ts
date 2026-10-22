import { describe, expect, it } from 'vitest';
import { projectsForDirectory } from '../../src/cli/projectMatch.js';

const project = (id: string, ...paths: string[]) => ({ id, name: id, paths: paths.map((p) => ({ path: p })) });

describe('projectsForDirectory', () => {
  it('matches a project on the directory itself or any parent of it', () => {
    const projects = [project('app', '/work/app'), project('other', '/elsewhere')];
    expect(projectsForDirectory(projects, '/work/app').map((p) => p.id)).toEqual(['app']);
    expect(projectsForDirectory(projects, '/work/app/src/deep').map((p) => p.id)).toEqual(['app']);
  });

  it('prefers the closest path', () => {
    const projects = [project('outer', '/work'), project('inner', '/work/app')];
    expect(projectsForDirectory(projects, '/work/app/src').map((p) => p.id)).toEqual(['inner']);
    expect(projectsForDirectory(projects, '/work/lib').map((p) => p.id)).toEqual(['outer']);
  });

  it('returns every project sharing the closest path, and none for a stranger', () => {
    const projects = [project('a', '/work/app'), project('b', '/work/app/')];
    expect(projectsForDirectory(projects, '/work/app').map((p) => p.id)).toEqual(['a', 'b']);
    expect(projectsForDirectory(projects, '/work/application')).toEqual([]);
  });
});
