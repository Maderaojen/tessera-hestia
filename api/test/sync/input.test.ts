import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendText = vi.fn(async (..._args: unknown[]) => {});
const pasteText = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../src/tmux.js', () => ({
  sendText: (...args: unknown[]) => sendText(...args),
  pasteText: (...args: unknown[]) => pasteText(...args),
}));

const { sendRuntimeText, stopKeyFor } = await import('../../src/sync/input.js');
const { claudeCodeRuntime } = await import('../../src/runtimes/claude-code.js');
const { codexCliRuntime } = await import('../../src/runtimes/codex-cli.js');
const { agyRuntime } = await import('../../src/runtimes/agy.js');
const { geminiCliRuntime } = await import('../../src/runtimes/gemini-cli.js');

beforeEach(() => { sendText.mockClear(); pasteText.mockClear(); });

describe('sendRuntimeText', () => {
  it("pastes for a runtime that wants pasted text, with its own measured submit delay", async () => {
    await sendRuntimeText('t', codexCliRuntime, 'hi\nthere');
    expect(pasteText).toHaveBeenCalledWith('t', 'hi\nthere', 100);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('still types a slash command, so the CLI reads it as a command', async () => {
    await sendRuntimeText('t', codexCliRuntime, '/model');
    expect(sendText).toHaveBeenCalledWith('t', '/model', 100);
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('leaves tmux its shared default when the runtime has not measured one', async () => {
    await sendRuntimeText('t', claudeCodeRuntime, 'hi');
    await sendRuntimeText('t', undefined, 'hi');
    expect(sendText.mock.calls).toEqual([['t', 'hi'], ['t', 'hi']]);
    expect(pasteText).not.toHaveBeenCalled();
  });
});

describe('stopKeyFor', () => {
  it("uses the runtime's verified interrupt key", () => {
    expect(claudeCodeRuntime.interruptReply).toBe('Escape');
    expect(stopKeyFor(claudeCodeRuntime)).toBe('Escape');
    expect(stopKeyFor(codexCliRuntime)).toBe('Escape');
  });

  it('keeps the historical Escape for runtimes without a verified interrupt', () => {
    expect(agyRuntime.interruptReply).toBeUndefined();
    expect(geminiCliRuntime.interruptReply).toBeUndefined();
    expect(stopKeyFor(agyRuntime)).toBe('Escape');
    expect(stopKeyFor(undefined)).toBe('Escape');
  });
});
