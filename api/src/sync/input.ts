import type { RuntimeDriver } from '../runtimes/types.js';
import * as tmuxCli from '../tmux.js';

/**
 * Types text into a running CLI and submits it, pausing in between for as
 * long as that runtime says its input box needs. Without a known runtime
 * (or one that hasn't measured it) tmux's shared default applies. A
 * runtime whose input box wants pasted text (RuntimeDriver.textInput) gets
 * it as one bracketed paste — except a slash command, which is always
 * typed so the CLI reads it as a command, not as text.
 */
export function sendRuntimeText(tmuxName: string, runtime: RuntimeDriver | undefined, text: string): Promise<void> {
  const send = runtime?.textInput === 'paste' && !text.startsWith('/') ? tmuxCli.pasteText : tmuxCli.sendText;
  return runtime?.submitDelayMs === undefined
    ? send(tmuxName, text)
    : send(tmuxName, text, runtime.submitDelayMs);
}

/**
 * The key the stop button sends to interrupt a reply. A runtime's verified
 * interruptReply when it has one. For one without (Agy, legacy Gemini CLI,
 * an unresolvable legacy record) the button has always sent Escape; that is
 * kept rather than turning stop into an error, but it is unverified — the
 * one place that still assumes Claude's key.
 */
export function stopKeyFor(runtime: RuntimeDriver | undefined): 'Escape' {
  return runtime?.interruptReply ?? UNVERIFIED_STOP_KEY;
}

const UNVERIFIED_STOP_KEY = 'Escape';
