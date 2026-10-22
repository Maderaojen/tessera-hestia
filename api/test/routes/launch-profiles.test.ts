import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/launch-profiles.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/launch-profiles.js')>(),
  getLaunchProfileCatalog: vi.fn(async (refresh = false) => ({
    profiles: [{
      id: 'native:claude', provider: 'claude', label: 'Claude', source: 'native', executable: '/private/claude', args: [],
      home: '/private/home', conversationRoot: '/private/home/projects', janusExecutable: '/private/janus',
    }],
    discoveredAt: '2026-09-23T00:00:00.000Z', janus: { available: false, error: refresh ? { code: 'not_found', message: 'safe' } : null },
  })),
}));

const { launchProfilesRouter } = await import('../../src/routes/launch-profiles.js');
const profiles = await import('../../src/launch-profiles.js');
const app = express().use('/launch-profiles', launchProfilesRouter);

afterEach(() => vi.clearAllMocks());

describe('launch profile catalog route', () => {
  it('returns the cached current catalog', async () => {
    const response = await request(app).get('/launch-profiles');
    expect(response.status).toBe(200);
    expect(response.body.profiles[0].id).toBe('native:claude');
    expect(response.body.profiles[0].quotaAccountId).toBe('native:claude:default');
    expect(JSON.stringify(response.body)).not.toContain('/private');
    expect(profiles.getLaunchProfileCatalog).toHaveBeenCalledWith();
  });

  it('forces a refresh without turning Janus absence into an API failure', async () => {
    const response = await request(app).post('/launch-profiles/refresh');
    expect(response.status).toBe(200);
    expect(response.body.janus.error.code).toBe('not_found');
    expect(profiles.getLaunchProfileCatalog).toHaveBeenCalledWith(true);
  });

  it('maps Janus profiles to their own account and leaves unsupported runtimes unmapped', async () => {
    vi.mocked(profiles.getLaunchProfileCatalog).mockResolvedValueOnce({
      profiles: [
        { id: 'janus:test', provider: 'codex', label: 'Work', source: 'janus', profileName: 'work', home: '/private', conversationRoot: '/private', janusExecutable: '/private/janus' },
        { id: 'native:agy', provider: 'gemini', runtimeId: 'agy', label: 'Agy', source: 'native', executable: 'agy', args: [] },
      ],
      discoveredAt: 'now', janus: { available: true, error: null },
    });
    const response = await request(app).get('/launch-profiles');
    expect(response.body.profiles.map((profile: { quotaAccountId: string | null }) => profile.quotaAccountId)).toEqual(['janus:codex:work', null]);
    expect(response.body.profiles.map((profile: { profileName?: string }) => profile.profileName)).toEqual(['work', undefined]);
    expect(JSON.stringify(response.body)).not.toContain('/private');
  });
});
