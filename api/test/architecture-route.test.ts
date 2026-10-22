import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { architectureRouter } from '../src/routes/architecture.js';

describe('GET /architecture', () => {
  let dir: string;
  const app = () => express().use('/architecture', architectureRouter(dir));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hestia-architecture-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends vision.json and the maps in name order, as they are', async () => {
    await writeFile(path.join(dir, 'vision.json'), JSON.stringify({ nodes: [{ id: 'a' }] }));
    await mkdir(path.join(dir, 'maps'));
    await writeFile(path.join(dir, 'maps', 'b.json'), JSON.stringify({ id: 'b' }));
    await writeFile(path.join(dir, 'maps', 'a.json'), JSON.stringify({ id: 'a' }));
    await writeFile(path.join(dir, 'maps', 'notes.md'), 'not a map');

    const res = await request(app()).get('/architecture');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ vision: { nodes: [{ id: 'a' }] }, maps: [{ id: 'a' }, { id: 'b' }], unreadable: [] });
  });

  it('reads the files again on every request', async () => {
    await writeFile(path.join(dir, 'vision.json'), JSON.stringify({ v: 1 }));
    expect((await request(app()).get('/architecture')).body).toEqual({ vision: { v: 1 }, maps: [], unreadable: [] });
    await writeFile(path.join(dir, 'vision.json'), JSON.stringify({ v: 2 }));
    expect((await request(app()).get('/architecture')).body).toEqual({ vision: { v: 2 }, maps: [], unreadable: [] });
  });

  it('404s without vision.json', async () => {
    const res = await request(app()).get('/architecture');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('leaves out a file that is not JSON and names it', async () => {
    await writeFile(path.join(dir, 'vision.json'), '{ "nodes": ');
    await mkdir(path.join(dir, 'maps'));
    await writeFile(path.join(dir, 'maps', 'broken.json'), '{ "id": ');
    await writeFile(path.join(dir, 'maps', 'fine.json'), '{ "id": "fine" }');

    const res = await request(app()).get('/architecture');
    expect(res.status).toBe(200);
    expect(res.body.vision).toBeNull();
    expect(res.body.maps).toEqual([{ id: 'fine' }]);
    expect(res.body.unreadable).toEqual([expect.stringMatching(/^vision\.json: /), expect.stringMatching(/^maps\/broken\.json: /)]);
  });
});
