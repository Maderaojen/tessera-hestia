// How the API says a call failed: `{ code, message }` with the HTTP status.
// `code` is what a client branches on and shows its own (localized) text
// for; `message` is the API's own wording, for logs and as the text of last
// resort when a client doesn't know the code (a newer backend). `params`
// carries the values a code's text needs.
//
// Codes are only ever added: a client must handle a code it doesn't know
// (show `message`), and a code's meaning never changes once published.

export const ERROR_CODES = [
  // Any route.
  'invalid_request',
  'not_found',
  'not_authenticated',
  'internal_error',
  'host_not_allowed',
  // The body is over its route's limit; `limit` is that limit ("5 MB").
  'request_too_large',
  // Logging in.
  'too_many_attempts',
  'credentials_required',
  'invalid_credentials',
  // Pairing a device by QR code (POST /auth/pair).
  'invalid_pairing_code',
  // The directory browser.
  'path_not_found',
  'path_not_a_directory',
  'path_forbidden',
  // Projects.
  'project_not_found',
  'inbox_rename_forbidden',
  'inbox_delete_forbidden',
  'project_has_sessions',
  'folder_not_found',
  // Sessions and what is sent to their CLI.
  'conversation_not_found',
  'subagent_not_found',
  // A turn's process (capability turn_process).
  'turn_not_found',
  'transcript_missing',
  'process_unsupported',
  'process_item_not_found',
  // A process item's image (capability process_images): no such image, or
  // its file is gone, isn't an image the app shows, or is too large.
  'process_image_not_found',
  // Transcript retention (capability transcript_retention).
  'retention_file_unreadable',
  'retention_changed',
  'session_dead',
  'pane_gone',
  'no_active_conversation',
  'no_running_cli',
  'startup_prompt_pending',
  'no_startup_prompt',
  'startup_prompt_unconfirmed',
  // A prompt the CLI is waiting on (a permission or a question) holds the
  // send; answering it failed, or it is no longer on screen.
  'interaction_pending',
  'no_interaction',
  'interaction_changed',
  'interaction_answer_invalid',
  'interaction_unconfirmed',
  'clear_in_progress',
  'nothing_to_resume',
  'upload_rejected',
  'upload_too_large',
  'upload_busy',
  'upload_quota_exceeded',
  // Launching a CLI.
  'launch_profile_invalid',
  'launch_profile_unavailable',
  'launch_unconfirmed',
  'cli_already_running',
  'runtime_unrecognized',
  'launch_config_incomplete',
  'launch_delivery_uncertain',
  'launch_cli_not_found',
  'no_launch_to_cancel',
  // A launch permission mode (permissions.ts) the runtime has no verified
  // flags for; or a native profile whose own args already set permissions,
  // so a mode would double them up.
  'permission_mode_unsupported',
  'permission_mode_conflict',
  // A mode the runtime has flags for but this host can't use now (Codex's
  // auto where its sandbox can't start).
  'permission_mode_unavailable',
  // /clear (exit and relaunch in the same tmux).
  'clear_profile_missing',
  'clear_exit_unverified',
  'clear_interrupt_unverified',
  'clear_config_incomplete',
  'clear_state_changed',
  'clear_exit_delivery_uncertain',
  'no_clear_awaiting_force',
  'clear_changed',
  'no_clear_to_cancel',
  // Recovering a dead tmux's conversation.
  'recovery_params_forbidden',
  'not_recoverable',
  'recovery_record_incomplete',
  'resume_profile_unavailable',
  'resume_transcript_missing',
  'recovery_tmux_conflict',
  'recovery_state_changed',
  'recovery_tmux_failed',
  'recovery_tmux_changed',
  'recovery_unconfirmed',
  // The session's working directory is gone, so its tmux can't be reopened there.
  'recovery_cwd_missing',
  // Switching back to an earlier conversation.
  'transition_in_progress',
  'resume_unsupported',
  'resume_profile_missing',
  'resume_transcript_unverified',
  'conversation_running',
  'switch_state_changed',
  'switch_tmux_failed',
  'switch_exit_delivery_uncertain',
  'no_switch_awaiting_force',
  'pane_reset_failed',
  'switch_changed',
  'no_switch_to_cancel',
  // The account a conversation runs on is over its usage limit.
  'resume_account_limited',
  // Switching a running CLI's model.
  'model_switch_unsupported',
  'model_list_failed',
  'model_unknown',
  'cli_busy',
  'model_switch_in_progress',
  'model_rejected',
  'model_switch_unconfirmed',
  // Closing a tmux (the app's "關閉此 tmux").
  'close_cli_busy',
  'close_exit_unverified',
  // The trash (restoring or purging a deleted session; restoring a note).
  'session_not_trashed',
  'note_not_trashed',
  // The project's files and git (read-only).
  'repo_root_unknown',
  'path_outside_project',
  'not_a_git_repo',
  'commit_not_found',
  'repo_changed',
  'git_failed',
  // A file that likely holds secrets by its name or folder (.env, keys,
  // credentials…): never sent, by the project files view or the chat's
  // file links (capability session_files).
  'path_sensitive',
  // The chat's file links: a raw file that isn't an image the app shows.
  'unsupported_media',
  // Carrying on after a usage limit (continuity).
  'handoff_in_progress',
  'no_handoff_target',
  'handoff_not_awaiting',
  'handoff_send_failed',
  'handoff_force_failed',
  // Relaunch and hand off (POST …/continuity/handoff/relaunch): no handoff
  // of this session failed with its CLI never taking over (ADR 0030).
  'handoff_not_retryable',
  // A handoff brief (GET /sessions/:id/continuity/handoffs/:handoffId/brief):
  // its file is gone; its folder or file isn't a plain one inside the
  // session's (a symlink, a name that leads elsewhere); a short id fits more
  // than one of the session's handoffs.
  'handoff_brief_missing',
  'handoff_brief_unsafe',
  'handoff_brief_ambiguous',
  // Conversation recaps: they are off (asking for one), the conversation
  // can't have one (no provider), no such item.
  'recap_disabled',
  'recap_unavailable',
  'recap_item_not_found',
  // Delegating work to another LLM (delegation.ts): an endpoint only the
  // user's login may call was called with the local tool token; the
  // delegation's state doesn't allow the action; a delivery from a worktree
  // with uncommitted changes; a caller that isn't in a tmux the app manages;
  // LLM delegation is off for that tmux; a profile the LLM may not pick; a
  // limit reached (how many at once, how deep); the target account's quota
  // too low (an LLM's, refused), or low enough that the user has to confirm
  // starting their own anyway.
  'login_required',
  'delegation_state',
  'workspace_dirty',
  'not_in_managed_tmux',
  'delegation_disabled',
  'profile_not_allowed',
  'limit_reached',
  'quota_too_low',
  'quota_low_confirm',
  // Cleaning a delegation up: its branch isn't merged, so it isn't deleted;
  // the delegate's CLI wouldn't exit, so its tmux (and worktree) stay.
  'branch_not_merged',
  'delegate_still_running',
  // Branch lines (fork.ts): the main line has no conversation with a turn
  // to fork; closing one, its CLI wouldn't exit.
  'nothing_to_fork',
  'fork_still_running',
  // Logging an account in again (POST /account-status/:accountId/login):
  // its provider can't; one is already under way (or its code is being
  // checked); the CLI never offered a sign-in link.
  'login_unsupported',
  'login_in_progress',
  'login_start_failed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Values some codes' texts need:
 * - no_running_cli, nothing_to_resume: `status` (the session's status);
 * - resume_unsupported: `provider`;
 * - upload_rejected: `allowed` (comma-separated MIME types);
 * - model_list_failed: `cli` (its name) and `reason`;
 * - model_unknown: `model`;
 * - model_rejected, model_switch_unconfirmed: `reason` (what the CLI said,
 *   or why it couldn't be confirmed);
 * - cli_busy: `activity` (the session's activity);
 * - git_failed: `reason` — timeout, unavailable (no git on the host),
 *   dubious_ownership (the repo belongs to another user) or error;
 * - handoff_send_failed: `reason` (why the message couldn't go to the CLI);
 * - resume_account_limited: `until` (ISO time the account's limit resets);
 * - delegation_state: `state` (the delegation's current state);
 * - limit_reached: `limit` ('concurrent' or 'depth') and `max`;
 * - quota_too_low, quota_low_confirm: `remaining` (percent left, or '0'
 *   when the account is over its limit) and `min`; `until` when over its
 *   limit;
 * - profile_not_allowed: `profile` (when one was named);
 * - delegate_still_running: `reason` — cli_busy (replying, can't be
 *   interrupted safely), exit_unverified (didn't exit in time) or
 *   in_transition (a launch, switch or close is going on);
 * - fork_still_running: `reason`, as delegate_still_running's.
 *
 * An optional module may answer with codes of its own, from its own
 * contract; a client that doesn't know one shows `message`, as above.
 */
export type ErrorParams = Record<string, string>;

export type ApiErrorBody = {
  code: ErrorCode;
  message: string;
  params?: ErrorParams;
  /**
   * @deprecated Contract v1: the same text as `message`, for
   * PWAs cached before error codes, which show it as-is.
   */
  error: string;
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
