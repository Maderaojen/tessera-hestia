import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../../src/types.js';
import type { ObservedPermissionModes } from '../../src/providers/permission-mode.js';

vi.mock('../../src/registry.js', () => ({ updateSession: vi.fn(async () => undefined) }));
vi.mock('../../src/sync/binding.js', () => ({ resolvedBinding: vi.fn() }));

const registry = await import('../../src/registry.js');
const { resolvedBinding } = await import('../../src/sync/binding.js');
const { toSessionDto } = await import('../../src/session-dto.js');
const { readActualPermissionMode, refreshActualPermissionMode } = await import('../../src/sync/permissionMode.js');

let observed: ObservedPermissionModes;
const readPermissionModes = vi.fn(async () => observed);

const auto = { mode: 'auto', cli: 'auto' } as const;
const plan = { mode: 'other', cli: 'plan' } as const;
const yolo = { mode: 'yolo', cli: 'bypassPermissions' } as const;

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'sess-1', tmuxName: 'h-1', status: 'ready', turnPhase: 'idle', provider: 'claude', cwd: '/work', createdAt: '2026-10-13T05:00:00.000Z',
    providerLaunchedAt: '2026-10-13T05:00:00.000Z',
    launchProfile: { id: 'p', provider: 'claude', source: 'native', delegate: { kind: 'native' } },
    ...overrides,
  } as ManagedSession;
}

beforeEach(() => {
  observed = { first: auto, last: auto };
  vi.mocked(resolvedBinding).mockReturnValue({ file: '/t.jsonl', adapter: { readPermissionModes } } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('readActualPermissionMode', () => {
  it('a CLI-default launch: changed only when the latest differs from the first recorded', async () => {
    expect(await readActualPermissionMode(session())).toEqual({ ...auto, changedInTerminal: false });
    observed = { first: auto, last: plan };
    expect(await readActualPermissionMode(session())).toEqual({ ...plan, changedInTerminal: true });
  });

  it('an auto or yolo launch: changed when the latest is not that mode', async () => {
    const launched = (permissionMode: 'auto' | 'yolo') => session({ launchProfile: { ...session().launchProfile!, permissionMode } });
    observed = { first: yolo, last: yolo };
    expect((await readActualPermissionMode(launched('yolo')))?.changedInTerminal).toBe(false);
    observed = { first: yolo, last: auto };
    expect((await readActualPermissionMode(launched('yolo')))?.changedInTerminal).toBe(true);
    expect((await readActualPermissionMode(launched('auto')))?.changedInTerminal).toBe(false);
  });

  it('nothing when no mode is recorded, no CLI runs, or the CLI has no reader', async () => {
    observed = { first: null, last: null };
    expect(await readActualPermissionMode(session())).toBeNull();
    observed = { first: auto, last: auto };
    expect(await readActualPermissionMode(session({ status: 'dead' } as Partial<ManagedSession>))).toBeNull();
    vi.mocked(resolvedBinding).mockReturnValue({ file: '/t.jsonl', adapter: {} } as never);
    expect(await readActualPermissionMode(session())).toBeNull();
  });
});

describe('refreshActualPermissionMode', () => {
  it('writes only when it changes', async () => {
    await refreshActualPermissionMode(session());
    expect(registry.updateSession).toHaveBeenCalledWith('sess-1', { actualPermissionMode: { ...auto, changedInTerminal: false } });
    vi.mocked(registry.updateSession).mockClear();

    await refreshActualPermissionMode(session({ actualPermissionMode: { ...auto, changedInTerminal: false } }));
    expect(registry.updateSession).not.toHaveBeenCalled();

    observed = { first: auto, last: plan };
    await refreshActualPermissionMode(session({ actualPermissionMode: { ...auto, changedInTerminal: false } }));
    expect(registry.updateSession).toHaveBeenCalledWith('sess-1', { actualPermissionMode: { ...plan, changedInTerminal: true } });
  });

  it('clears a stored one once it can no longer be told, and leaves an absent one alone', async () => {
    observed = { first: null, last: null };
    await refreshActualPermissionMode(session());
    expect(registry.updateSession).not.toHaveBeenCalled();
    await refreshActualPermissionMode(session({ actualPermissionMode: { ...auto, changedInTerminal: false } }));
    expect(registry.updateSession).toHaveBeenCalledWith('sess-1', { actualPermissionMode: null });
  });
});

describe('session DTO', () => {
  it('carries the actual mode and whether the terminal changed it, while the CLI runs', () => {
    const dto = toSessionDto(session({ actualPermissionMode: { ...plan, changedInTerminal: true } }));
    expect(dto.actualPermissionMode).toEqual(plan);
    expect(dto.permissionModeChangedInTerminal).toBe(true);
  });

  it('null and false when not known or the CLI is gone', () => {
    expect(toSessionDto(session())).toMatchObject({ actualPermissionMode: null, permissionModeChangedInTerminal: false });
    expect(toSessionDto(session({ status: 'dead', actualPermissionMode: { ...yolo, changedInTerminal: false } } as Partial<ManagedSession>)))
      .toMatchObject({ actualPermissionMode: null, permissionModeChangedInTerminal: false });
  });
});
