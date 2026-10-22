import { describe, expect, it, vi } from 'vitest';
import { messageFor, startNotifications } from '../src/notifications.js';
import * as sessionStream from '../src/session-stream.js';
import type { PublicManagedSession } from '../src/session-dto.js';

const session = (overrides: Partial<PublicManagedSession>): PublicManagedSession => ({
  id: 's1', cwd: '/work/app', alias: null, provider: 'claude', runtimeId: 'claude-code', turnPhase: 'idle', activity: 'idle',
  ...overrides,
} as PublicManagedSession);

describe('messageFor', () => {
  it('says a reply finished when the turn goes from replying to idle', () => {
    const message = messageFor({ phase: 'replying', activity: 'busy' }, session({ turnPhase: 'idle', activity: 'idle' }));
    expect(message).toEqual({ title: 'app', body: 'Claude Code 回覆完成', url: '/session/s1', tag: 's1:reply' });
  });

  it('asks for attention when the CLI starts waiting for a confirmation, once', () => {
    const waiting = session({ alias: '大架構', turnPhase: 'awaiting_approval', activity: 'awaiting_approval' });
    expect(messageFor({ phase: 'replying', activity: 'busy' }, waiting)?.body).toBe('Claude Code 在等你確認');
    expect(messageFor({ phase: 'awaiting_approval', activity: 'awaiting_approval' }, waiting)).toBeNull();
  });

  it('stays quiet on a first sighting, mid-reply, or when the session ends', () => {
    expect(messageFor(undefined, session({}))).toBeNull();
    expect(messageFor({ phase: 'replying', activity: 'busy' }, session({ turnPhase: 'replying', activity: 'idle' }))).toBeNull();
    expect(messageFor({ phase: 'replying', activity: 'busy' }, session({ turnPhase: 'idle', activity: 'ended' }))).toBeNull();
  });
});

describe('startNotifications', () => {
  it('sends for the session updates that call for it', async () => {
    const send = vi.fn(async () => {});
    const stop = startNotifications(send);
    try {
      sessionStream.publish('s1', { type: 'update', session: session({ turnPhase: 'replying', activity: 'busy' }) });
      sessionStream.publish('s1', { type: 'update', session: session({ turnPhase: 'idle', activity: 'idle' }) });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ body: 'Claude Code 回覆完成' }));
    } finally {
      stop();
    }
  });
});

describe('notifications for a session in the trash', () => {
  it('never notifies for a write that lands after the session was deleted', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    vi.resetModules();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'hestia-notifications-trash-'));
    vi.stubEnv('HESTIA_STATE_DIR', stateDir);
    try {
      const registry = await import('../src/registry.js');
      const notifications = await import('../src/notifications.js');
      const send = vi.fn(async () => {});
      const stop = notifications.startNotifications(send);
      try {
        const created = await registry.createSession('/work/app', 'proj-1');
        await registry.updateSession(created.id, { status: 'ready', turnPhase: 'replying', provider: 'claude', runtimeId: 'claude-code' });
        await registry.trashSession(created.id);
        // A reply finishing in a late write, after the delete.
        await registry.updateSession(created.id, { status: 'ready', turnPhase: 'idle' });
        expect(send).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
