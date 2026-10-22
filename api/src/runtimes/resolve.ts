import type { ConversationSegment, ManagedSession } from '../types.js';
import { getRuntimeDriver } from './index.js';
import type { RuntimeDriver, RuntimeId } from './types.js';

/**
 * The runtime recorded for a conversation segment, else for the session's
 * active binding. Registry load already applied the documented legacy
 * mapping; this never guesses a runtime from the product provider.
 */
export function recordedRuntimeId(session: ManagedSession, conversation?: ConversationSegment | null): RuntimeId | null {
  if (conversation) return conversation.runtimeId ?? conversation.launchProfile?.runtimeId ?? null;
  return session.runtimeId ?? session.launchProfile?.runtimeId ?? null;
}

/**
 * The driver for a conversation segment (or the session's active binding),
 * only when the recorded runtime belongs to the recorded provider. A
 * mismatch or unknown runtime has no driver: callers must fail closed.
 */
export function recordedRuntime(session: ManagedSession, conversation?: ConversationSegment | null): RuntimeDriver | undefined {
  if (conversation) return segmentRuntime(conversation);
  const runtime = session.runtimeId ?? session.launchProfile?.runtimeId;
  return driverFor(runtime ?? null, session.provider);
}

/** recordedRuntime of one conversation segment, which needs nothing else. */
export function segmentRuntime(conversation: ConversationSegment): RuntimeDriver | undefined {
  return driverFor(conversation.runtimeId ?? conversation.launchProfile?.runtimeId ?? null, conversation.provider);
}

function driverFor(runtimeId: RuntimeId | null, provider: ConversationSegment['provider']): RuntimeDriver | undefined {
  const runtime = runtimeId ? getRuntimeDriver(runtimeId) : undefined;
  return runtime && runtime.provider === provider ? runtime : undefined;
}
