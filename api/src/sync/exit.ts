import type { RuntimeDriver } from '../runtimes/types.js';
import * as tmuxCli from '../tmux.js';
import { sendRuntimeText } from './input.js';
import type { TurnPhase } from '../types.js';

// Time for the CLI to settle at its prompt after an interrupt.
const INTERRUPT_SETTLE_MS = 500;

/**
 * Whether this runtime can be asked to exit right now. Mid-reply, an exit
 * would be queued as a prompt or only interrupt the turn, so a runtime
 * without a verified interrupt cannot be exited safely until the reply ends.
 */
export function canRequestExit(runtime: RuntimeDriver, phase: TurnPhase | null): boolean {
  if (runtime.buildExitPlan().status !== 'supported') return false;
  return !isMidReply(phase) || !!runtime.interruptReply;
}

/**
 * Asks the running CLI to exit through its runtime's verified exit, first
 * interrupting an in-flight reply with the runtime's verified interrupt key.
 * Sends each key at most once; throws if delivery could not be confirmed.
 */
export async function requestRuntimeExit(tmuxName: string, runtime: RuntimeDriver, phase: TurnPhase | null): Promise<void> {
  const plan = runtime.buildExitPlan();
  if (plan.status !== 'supported' || !canRequestExit(runtime, phase)) throw new Error('runtime exit is not verified for this state');
  if (isMidReply(phase) && runtime.interruptReply) {
    await tmuxCli.sendKey(tmuxName, runtime.interruptReply);
    await new Promise((resolve) => setTimeout(resolve, INTERRUPT_SETTLE_MS));
  }
  if (plan.kind === 'text') await sendRuntimeText(tmuxName, runtime, plan.text);
  else await tmuxCli.sendKey(tmuxName, plan.key);
}

function isMidReply(phase: TurnPhase | null): boolean {
  return phase === 'replying' || phase === 'awaiting_approval';
}
