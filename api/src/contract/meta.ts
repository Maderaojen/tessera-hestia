import type { Provider, RuntimeId, RuntimeMeta } from './runtimes.js';

/**
 * This contract's version. Bumped only on a breaking change to what it
 * declares; additions (a field, an endpoint, an error code, a capability)
 * keep it, and are announced through `capabilities` instead.
 */
export const CONTRACT_VERSION = 1;

/**
 * Optional API features a client may rely on only when listed. A client
 * must treat an unknown string as absent, and a backend without GET /meta
 * as having none of them.
 * - error_codes: failed calls answer `{ code, message }` (errors.ts);
 * - session_list_stream: GET /sessions/events;
 * - attachments: uploads answer with an attachment, turns and notes carry
 *   theirs (attachments.ts);
 * - interrupted_flag: an interrupted reply is marked `interrupted`;
 * - conversation_clear: POST /sessions/:id/clear starts a new conversation
 *   in the tmux (the app's /clear), for a runtime with the `clear`
 *   capability;
 * - model_switch: GET /sessions/:id/models and POST /sessions/:id/model,
 *   for a runtime with the `model_switch` capability (models.ts);
 * - session_close: POST /sessions/:id/close ends a tmux after its CLI
 *   exits, keeping the record (unlike DELETE);
 * - native_push: POST /push/subscriptions also takes
 *   `{ relay: { endpoint, credential }, hostId? }` and /push/subscriptions/remove
 *   `{ credential }`, for the iOS/Android app's notifications through its
 *   push relay;
 * - repo_view: a project's files and git, read-only — GET /projects/:id/repos
 *   and /projects/:id/repo/* (repo.ts);
 * - continuity: carrying a conversation on after a usage limit —
 *   GET/PUT /continuity and /sessions/:id/continuity (continuity.ts), for a
 *   runtime with the `limit_hit` capability;
 * - session_trash: DELETE /sessions/:id moves the session to its project's
 *   trash instead of dropping it; GET /sessions/trash, and
 *   POST /sessions/:id/restore and /sessions/:id/purge.
 * - recap: conversation recaps — GET/PUT /recap/settings, GET /recap/profiles
 *   and /recap/models, GET /sessions/:id/recaps and the recap routes under
 *   /sessions/:id/conversations/:conversationId (recap.ts), and `recap`
 *   events on a session stream opened with `include=recap`.
 * - usage_analytics: metadata-only local CLI history — GET
 *   /usage-analytics/facets, /summary, /days/:date and POST /refresh.
 * - delegation: handing work to another LLM in a tmux of its own —
 *   /delegations and its actions (approve, decline, deliver, accept,
 *   reject, stop), GET/PUT /delegation and /sessions/:id/delegation
 *   (delegation.ts).
 * - fork: branch lines — /forks (list, one, preview; opening and closing
 *   one take the user's login), sessions' `fork`, the conversation start
 *   reason 'fork' (fork.ts).
 * - filesystem_search: bounded recursive directory search — GET /fs/search (fs.ts).
 * - note_trash: deleting a note puts it in its project's trash — GET
 *   /projects/:id/notes/trash and POST /projects/:id/notes/:noteId/restore
 *   (projects.ts TrashedNoteDto).
 * - repo_worktrees: a repo's worktrees for the git view — GET
 *   /projects/:id/repo/worktrees (repo.ts RepoWorktreesResponse).
 * - delegation_origin: sessions' `delegation` — a delegate's session names
 *   its delegation and where that was started (sessions.ts
 *   SessionDelegationOrigin).
 * - handoff_options: a handoff's own choices — StartHandoffRequest
 *   `briefBy` and `afterReport`, handoffSource 'incoming', the session
 *   continuity's `selfBrief`, POST /sessions/:id/continuity/handoff/dismiss
   *   (continuity.ts).
 * - handoff_brief: conversations' `handoff` (the handoff each started
 *   from), handoff events' `handoffId`, and GET
 *   /sessions/:id/continuity/handoffs/:handoffId/brief (login only;
 *   continuity.ts HandoffBriefResponse).
 * - session_timeline: conversations' `userMessagesCount`, the chat's 輪.
 * - account_login: account status `login` (when a login expires), and
 *   logging an account in again — POST /account-status/:accountId/login,
 *   POST /account-status/logins/:loginId/code, DELETE
 *   /account-status/logins/:loginId (login only;
 *   docs/reference/account-status.md).
 * - permission_modes: launch permission modes (permissions.ts) — GET/PUT
 *   /permission-modes and /sessions/:id/permission-modes, `permissionMode`
 *   on a launch, a handoff, a delegation and a branch line (login only),
 *   on conversations' launchProfile, and runtimes' `permissionModes`.
 * - session_files: the chat's file links — POST /sessions/:id/file-refs,
 *   GET /sessions/:id/files and /sessions/:id/files/raw (login only;
 *   session-files.ts); the error codes path_sensitive and
 *   unsupported_media; the project files view's tree entries' `sensitive`,
 *   and repo/file and repo/diff refusing those files (path_sensitive).
 * - composer_attachments: POST /sessions/:id/uploads takes any file up to
 *   UPLOAD_MAX_BYTES (an image as before; anything else an attachment of
 *   kind 'file', served as a download from GET
 *   /sessions/:id/uploads/:folder/:name); an upload's promptText is its
 *   path alone; POST /sessions/:id/messages takes `pastes`, and messages
 *   carry theirs (attachments.ts, sessions.ts UserMessage).
 * - handoff_relaunch: the launch guard (ADR 0030) — the session
 *   continuity's `failedHandoff`, handoffs' `deliveredAt`, `guard`,
 *   `relaunch` and `tried`, the event 'handoff_relaunched', POST
 *   /sessions/:id/continuity/handoff/relaunch and DELETE
 *   /sessions/:id/continuity/handoff/failed (continuity.ts); POST
 *   /delegations/:id/relaunch and /forks/:id/relaunch; a start's
 *   `deliveredAt` and `guard` (workspace.ts SpawnStartup).
 *
 * - process_images: a process item's detail lists its `images`, each
 *   fetched from GET /sessions/:id/conversations/:conversationId/turns/
 *   :index/process/items/:itemId/images/:image and the subagent
 *   equivalent (login only; process/images.ts); the error code
 *   process_image_not_found, and path_sensitive / unsupported_media for an
 *   image refused.
 *
 * An optional module the backend loaded (ApiMeta `modules`) adds
 * capabilities of its own, named in its own contract.
 */
export const API_CAPABILITIES = ['auth_sessions', 'error_codes', 'session_list_stream', 'attachments', 'interrupted_flag', 'conversation_clear', 'model_switch', 'session_close', 'native_push', 'repo_view', 'continuity', 'session_trash', 'recap', 'usage_analytics', 'delegation', 'fork', 'filesystem_search', 'note_trash', 'repo_worktrees', 'launch_cancel', 'delegation_origin', 'handoff_options', 'handoff_brief', 'session_timeline', 'account_login', 'permission_modes', 'turn_process', 'transcript_retention', 'session_files', 'composer_attachments', 'handoff_relaunch', 'process_images'] as const;
export type ApiCapability = (typeof API_CAPABILITIES)[number];

/** A way to start a CLI in a tmux: POST /sessions/:id/launch { profileId: id }. */
export type LaunchOption = {
  id: string;
  provider: Provider;
  runtimeId?: RuntimeId;
  label: string;
  source: 'native' | 'janus';
  // A Janus option's own profile name (the part of its label after the
  // provider), for a client that already shows which CLI it belongs to.
  profileName?: string;
  // The quota account a CLI started this way would use (session-dto.ts's quotaAccountIdFor).
  quotaAccountId?: string | null;
};

/** GET /launch-profiles. */
export type LaunchOptionCatalog = {
  profiles: LaunchOption[];
  discoveredAt: string;
  janus: { available: boolean; error: null | { code: string; message: string } };
};

/** GET /meta: who this backend is and what it can do. */
export type ApiMeta = {
  // The backend's own version (its package version).
  apiVersion: string;
  contractVersion: number;
  // ApiCapability, plus those of the optional modules loaded (modules).
  // A client treats one it doesn't know as absent.
  capabilities: string[];
  // The optional modules this backend loaded (api/modules/*), by id.
  // Absent from a backend older than modules.
  modules?: string[];
  // Every runtime this backend can drive, in presentation order.
  runtimes: RuntimeMeta[];
  // The native (non-Janus) launch options, which don't depend on discovery:
  // what a client can still offer when GET /launch-profiles fails.
  nativeLaunchOptions: LaunchOption[];
};
