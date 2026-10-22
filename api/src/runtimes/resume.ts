import type { ConversationSegment, ManagedSession } from '../types.js';
import { recordedRuntime, segmentRuntime } from './resolve.js';
import type { RuntimeDriver } from './types.js';

// When the app may reopen a recorded conversation, decided from the
// runtime that recorded it (RuntimeDriver.resume) — never from the product
// provider. Routes, the registry, the poller and the session DTO all ask
// here, so they agree on it.

function resumesInPlace(runtime: RuntimeDriver | undefined): runtime is RuntimeDriver & Required<Pick<RuntimeDriver, 'buildResume'>> {
  return runtime?.resume.kind === 'in_place' && !!runtime.buildResume;
}

/** The runtime that can reopen this conversation in place, if its runtime can. */
export function resumableRuntime(conversation: ConversationSegment): RuntimeDriver | undefined {
  const runtime = segmentRuntime(conversation);
  return resumesInPlace(runtime) ? runtime : undefined;
}

/**
 * Whether a dead tmux can be recovered by resuming its still-active
 * conversation. `session`: the session itself isn't a candidate (not dead,
 * no CLI recorded, something else pending, or a runtime that can't
 * resume); `conversation`: it is, but that conversation's recorded
 * binding — session id, verified transcript, launch profile — is
 * incomplete. Static checks only: whether the saved profile still runs and
 * the transcript is still on disk is verified when recovery is attempted.
 */
export function deadSessionRecovery(session: ManagedSession):
  | { ok: true; conversation: ConversationSegment; runtime: RuntimeDriver & Required<Pick<RuntimeDriver, 'buildResume'>> }
  | { ok: false; blocked: 'session' | 'conversation' } {
  const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
  const runtime = recordedRuntime(session, conversation);
  // A closed branch line or delegate (收掉): its folder is gone, so there is
  // nothing to resume in; only its record is left.
  if (session.spawnClosedAt) return { ok: false, blocked: 'session' };
  if (session.status !== 'dead' || !session.provider || session.launchPending || session.resumePending || !resumesInPlace(runtime)) {
    return { ok: false, blocked: 'session' };
  }
  const profile = conversation?.launchProfile;
  if (
    !conversation || conversation.provider !== session.provider || conversation.endedAt
    || !conversation.providerSessionId || conversation.providerSessionId !== session.providerSessionId
    || conversation.transcript.state !== 'resolved' || !conversation.transcript.file
    || !profile || profile.provider !== session.provider
  ) return { ok: false, blocked: 'conversation' };
  return { ok: true, conversation, runtime };
}
