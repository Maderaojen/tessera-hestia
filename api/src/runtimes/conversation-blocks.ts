import type { ErrorCode, ErrorParams } from '../contract/errors.js';
import { t } from '../i18n/index.js';
import { segmentRuntime } from './resolve.js';
import { resumableRuntime } from './resume.js';
import type { ConversationSegment } from '../types.js';

// Why a conversation can't be continued in its tmux, or null if it can:
// its runtime must reopen conversations in place (RuntimeDriver.resume —
// only Claude Code today: `claude --resume <id>` keeps appending to the
// same transcript file, verified against 2.1.281; only --fork-session
// starts a new id), and the segment must have kept what that needs.
export function conversationResumeBlocked(conversation: ConversationSegment): { code: ErrorCode; message: string; params?: ErrorParams } | null {
  if (!resumableRuntime(conversation)) {
    const provider = conversation.provider ?? t('session.resume.unsupportedThis');
    return { code: 'resume_unsupported', message: t('session.resume.unsupported', { provider }), params: { provider } };
  }
  if (!conversation.providerSessionId || !conversation.launchProfile || conversation.launchProfile.provider !== conversation.provider) {
    return { code: 'resume_profile_missing', message: t('session.resume.profileMissing') };
  }
  if (conversation.transcript.state !== 'resolved' || !conversation.transcript.file) {
    return { code: 'resume_transcript_unverified', message: t('session.resume.transcriptUnverified') };
  }
  return null;
}

/**
 * Why a branch line can't fork this conversation natively (ADR 0023 決策
 * 3), or null if it can: its runtime has no verified fork
 * ('runtime_unsupported'), or the segment lacks what a fork needs — the
 * CLI's own id, a launch profile of its provider, a verified transcript
 * ('conversation_unforkable'). A branch line then gets a brief instead.
 */
export function conversationForkBlocked(conversation: ConversationSegment): 'runtime_unsupported' | 'conversation_unforkable' | null {
  if (!segmentRuntime(conversation)?.fork) return 'runtime_unsupported';
  if (!conversation.providerSessionId || !conversation.launchProfile || conversation.launchProfile.provider !== conversation.provider) {
    return 'conversation_unforkable';
  }
  if (conversation.transcript.state !== 'resolved' || !conversation.transcript.file) return 'conversation_unforkable';
  return null;
}
