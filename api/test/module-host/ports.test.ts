import { afterEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ value: { profileId: null as string | null, model: null as string | null, effort: null as string | null, enabled: false } }));
vi.mock('../../src/recap/wiring.js', () => ({ recap: { getSettings: vi.fn(async () => settings.value) } }));
vi.mock('../../src/notes-store.js', () => ({
  listNotes: vi.fn(async () => [{ id: 'n1', text: '買牛奶', createdAt: '2026-10-07T01:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', done: false, sessionId: null, attachmentId: null, used: false, usedAt: null, doneAt: null, uses: [] }]),
}));
const profiles = vi.hoisted(() => ({ cliProcessorProfile: vi.fn(), accountLimit: vi.fn(async () => null) }));
vi.mock('../../src/processors/cli/profiles.js', () => profiles);

const { createModuleHost } = await import('../../src/module-host/ports.js');
const { announceNotesChanged } = await import('../../src/notes-events.js');
const { inLocale } = await import('../../src/i18n/index.js');

afterEach(() => {
  vi.clearAllMocks();
  settings.value = { profileId: null, model: null, effort: null, enabled: false };
});

const CLI = { runnerDir: '/tmp/runner', timeoutMs: 1_000, logTag: 'example', tmpPrefix: 'hestia-example-' };

describe('module host', () => {
  it('runs the CLI processor on the recap settings\' account and model, whether or not recaps are on', async () => {
    const host = createModuleHost();
    expect(await host.processors.cli(CLI)).toEqual({ unavailable: 'no_profile' });
    settings.value = { profileId: 'native:codex', model: 'gpt-6-luna', effort: 'low', enabled: false };
    profiles.cliProcessorProfile.mockResolvedValue({ profile: { label: 'Codex (原生)' }, driver: {}, snapshot: {} });
    const choice = await host.processors.cli(CLI);
    if (!('processor' in choice)) throw new Error('expected a processor');
    expect(choice.model).toBe('gpt-6-luna');
    expect(await choice.processor.availability()).toEqual({ available: true, label: 'Codex (原生)', limited: null });
    expect(profiles.cliProcessorProfile).toHaveBeenCalledWith('native:codex');
  });

  it('reads a list\'s notes with only what a module needs', async () => {
    expect(await createModuleHost().notes.list('p1')).toEqual([{ id: 'n1', text: '買牛奶', createdAt: '2026-10-07T01:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', done: false }]);
  });

  it('passes on notes changing until unsubscribed', () => {
    const heard: string[] = [];
    const off = createModuleHost().notes.onChanged((projectId) => heard.push(projectId));
    announceNotesChanged('p1');
    off();
    announceNotesChanged('p2');
    expect(heard).toEqual(['p1']);
  });

  it('tells a module the language of the request, else the host\'s', () => {
    const host = createModuleHost();
    expect(host.locale()).toBe('zh-TW');
    expect(inLocale('en-US', () => host.locale())).toBe('en-US');
  });

  it('knows the inbox and not a missing project', async () => {
    const host = createModuleHost();
    expect(await host.projects.exists('inbox')).toBe(true);
    expect(await host.projects.exists('no-such-project')).toBe(false);
  });
});
