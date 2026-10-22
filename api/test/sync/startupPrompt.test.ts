import { beforeEach, describe, expect, it, vi } from 'vitest';

const capturePane = vi.fn<(target: string) => Promise<string>>();
const sendKey = vi.fn<(target: string, key: string) => Promise<void>>(async () => {});
vi.mock('../../src/tmux.js', () => ({
  capturePane: (target: string) => capturePane(target),
  sendKey: (target: string, key: string) => sendKey(target, key),
}));
const updateSession = vi.fn(async () => undefined);
vi.mock('../../src/registry.js', () => ({ updateSession: (...args: unknown[]) => updateSession(...(args as [])) }));

const { agyRuntime } = await import('../../src/runtimes/agy.js');
const { answerStartupPrompt, refreshStartupPrompt, startupPromptPossible } = await import('../../src/sync/startupPrompt.js');

// Agy 1.2.10's prompt (test/fixtures/startup-prompts/agy.trust.1.2.10.txt). How
// each runtime's prompt is read is tested in runtimes-startup-prompt.test.ts.
const trustPrompt = (selected: 'trust' | 'decline') => [
  'Accessing workspace:',
  '/tmp/agytrust.wTp3',
  'Do you trust the contents of this project?',
  'Antigravity CLI requires permission to read, edit, and execute files here.',
  selected === 'trust' ? '> Yes, I trust this folder' : '  Yes, I trust this folder',
  selected === 'decline' ? '> No, exit' : '  No, exit',
  '  ↑/↓ Navigate · enter Confirm',
].join('\n');
const inputBox = '> \n──────\n? for shortcuts                accept-edits · Gemini 3.8 Flash';

beforeEach(() => {
  capturePane.mockReset();
  sendKey.mockClear();
  updateSession.mockClear();
});

describe('answerStartupPrompt', () => {
  it('confirms at once when the wanted option is already selected', async () => {
    capturePane.mockResolvedValueOnce(trustPrompt('trust'));
    expect(await answerStartupPrompt('t', agyRuntime, 'trust')).toBe('answered');
    expect(sendKey.mock.calls).toEqual([['t', 'Enter']]);
  });

  it('moves, re-reads, and confirms only once the wanted option is under the cursor', async () => {
    capturePane.mockResolvedValueOnce(trustPrompt('trust')).mockResolvedValueOnce(trustPrompt('decline'));
    expect(await answerStartupPrompt('t', agyRuntime, 'decline')).toBe('answered');
    expect(sendKey.mock.calls).toEqual([['t', 'Down'], ['t', 'Enter']]);
  });

  it('never presses Enter when the selection cannot be confirmed', async () => {
    capturePane.mockResolvedValue(trustPrompt('trust')); // the cursor never moves
    expect(await answerStartupPrompt('t', agyRuntime, 'decline')).toBe('unsure');
    expect(sendKey.mock.calls.every(([, key]) => key !== 'Enter')).toBe(true);

    sendKey.mockClear();
    capturePane.mockResolvedValue(trustPrompt('trust').replace('> Yes', '  Yes'));
    expect(await answerStartupPrompt('t', agyRuntime, 'trust')).toBe('unsure');
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('reports a prompt that is not on screen without sending anything', async () => {
    capturePane.mockResolvedValueOnce(inputBox);
    expect(await answerStartupPrompt('t', agyRuntime, 'trust')).toBe('not_shown');
    expect(sendKey).not.toHaveBeenCalled();
  });
});

describe('refreshStartupPrompt / startupPromptPossible', () => {
  const session = { id: 's', tmuxName: 't', status: 'ready', clearPending: null, startupPrompt: null } as never;
  const pendingTranscript = { transcript: { state: 'pending' } } as never;
  const resolvedTranscript = { transcript: { state: 'resolved' } } as never;

  it('only looks while a prompt can still be on screen', () => {
    expect(startupPromptPossible(session, pendingTranscript, agyRuntime)).toBe(true);
    expect(startupPromptPossible(session, resolvedTranscript, agyRuntime)).toBe(false);
    expect(startupPromptPossible({ ...(session as object), startupPrompt: { kind: 'workspace_trust', detectedAt: 'x' } } as never, resolvedTranscript, agyRuntime)).toBe(true);
    expect(startupPromptPossible(session, pendingTranscript, { ...agyRuntime, readStartupPrompt: undefined })).toBe(false);
  });

  it('records the prompt when it appears and clears it once it is gone, writing only on change', async () => {
    capturePane.mockResolvedValueOnce(trustPrompt('trust'));
    expect(await refreshStartupPrompt(session, agyRuntime)).toMatchObject({ kind: 'workspace_trust', selected: 'trust' });
    expect(updateSession).toHaveBeenCalledWith('s', { startupPrompt: { kind: 'workspace_trust', detectedAt: expect.any(String) } });

    updateSession.mockClear();
    const recorded = { ...(session as object), startupPrompt: { kind: 'workspace_trust', detectedAt: 'x' } } as never;
    capturePane.mockResolvedValueOnce(trustPrompt('trust'));
    await refreshStartupPrompt(recorded, agyRuntime);
    expect(updateSession).not.toHaveBeenCalled();

    capturePane.mockResolvedValueOnce(inputBox);
    expect(await refreshStartupPrompt(recorded, agyRuntime)).toBeNull();
    expect(updateSession).toHaveBeenCalledWith('s', { startupPrompt: null });
  });
});

describe('startupPromptPossible for Codex', async () => {
  const { codexCliRuntime } = await import('../../src/runtimes/codex-cli.js');

  it('is only looked for while the conversation has no transcript yet', () => {
    const session = { status: 'ready', clearPending: null, startupPrompt: null } as never;
    expect(startupPromptPossible(session, { transcript: { state: 'pending' } } as never, codexCliRuntime)).toBe(true);
    expect(startupPromptPossible(session, { transcript: { state: 'resolved' } } as never, codexCliRuntime)).toBe(false);
  });
});
