# API contract v1

- Updated: 2026-10-19
- 中文: [api-contract-v1.md](api-contract-v1.md)

## Goal

One definition of what the API looks like, shared by frontend and backend; a public frontend can negotiate with backends of different versions; errors and states are no longer expressed as zh-TW strings.

## Where the contract lives

`api/src/contract/`: plain TypeScript with no runtime dependencies, importing nothing outside that folder (`api/test/contract.test.ts` checks this).

An optional module (`api/modules/*`, see [the architecture](architecture.en.md)) has a contract of its own, in its own folder; it isn't in this document or in the public release.

| File | Contents |
|---|---|
| `runtimes.ts` | `Provider`, `RuntimeId`, the runtimes' display-name table, runtime capability names |
| `sessions.ts` | Session / conversation / turn DTOs, `SessionListEvent`, the legacy fields (`LegacySessionDto`) |
| `projects.ts` | The inbox id (the app names the inbox in its own language by the id), project / note DTOs, the create-note request |
| `attachments.ts` | Attachments, the upload response, attachment ranges within a message |
| `errors.ts` | Error codes and the shape of an error response |
| `meta.ts` | The contract version, API capability names, the shape of `GET /api/meta`, launch options |
| `tags.ts` | Note tag parsing rules (formerly one copy each in frontend and backend) |
| `pairing.ts` | The format of `hestia pair`'s pairing links (the web link and the app deep link), and parsing them |
| `repo.ts` | A project's files and git, read-only: each project path's git state, uncommitted files, unpushed commits, diffs, commit details, the file tree and file contents, the local branches' history |

**Why under `api/`, not a `contract/` package at the repo root**: the API compiles with `tsc` with `rootDir` at `api/`, and the output `dist/src/main.js` is written into the systemd unit, the installer and `bin/hestia`. Outside `api/`, the compiled output's folder structure would change; as a separate package, every deployment would first build the package and then `npm install`. In `api/src/contract/`, the API build doesn't change at all; the frontend imports the same source and bundles it, with no extra build step.

- On the API side, `toSessionDto`, `toPublicManagedSession` and `toPublicConversation` all return the contract's types, so any mismatch in fields fails to compile.
- The frontend's `api.ts` keeps names such as `ManagedSession`, `Turn` and `NoteRecord`, but their types all come from the contract.

## `GET /api/meta`

Requires sign-in (like the rest of the API). Returns:

```json
{
  "apiVersion": "0.1.0",
  "contractVersion": 1,
  "capabilities": ["error_codes", "interrupted_flag", "session_list_stream", "attachments", "conversation_clear", "repo_view"],
  "modules": [],
  "runtimes": [{ "id": "claude-code", "provider": "claude", "label": "Claude Code", "capabilities": ["resume", "clear", "interrupt", "startup_prompt", "quota", "janus", "subagents"] }],
  "nativeLaunchOptions": [{ "id": "native:claude", "provider": "claude", "runtimeId": "claude-code", "label": "Claude (原生)", "source": "native" }]
}
```

- `runtimes` comes from the runtime drivers: the display name is the driver's `label`, and the capabilities are derived from what the driver declares (the `resume` capability, a verified way to exit, an interrupt key, startup-prompt recognition, quota, Janus, subagents).
- `nativeLaunchOptions` holds no executable paths or arguments.
- `modules` lists the ids of the optional modules this backend loaded at startup (`api/modules/*`; an empty list when none). `capabilities` holds Hestia's own features (`API_CAPABILITIES`) plus those each loaded module declares; a module's capabilities are written in its own contract. A backend older than `modules` doesn't send the field: treat it as having loaded none.
- `contractVersion` goes up only for incompatible changes; new fields, endpoints, error codes or features leave it alone and are declared in `capabilities` instead. The frontend treats any capability it doesn't recognize as absent.

### How the frontend uses it

The web frontend caches meta in memory per host id, loads it once after sign-in is confirmed (`shell/authState.ts`, `LoginView`), and only reads it while rendering, never sending a request.

| Use | With meta | Without meta (an older backend answers 404, or not loaded yet) |
|---|---|---|
| Runtime display names | The backend's `label` | The contract's name table, else the provider |
| Fallback options in the launch panel (when the catalog fails to load) | `nativeLaunchOptions` | No options; the error becomes "couldn't load launch options" |
| Subagent bubbles | Asked only for runtimes with the `subagents` capability | Always asked (the backend returns an empty list for CLIs without subagents) |
| Home list | Uses the stream when `session_list_stream` is present | Keeps polling every 5 seconds |
| "New conversation" in the conversation title menu | Shown only when the backend has `conversation_clear` (`POST /sessions/:id/clear`; when an old CLI doesn't exit in time, `clearPending.phase` is `awaiting_force`, and `POST …/clear/force` or `…/clear/cancel` follow) and the runtime has `clear` | Not shown (`/clear` can still be sent from the input box) |
| Notifications in the iOS/Android app | Can be turned on when the backend has `native_push` (see "The app's push subscriptions" below) | Settings › Notifications says the host is too old; the switch is disabled |
| A project's "changes and Git" | Offered from the chat header, the project's ⋯ menu and the desktop tool pane only when the backend has `repo_view` (see "A project's files and Git" below) | Not offered |
| Deleting a session, and the "trash" | When the backend has `session_trash`, the delete confirmation says the session goes to the trash; the sidebar has every project's "Trash", and the project's ⋯ menu that project's (see "Session trash" below) | Keeps the "can't be recovered" confirmation; no trash |
| Conversation recaps | When the backend has `recap`, Settings › Host & automation has a "Conversation recaps" section, a session row's ⋯ menu has "View recap", and both session stream URLs add `include=recap` (see "Conversation recaps" below) | No recap entry points or settings |

The four fallback launch options formerly hard-coded in the frontend were removed.

## Pairing links

The links `hestia pair` prints (and puts in its QR code), with the format defined in `contract/pairing.ts`:

| Kind | Format | Opened by |
|---|---|---|
| `web` | `https://<web frontend>/login?mode=add&url=<backend address>#pair=<code>` | The web frontend's `LoginView` |
| `app` | `hestia://pair?url=<backend address>#code=<code>` | The native app (registering the `hestia` scheme) |

- The backend address is in the query (`encodeURIComponent`), and the one-time pairing code after the `#`: browsers never send the fragment to any server.
- The endpoint that trades the code for a token is still `POST /auth/pair`. Its body may also carry an optional `device` (a string of up to 200 characters, of which the backend keeps the first 80 printable ones): the phone's name, used only for `hestia pair` to show who used the code; older backends ignore it.
- A pairing code is valid for 3 minutes (10 minutes before 2026-10-03) and usable once.
- After printing the QR code, `hestia pair` waits for the code to be used, through two endpoints only the local CLI can call (like `POST /auth/pairing-code`: the local tool token, over a direct local connection):
  - `POST /auth/pairing-code/status`, body `{ code }` → `{ status: 'pending', expiresInMs }`, `{ status: 'used', usedAt, device }` (`device` may be `null`) or `{ status: 'expired' }` (an unknown code also reads `expired`).
  - `POST /auth/pairing-code/revoke`, body `{ code }` → `{ ok: true, revoked }`: signs out the login that code was traded for (a used code is remembered for 1 hour).
- **Opening a link must not pair by itself**: the backend's full origin is shown first, and `POST /auth/pair` is called only once the user confirms; cancelling discards the code (the web frontend already does this; the app must keep the same confirmation step). Anyone can send such a link, and pairing automatically would let them add you to their backend.
- `parsePairingLink()` recognizes both kinds, and the app's built-in scanner accepts both: `hestia pair` prints the web link by default. A link scanned in the app's "Add host" goes through the same confirmation; one scanned at an SSH host's "Sign in to Hestia" step gives only its code, paired straight through the tunnel (the address in the link is ignored).
- Which kind the CLI prints: `hestia pair --link web|app|both`, defaulting to `HESTIA_PAIR_LINK` in `.env`, then `web` (`docs/guides/install.en.md`).
- These are all new formats, endpoints and optional fields; no existing endpoint or field changed, so `contractVersion` stays 1. From here the format only gains parameters and never renames them: old links must always stay readable by newer frontends and apps.

## Error codes

Every error response goes through `sendError` in `api/src/routes/errors.ts`:

```json
{ "code": "session_dead", "message": "session is dead", "params": {}, "error": "session is dead" }
```

- `code` is defined in `contract/errors.ts`; codes are only added, never change meaning.
- `message` is the backend's own text, for logs and as the fallback when the frontend doesn't recognize the code. Messages only ever sent over HTTP are English; those the backend also uses as status or notification text (why a launch, a recovery or a conversation switch failed, say) are in the request's language (see "Response language" below).
- `params` carries values the text needs (for example `status` for `no_running_cli`, `provider` for `resume_unsupported`).
- `error` holds the same as `message`, **only for old PWAs still in caches** (they show that field directly).
- The web frontend maps codes to zh-TW text with a `Record<ErrorCode, …>`, so a code added to the contract without text fails to compile. Messages that were already Chinese were kept word for word; English ones (for example `session is dead`, `incorrect username or password`) became Chinese.
- `ApiError` carries `status`, `code` and `params`; a caller showing `err.message` shows the localized text.
- Why a conversation can't continue (`ConversationSummary.resumeBlockedReason`) also comes as `resumeBlocked: { code, params }`, which the frontend likewise shows by code.

`api/test/contract.test.ts` scans `api/src` to make sure no route returns a bare `{ error }` again.

### Response language

- A request's `Accept-Language` picks the language of the text meant for people in the response (`zh*` Traditional Chinese, `en*` English; otherwise, or without one, the host's language). The web frontend sends its interface language on every request; the header needs no CORS allowance, so older backends take it unchanged.
- The host's language: the one sent by requests carrying `Authorization: Bearer` (the app's own API client), kept in `interface-locale.json` in the state directory, Traditional Chinese by default. The backend writes the text it makes with no request in it: notifications, a session's `lastError`, handoff and delegation status and reasons, account usage errors.
- Text written for an LLM or typed into a CLI (handoff briefs, delegation and branch line briefs, the recap prompt, the line a handoff or delegation types into tmux, delegation records) does not follow the language: it is always Chinese.

## String states became fields

### The stuck hint: `stuckSince`

- It used to be a Chinese sentence written into `lastError`, which `deriveSessionActivity` then compared word for word. Now it is `ManagedSession.stuckSince`, set and cleared by the turn machine's `set_stuck_hint` / `clear_stuck_hint`; `clear_last_error` still clears both (meaning: clear every hint shown on screen).
- Any real lifecycle transition clears `stuckSince` (except rolling back to the same CLI), matching the old effect of "writing `lastError` overwrites the hint".
- `lastError` is kept for real errors only.
- Registry schema **v2**: old records whose `lastError` equals that sentence become `stuckSince`.

### Interrupted replies: `assistant.interrupted`

- The Claude parser used to write `（已中斷）` into the reply text, and the import after a stop checked it with `endsWith`. Now the turn carries `assistant.interrupted: true`, and the text keeps only what was produced.
- A change to the interrupted flag alone, with the text unchanged, still counts as an updated turn (both `diffTurns` and `turnsFingerprint` reflect it).
- Registry schema **v3**: stored turns (those in conversations and the mirror on the session) lose the trailing marker and gain the flag.
- The dialogue archive is written with clean text and the flag from now on; records already written are left alone.
- The frontend's `lib/replyText.ts` decides how to show it (currently exactly as before: the content followed by `（已中斷）`).

## CLI prompts waiting for an answer: `PendingInteraction.screen`

- `pendingInteraction` gained `kind: 'question'` (AskUserQuestion) and an optional `screen: InteractionScreen`: what was read off the CLI's screen (`kind` is `permission` / `question` / `review`, a title, a description, options, whether several can be chosen, progress through the questions). Only Claude Code provides it for now; without `screen`, the frontend keeps the old card (arrow keys, look at the terminal).
- For a prompt read only from the screen (Claude Code 2.1.284 writes nothing to the transcript while it waits), `toolUseId` is `pane:<hash>` and `input` is `null`. When the screen moves to the next question or a box is ticked, `toolUseId` changes with it.
- `POST /api/sessions/:id/interaction`, body `{ promptId, option, text? }`: `promptId` is the `toolUseId` seen at the time, `option` an option number or `'next'` (the "Next" of a multi-select question), and `text` fills a free-text row or a permission's note. Success returns the session; error codes are `no_interaction`, `interaction_changed`, `interaction_answer_invalid` and `interaction_unconfirmed`.
- While a prompt waits, `POST /messages` and `/clear` answer 409 `interaction_pending` rather than typing text plus Enter into the prompt (Enter on a permission prompt approves it outright).
- Compatibility: an old frontend receiving `interaction_pending` shows the backend's Chinese message; a new frontend facing an old backend without `screen` is blocked from sending the same way, and answers with arrow keys or the terminal instead.

## Slimmer DTOs and the list stream

- New `SessionDto.lastActivityAt` (the time of the active conversation's last reply or message, else the last send, else creation); the list is sorted by it.
- `toSessionDto` is contract v1's session DTO, without deprecated fields; `toPublicManagedSession` is that plus the legacy fields, and every existing endpoint keeps sending that version.
- `GET /api/sessions/events`: on connecting it sends `{ type: 'snapshot', sessions }`, then an `update` / `deleted` (and, on backends with `session_trash`, `restored`) for every change, carrying the slim DTO (no turns). It subscribes before reading the list, and events that arrive during the read are sent after the snapshot, so nothing is missed. When EventSource reconnects, it gets a snapshot again. A stream ticket can open this stream.
- When meta declares `session_list_stream`, the frontend list uses the stream and no longer polls `GET /sessions` every 5 seconds; projects are still read every 5 seconds (they are small), plus once more when a session belongs to an unknown project.
- The frontend no longer reads `status`, `claudeClearPending` or the turns on a session at all, and calls `/recover` instead.

## Attachments

- An upload returns `{ attachment: { id, kind, url, promptText }, path }`. `id` is `<folder>/<file name>`, `url` a path relative to the API root, and `promptText` the text that has the CLI read the image, decided by the backend. Other files and pasted text: see "The composer's attachments" below.
- `api/src/attachments.ts` builds file paths itself, rejects any id that could lead outside `UPLOADS_DIR`, and keeps the only image-type table (formerly one each in `config.ts` and `uploads.ts`).
- In the turns sent, every message carries `attachments: [{ id, kind, url, start, end }]`, where `start` / `end` are the path's position in the text. They are recognized when sent, not stored, so old messages have them too.
- Notes now store `attachmentId`; an old record's `imagePath` becomes an attachment id when read (a path that matches no uploaded file is kept as it is, not dropped). Creating a note accepts `attachmentId`, and also `imagePath` from old frontends; both must point at this backend's own uploads, or it answers 400.
- In the web frontend, only the attachment handling still knows the old text (`請看這張圖片：`) and the old folder layout, used only for old backends and for a message just sent that the backend hasn't described yet.

## The app's push subscriptions: `native_push`

The iOS/Android app's WebView has no Web Push, so the app goes through a push relay run by its publisher (on to FCM, and from FCM to Apple). The backend doesn't know where the relay is and needs no setup: the URL comes from the app with the subscription.

- `POST /api/push/subscriptions` also takes `{ "relay": { "endpoint": "<https URL>", "credential": "<1–2048 characters>" }, "hostId"?: string }`. `endpoint` must be `https:`; subscriptions are deduplicated by `credential`. The Web Push body is unchanged.
- `POST /api/push/subscriptions/remove` also takes `{ "credential": "<string>" }`; the `{ "endpoint" }` form is unchanged.
- To notify, the backend sends `POST { "credential", "message": { "title", "body", "url", "tag" } }` to `endpoint` (`url` carries `?host=` as with Web Push), with a 10-second timeout. On `404`/`410` it deletes the subscription; a timeout, `5xx` or any other failure is only logged and the subscription is kept for the next message.
- To the backend, `credential` is an opaque string, not to be parsed. Like a Web Push `endpoint`, it amounts to permission to notify that phone, and is stored with the other subscriptions in a file only this user can read.

## A project's files and Git (read-only): `repo_view`

A look at the files and git under a project: what isn't committed, what isn't pushed, what a file changed, what a commit holds, what a folder has in it, what a file says, the local branches' history. Everything is a `GET`; nothing writes to the repo, fetches, or takes a git lock.

| Endpoint | Query | Answers (`contract/repo.ts`) |
|---|---|---|
| `GET /api/projects/:id/repos` | – | `RepoRootsResponse`: each of the project's paths and its git state (a non-repo or a folder gone are listed too) |
| `GET /api/projects/:id/repo/status` | `root` | `RepoStatus`: the branch and how far ahead/behind its upstream, uncommitted files, unpushed commits, when it last fetched |
| `GET /api/projects/:id/repo/diff` | `root`, `path`, `orig?`, `mode=worktree｜staged｜unstaged｜commit`, `commit?` | `RepoDiff`: one file's diff, split into hunks with both sides numbered |
| `GET /api/projects/:id/repo/commit` | `root`, `sha` | `RepoCommitDetail`: the whole message, author, time, and the files against its first parent |
| `GET /api/projects/:id/repo/tree` | `root`, `dir=''`, `ignored=0｜1` | `RepoTreeListing`: one folder's entries (folders first); gitignored ones are marked `ignored`, and left out with `ignored=0` |
| `GET /api/projects/:id/repo/file` | `root`, `path`, `rev?` | `RepoFileContent`: one file's text; with `rev` (`HEAD` or a sha), as that commit had it — e.g. a deleted file |
| `GET /api/projects/:id/repo/log` | `root`, `cursor?`, `limit=200` (at most 500) | `RepoLogPage`: the local branches' (and a detached HEAD's) commits, topological order, newest first, a page at a time; the first page carries `refs` (`RepoRefs`) |
| `GET /api/projects/:id/repo/worktrees` | `root` | `RepoWorktreesResponse`: every worktree of the repo `root` is in (the main one first): its folder, branch, HEAD, whether the folder is still there, how many entries are uncommitted, whether its branch is merged; a delegation's or branch line's worktree also says what it is, whether it has ended, and whether cleaning it up now would be refused. Metadata only, never file contents. Only from a backend with the `repo_worktrees` capability |

- `root` must **equal** one of the project's registered paths, or a worktree of one of the project's delegations or branch lines while it exists (those `/repos` lists after the project's paths, with `spawn`); every other path is relative to it, `/`-separated. Of the other worktrees `worktrees` lists, only those whose `root` isn't null can be read as a `root`.
- `tree` and `file` (without `rev`) don't need git: they work on a path that isn't a repo (`isRepo: false`, nothing marked `ignored`). `.git` isn't listed; a folder with a `.git` of its own is a `submodule`; a symlink's `linkTarget` is `dir`/`file` (under `root`), `outside` (pointing out) or `broken`. A gitignored file's contents can still be read.
- Paths stay under `root`: `..`, an absolute path, any `.git` segment or a symlink pointing out answer `path_outside_project`; the backend's own state folder and `.env`, `~/.ssh` and `~/.gnupg` answer `path_forbidden`. A path that no longer exists (a deleted file, a rename's source) is checked by its nearest existing ancestor.
- `mode` defaults to `worktree` (HEAD against the work tree — what `commit -a` would take); an untracked file shows as all added. `commit` mode needs `commit` (4–64 hex digits).
- "Unpushed" is as of the last fetch: against the upstream when there is one, else against every remote; with no remote, `unpushedBase` is `none`.
- When `root` is a subfolder of the repo, only that subfolder is shown; a commit's files outside it start with `../`, have `outsideRoot: true` and no diff.
- Limits: 2000 uncommitted files, 100 unpushed commits, 1000 files per commit (the matching `…Truncated` says so); a diff of 5000 lines or 512 KiB (`truncated`); 3000 entries per folder (`truncated`); a file of 1 MiB, beyond which it answers `tooLarge: true`, `text: null`. Binary files: a diff answers `binary: true` with no hunks; a file with a NUL in its first 8000 bytes answers `binary: true`, `text: null`. Each git run gets 10 s, at most 4 at a time.
- `tree` on a `dir` that isn't a folder answers `path_not_a_directory` (400); `file` on a `path` that isn't a file answers `invalid_request`; either on a path that doesn't exist answers `path_not_found` (404). `rev` takes only `HEAD` or 4–64 hex digits, and a root that isn't a repo answers `not_a_git_repo`.
- `log` covers local branches only: `--branches`, plus HEAD only when detached (on a branch it changes nothing); no remote branches, no tags. `refs` holds HEAD, the default branch (in order: what `origin/HEAD` names, `init.defaultBranch`, `main`/`master`/`trunk` — whichever is a local branch), every local branch's tip and upstream (the upstream's tip, `ahead`/`behind`, or `upstreamGone: true` once the remote dropped it), `unpushed`: the commits no remote has (at most 1000; with no remote, `unpushedBase` is `none`), and the branches' `fingerprint`. Laying out the lanes is the client's job.
- `nextCursor` carries the branches' fingerprint: once a local branch or HEAD moves, an old cursor answers `repo_changed` (409) — read again from the first page; a cursor the server didn't hand out answers `invalid_request`.
- New error codes: `repo_root_unknown` (400, `root` isn't one of the project's paths), `path_outside_project` (403), `not_a_git_repo` (409), `commit_not_found` (404), `git_failed` (502, `params.reason` is `timeout`/`unavailable`/`dubious_ownership`/`error`), `repo_changed` (409, a `log` cursor gone stale). Reused: `project_not_found`, `folder_not_found` (the path is gone), `path_forbidden`, `invalid_request`.
- Files likely to hold secrets (rules under "Sensitive files" in the next section): `tree` still lists them, marked `sensitive: true`, with nothing of their contents; `file`, `diff` (`orig` included) and a `tree` with one as `dir` answer 403 `path_sensitive`. Only from a backend with the `session_files` capability.
- The endpoints in this section take the user's login token only; the local tool token (`X-Hestia-Token`, which is what an LLM in a tmux has) gets 403 `login_required` (`routes/login-guard.ts`, since 2026-10-13; an LLM in a tmux has its own shell and doesn't need the app to read files).

## Carrying on after a usage limit: `continuity`

When a CLI runs low on, or hits, its usage limit, the backend can send a message that has it carry on once the limit resets, or hand the work to another launch option (account or CLI). Limit hits are recognized only for CLIs whose runtime capabilities include `limit_hit` (Claude Code and Codex CLI for now). Types are in `contract/continuity.ts`.

| Endpoint | Body | Answers |
|---|---|---|
| `GET /api/continuity` | – | `ContinuityDefaultsResponse`: the global defaults |
| `PUT /api/continuity` | Any `ContinuityDefaults` fields | The updated defaults |
| `GET /api/sessions/:id/continuity` | – | `SessionContinuityResponse`: the effective policy, this session's overrides, the pending carry-on, the handoff in progress, the last 20 events |
| `PUT /api/sessions/:id/continuity` | Any `ContinuityDefaults` fields; `null` puts a field back on the default | Same |
| `DELETE /api/sessions/:id/continuity/pending` | – | Same (cancels the pending carry-on) |
| `POST /api/sessions/:id/continuity/handoff` | `{ toProfileId?, interrupt?, briefBy?, afterReport? }`; without a profile, the `chain` picks; `interrupt: true` stops the reply in progress instead of waiting for the turn to end; `briefBy` (`current`/`incoming`) and `afterReport` (`wait`/`continue`) are this handoff's own choices, the policy's when absent (capability `handoff_options`) | Same (the handoff has started) |
| `POST /api/sessions/:id/continuity/handoff/interrupt` | – | Same (a handoff still waiting for the turn to end interrupts it now) |
| `POST /api/sessions/:id/continuity/handoff/force-switch` | – | Same (when the switch waits for a reply that can't be interrupted safely to end: reset the pane of the CLI being left and switch now; only in `switching` with `switchBlocked`) |
| `POST /api/sessions/:id/continuity/handoff/skip-brief` | – | Same (stop waiting for the CLI being left to write the brief; the backend writes it; only in `writing_brief`) |
| `POST /api/sessions/:id/continuity/handoff/confirm` | – | Same (the CLI taking over is told to start; only in `awaiting_confirmation`) |
| `POST /api/sessions/:id/continuity/handoff/dismiss` | – | Same (the CLI taking over has reported back; the handoff ends without anything sent, recorded as `handoff_done` with the taking-over profile as its detail; only in `awaiting_confirmation`; capability `handoff_options`) |
| `GET /api/sessions/:id/continuity/handoffs/:handoffId/brief` | – | `HandoffBriefResponse`: the brief of one of this session's handoffs (capability `handoff_brief`; login token only) |
| `DELETE /api/sessions/:id/continuity/handoff` | – | Same (cancels the handoff) |
| `POST /api/sessions/:id/continuity/handoff/relaunch` | `RelaunchHandoffRequest`: `{ briefFile, toProfileId?, permissionMode? }` | Same (the `failedHandoff` handoff starts again: with no CLI in the tmux its profile (or `toProfileId`) is started there, with one it switches as a handoff does, then the same brief is given; `briefFile` must be that handoff's; 409 `handoff_not_retryable` without a `failedHandoff`, 409 `handoff_brief_missing` once the brief is gone; `permissionMode` login token only; capability `handoff_relaunch`, ADR 0030) |
| `DELETE /api/sessions/:id/continuity/handoff/failed` | – | Same (clears `failedHandoff`; capability `handoff_relaunch`) |

- Who may change it: both `GET`s take the login token and the local tool token (`X-Hestia-Token`); both `PUT`s (the global defaults and a session's override) take only the user's login, and the tool token (that is, an LLM in a tmux) gets 403 `login_required`, so an LLM can't change how its own usage limit is handled (`routes/login-guard.ts`, as for delegation). Handoffs, cancelling a pending carry-on and the other actions are not settings and take either token. The `hestia` command doesn't write continuity settings.
- `mode`: `wait_resume` (carry on after the reset), `handoff` (also watch the remaining quota and hand off) or `off` (the default: only record it; whatever runs on its own waits for the user to turn it on). Later modes are added as new values; a client shows a value it doesn't know as `off`.
- Ranges: `resumeDelaySeconds` 0–3600, `maxAutoResumesPerDay` 0–50, `chain` up to 20 launch option ids (`GET /launch-profiles`), `softRemainingPercent`/`hardRemainingPercent` 0–100 with hard not above soft, `handoffSource` `self_then_mechanical`, `mechanical` or `incoming` (the last needs `handoff_options`), `handoffConfirm` `ask` or `auto`, `selfBriefTimeoutSeconds` 30–1800.
- A limit hit is read from the CLI's own transcript and reported as a `LimitHit` (`scope`, `limitType`, `model`, `resetsAt`, the wording, `ruleId`).
- The carry-on is due at `resetsAt` plus `resumeDelaySeconds`. Before sending, the backend checks again: the same conversation, the CLI running and idle, the conversation still ending on that hit. It goes through the same checks as `POST /sessions/:id/messages`; while the CLI waits on a confirmation or its trust prompt it is put off, never typed into the prompt. A hit whose reset passed more than two hours ago is left alone.
- The remaining quota is the lower of the account's 5-hour and 7-day windows. In `handoff` mode, at or below `softRemainingPercent` the work is handed off once the turn ends; at or below `hardRemainingPercent` the reply is interrupted for it. Only for sessions at work in the last 10 minutes.
- A handoff (`ContinuityHandoff.stage`): `writing_brief` (by default after the turn in progress ends; with `interrupt`, the reply is stopped first. The CLI being left writes the brief to `briefPath`, in `.hestia/handoffs/` in its working folder; if it can't, the backend writes it and says why in `briefNote` (the brief's own words, in Chinese) and `briefNoteCode` (`limit_hit`, `mechanical_only`, `user_skipped`, `cli_gone`, `never_settled`, `send_failed`, `waiting_elsewhere`, `cut_short`, `never_arrived`, `limit_while_writing`, `timed_out`, `no_brief_written`; the app shows its own text for it in its language, and `briefNote` for an older handoff without the field); the backend's own part is always appended, and says only where the conversation can be read (`hestia conversation show --session <id> --conversation <cid>`, the archive's and transcript's paths), writing no copy of it; `.conversation.md` files written before are left as they are) → `switching` (the same tmux exits and starts the target as a new conversation; both conversations get `provider_switch` as their `startReason`/`endReason`) → `briefing` (the new CLI is told to read the brief) → `reporting` (it is reporting what it understood) → `awaiting_confirmation` (the last two only with `handoffConfirm: 'ask'`). Every message sent to a CLI is read back from its transcript; one that didn't arrive whole doesn't count. In `switching`, when the CLI being left is replying and has no verified interrupt, the switch waits for the turn to end: `switchBlocked` (`reason`, `since`) says why and history gets a `handoff_waiting`; the user can skip the wait with `force-switch` (history gets `handoff_forced`). Once over, `handoff` is null and the outcome is in `history`.
- `hardRemainingPercent` defaults to 8.
- A manual handoff from a conversation that ends on a limit hit (not yet reset) has `trigger: 'limit_hit'`: the backend writes the brief at once, without asking the CLI being left.
- `session_timeline`: conversations (`ConversationSummary`, `ConversationDetail`) gain `userMessagesCount`: how many times the user spoke (follow-ups sent mid-reply included, a handoff's own messages not), the chat's turn count; `null` while the transcript isn't `resolved`.
- `handoff_brief`: conversations (`ConversationSummary`, `ConversationDetail`) gain `handoff` (`SegmentHandoff`: the handoff the conversation started from, who wrote its brief, what was chosen and what the CLI taking over was asked to do; `briefAmended` is judged only for the incoming LLM's notes with read-and-wait, `null` otherwise; one `derived: true` from an older handoff's briefing knows only the id's first 8 characters), and `ContinuityEvent` gains `handoffId`. `GET …/handoffs/:handoffId/brief` reads a brief: `handoffId` is a full UUID or its first 8 characters and must be one of this session's handoffs (otherwise 404 `not_found`; a short id fitting two different ones is 409 `handoff_brief_ambiguous`); only a regular file directly in the session folder's `.hestia/handoffs/` is read (a symlink or a name that leads elsewhere is 409 `handoff_brief_unsafe`; a missing one 404 `handoff_brief_missing`), at most 512 KiB (`truncated`); the tool token gets 403 `login_required`. No path is ever taken.
- `permission_modes`: launch permission modes (`contract/permissions.ts`): `cli_default` (nothing passed, the behavior before), `auto`, `yolo`. `GET/PUT /api/permission-modes` holds each runtime's global default for new launches (`defaults`, only `cli_default`/`auto`; yolo is 400; `null` puts it back on `cli_default`) and `supported` (the modes each runtime supports); `GET/PUT /api/sessions/:id/permission-modes` holds the tmux's own (`override`, yolo allowed; `null` back to the global value) and `effective`. Both PUTs take the login token only. `POST /sessions/:id/launch`, `POST /sessions/:id/continuity/handoff`, `POST /delegations` and `POST /forks` take an optional `permissionMode`: login token only, the tool token gets 403 `login_required`; without one, the tmux's setting applies (for a delegation or branch line, the tmux it starts from), then the global one; an LLM's own delegation is never yolo (`auto` instead, or `cli_default` when the runtime has no auto). A mode the runtime doesn't support is 400 `permission_mode_unsupported`; a native launch option whose own args already set permissions is 409 `permission_mode_conflict` (a mode only inherited from a setting falls back to `cli_default` instead). Conversations' `launchProfile` gains `permissionMode` (`cli_default` when absent), kept by `/clear` and resume; handoff, delegation and branch line records gain `permissionMode` (the user's choice, or decided when made). `RuntimeMeta.permissionModes` lists each runtime's modes; `permissionModesUnavailable` and the settings' `unavailable` give the ones this host can't use now and why (`sandbox_unavailable`: Codex's `auto` where Codex's sandbox can't start); choosing one is 400 `permission_mode_unavailable`, a saved one starts as `cli_default` and the event detail records `permissionFallbackFrom`. A changed setting only affects later launches. The session DTO gains `actualPermissionMode` (`{ mode: 'ask'|'auto'|'yolo'|'other', cli }`: the latest mode in the CLI's own records, `cli` being the CLI's name for it; `null` while no CLI runs, nothing is recorded yet, or the CLI doesn't record it) and `permissionModeChangedInTerminal` (it differs from the launched mode; for a CLI-default launch, from the conversation's first recorded mode); the mapping is in ADR 0027 decision 5, and it is pushed only when it changes.
- `handoff_options`: with `handoffSource: 'incoming'` (`briefBy: 'incoming'`) nothing is asked of the CLI being left; the backend writes its own part at once (`briefSource: 'incoming'`), and after the switch the CLI taking over is asked to read the conversation above and add its own notes under a final "## 接手者的整理" before it reports; afterwards `briefAmended` says whether it did. The `source` and `confirm` chosen when the handoff started are kept on `ContinuityHandoff`, so later setting changes don't affect a handoff under way (older records without them follow the policy). `SessionContinuityResponse.selfBrief` (`available`, `reason`: `limit_hit`/`cli_not_running`) says whether the CLI running now could write a brief itself. The push after the report reads "{to} read the brief and reported back". A request to write the brief that hasn't shown up in the CLI's record after 30 seconds also has the backend write it.
- The words a handoff types into the CLIs, and how to tell them apart, are `HANDOFF_MESSAGES` and `handoffMessageKind` in `contract/continuity.ts`; clients use them to mark those messages as the handoff's, not the user's, and not to flag their delivery.
- At most `maxAutoResumesPerDay` carry-ons per session in 24 hours. The schedule and handoffs are kept by the backend and survive a restart. Scheduling, sending, handing off and giving up each send a push notification.
- New error codes: `handoff_in_progress` (409), `no_handoff_target` (409), `handoff_not_awaiting` (409), `handoff_send_failed` (409, `params.reason`), `handoff_force_failed` (409, `params.reason`). Also: `not_found`, `invalid_request`, `no_running_cli`, `launch_profile_unavailable`.

## Delegating work to another LLM: `delegation`

Hands a piece of work to another launch option (profile): the backend makes a new git worktree and branch and a new tmux, starts that CLI in it and tells it to read a brief; when done, the delegate CLI delivers with `hestia delegate done`, the user reviews it in the app, and the result is also sent back to the delegating conversation. The user starts one from the app (login token); an LLM in a conversation starts one with `hestia delegate start` (local tool token), which starts right away or waits for the user's approval, as the settings say; with `parentReview` on, a delivery goes to the delegating LLM to review first (`hestia delegate review`), and to the user once it passes or its send-backs are used up. Types are in `contract/delegation.ts`. This is phases 1–3.

| Endpoint | Body | Returns | Local tool token |
|---|---|---|---|
| `GET /api/delegation` | – | `DelegationSettingsResponse`: `{ preferences, limits }` | Yes |
| `PUT /api/delegation` | `DelegationSettingsPatch`: `{ preferences?, limits? }`, field by field | Same | No (`login_required`) |
| `GET /api/sessions/:id/delegation` | – | `SessionDelegationResponse`: `{ effective, override, limits }` | Yes |
| `PUT /api/sessions/:id/delegation` | `SessionDelegationPatch`: `{ preferences?, limits? }`; `null` goes back to the global value; limits only stricter | Same | No |
| `GET /api/delegations` | Query `session` (delegating or delegate session; without it, every delegation on the host), `active=1` (only those not over) | `DelegationListResponse`, newest first | Yes |
| `GET /api/delegations/:id` | – | `DelegationDetailResponse`: `DelegationResponse` (with every report) plus `deliveryMergedInto` — the branch the repo has checked out (`HEAD` when detached) once it has the commit the work was delivered at (`headAtDelivery`, other than `baseCommit`), else `null`; asked of git on each read, never stored | Yes |
| `POST /api/delegations` | `StartDelegationRequest`: `{ parentSessionId, task, profileId?, title?, isolation?, confirmLowQuota? }` | 201, `DelegationResponse` (`starting` or `proposed`) | Yes (`initiator: 'llm'`; the login token is `'user'`) |
| `POST /api/delegations/:id/approve` | – | Same (`starting`) | No |
| `POST /api/delegations/:id/decline` | – | Same (`stopped`, reason `declined`) | No |
| `POST /api/delegations/:id/deliver` | `{ fromSessionId, report, blocked? }` | `DelegationResponse` | Yes |
| `POST /api/delegations/:id/review` | `ReviewDelegationRequest`: `{ fromSessionId?, verdict: 'pass' \| 'send_back', feedback? }`; `send_back` needs `feedback` | Same (`delivered` or `working`) | Only from the delegating session (with `fromSessionId`); the login token may only `send_back` |
| `POST /api/delegations/:id/accept` | – | Same (`accepted`) | No |
| `POST /api/delegations/:id/reject` | – | Same (`rejected`) | No |
| `POST /api/delegations/:id/stop` | Login token: –; tool token: `{ fromSessionId }` | Same (`stopped`, reason `user`/`parent`) | Only from the delegating session |
| `POST /api/delegations/:id/relaunch` | – | Same (the delegate's CLI quit: `starting` again from the top, same profile, the brief sent again; 409 `cli_already_running` while it runs; only `starting`/`working`/`needs_attention`; capability `handoff_relaunch`) | No |
| `POST /api/delegations/:id/cleanup` | `CleanupDelegationRequest`: `{ deleteBranch? }` | Same (`workspace.removedAt`, `workspace.branchDeletedAt`) | No |

- The login-only endpoints use the route guard in `routes/login-guard.ts`: the local tool token (`X-Hestia-Token`, which is what an LLM in a tmux has) gets 403 `login_required` there. An LLM can't change its own delegation settings, approve its own proposal, accept work, or clean up a worktree. The two continuity settings endpoints use the same guard (see the previous section); authentication for every other API is unchanged. It is a guardrail against a well-meaning LLM loosening its own limits, not a security boundary.
- Settings: `DelegationPreferences` (`targets`, `llmInitiated`: `allow`/`ask`/`off`, default `ask`, `isolation`, `parentReview`, `notify`: `key`/`all`, `idleAttentionMinutes`) and `DelegationLimits` (`maxConcurrent` 3, `maxDepth` 1, `maxReviewRounds` 3, `minRemainingPercent` 20). Global → this tmux's override → this delegation's own parameters. A tmux may change preferences either way; limits only stricter (a higher `minRemainingPercent`, lower otherwise), and a looser value gets 400 `invalid_request` (`params.field`). `effective` is the preferences with the override applied; `limits` is, per field, the stricter limit. `parentReview` (off by default) has a delivery reviewed by the delegating LLM first; `maxReviewRounds` is how many times the delegating LLM may send it back (the user's own send-backs don't count and have no limit), and `0` means no review.
- Checks when one starts (limits and quota again on approval): an LLM's start with `llmInitiated: 'off'` gets `delegation_disabled`; an LLM may only pick a profile in `targets` (the first when it names none; an empty list or a profile outside it gets `profile_not_allowed`), while the user may pick any available profile (the first target when they name none); an LLM's `isolation` may only go from `shared` to `worktree` (the other way gets `invalid_request`); depth = the delegator's own depth + 1 when it is itself a delegate, and past `maxDepth` gets `limit_reached` (`params.limit: 'depth'`); with as many delegations not over (proposals included) on the host as the global `maxConcurrent`, or as many from this tmux as its own overridden `maxConcurrent`, it gets `limit_reached` (`params.limit: 'concurrent'`, `params.max`); when the target account's remaining quota (the lower of 5-hour/7-day) is under `minRemainingPercent`, or continuity has it over its limit and not yet reset: an LLM's start (and approving an LLM's proposal) gets `quota_too_low` (`params.remaining`, `params.min`, plus `params.until` when over its limit); the user's gets 409 `quota_low_confirm` (the same `params`), the app shows a warning, and once the user confirms, sending it again with `confirmLowQuota: true` starts it as usual and writes a `decision` report (the field does nothing with the tool token). After that, the delegate's tmux hitting the limit is its own continuity's to handle; while continuity waits for the reset or hands off, the delegation doesn't go to `needs_attention`. Unknown quota is allowed, with `quotaAtStart: null`. A delegating session the app doesn't manage gets `not_in_managed_tmux` with the tool token, `not_found` with the login.
- States (`DelegationStatus`): an LLM's start with `llmInitiated: 'ask'` is `proposed` (no worktree, no tmux); the user's approval → `starting`, decline → `stopped` (`declined`), 24 hours without an answer → `stopped` (`expired`). Then `starting` → `working` → (`needs_attention`) → (`reviewing`) → `delivered` → `accepted`/`rejected`; sent back from `reviewing`/`delivered`, it returns to `working` (`round + 1`); anything not over and not a proposal can be `stopped`. A delegation in `reviewing` can be accepted or rejected directly too. Clients show a state or reason they don't know as it is.
- `stateReason`: for `needs_attention`, `idle` (idle for `idleAttentionMinutes` without delivering), `cli_exited`, `blocked` (the delegate's `--blocked`; `stateDetail` is the question's first line), `workspace_trust`, `startup_prompt`, `brief_not_delivered`; for `stopped`, `user`, `parent` (the delegating LLM's `hestia delegate stop`), `declined`, `expired`, `launch_failed` (`stateDetail` says why), `child_gone` (the delegate's session was deleted); for `delivered`, `null` (no LLM review), `passed` (the delegating LLM passed it), `review_rounds` (the LLM's send-backs are used up), `parent_gone` (the delegating session is gone), `parent_switched` (the delegating session moved on to another conversation; one continuity handed it on to doesn't count).
- New fields: `approvedAt` (when the user approved a proposal, otherwise `null`); `outbox` (messages waiting for the other CLI to be idle, `{ to, event, round?, text, createdAt, attempts, sentAt }`: for `to: 'parent'`, `event` is one of `delivered`, `review`, `blocked`, `accepted`, `rejected`, `declined`, `expired`; for `to: 'child'`, `event` is `feedback` and `round` the round it sends the delegate back into); `workspace.removedAt`, `workspace.branchDeletedAt` (when it was cleaned up; absent in older records); `parentTurnsAtStart` (the delegating conversation's turns when the brief was first written, where `hestia conversation show --upstream` stops; `null` before then, and for older records).
- Workspace (`workspace`): when the delegating session is in a git repo, by default a worktree `<repo name>-delegate-<id>` is made in `<repo name>-worktrees/` beside the repo (or wherever `HESTIA_WORKTREES_DIR` says; under `${XDG_DATA_HOME:-~/.local/share}/madera/hestia/worktrees/` when the repo's parent isn't writable, never the state directory), on branch `delegate/<id>-<the title's ASCII words>` from the delegating session's `HEAD` at that moment (`baseCommit`; for a proposal, when it is approved); the delegate's cwd is the matching subfolder. Outside a git repo (or with `isolation: 'shared'`) the delegate works in the delegating session's folder. The backend never merges or pushes; only the user's `cleanup` removes the worktree and deletes a merged branch.
- Every step of `starting` can run again and picks up after a backend restart: the worktree → the tmux (same project; the tmux carries `HESTIA_DELEGATION_ID`, also when a dead delegate tmux is recovered) → the profile's launch → one line telling the CLI to read the brief (`DELEGATION_MESSAGES.brief`), read back from its transcript, then `working`. When the CLI asks whether to trust the new folder, a delegation the user started or approved has the backend answer "trust" and record a `decision` report; an LLM's own with `allow` (nobody involved) moves to `needs_attention` (`workspace_trust`); any other startup screen moves to `needs_attention`, and back to `starting` once the user has dealt with it.
- The brief is `.hestia/delegations/<id>/brief.md` in the delegate's cwd (`.hestia/.gitignore` is `*`). It says only where the delegating conversation can be read (`hestia conversation show --upstream`, the explicit `--session`/`--conversation`/`--turns` form, the archive's and transcript's paths), writing no copy of it; `parent-conversation.md` files written before are left as they are.
- `deliver` only takes the delegation's own session (`fromSessionId`; a session the app doesn't manage gets `not_in_managed_tmux`, another session `invalid_request`). A worktree with uncommitted changes gets 409 `workspace_dirty`; otherwise `headAtDelivery` is recorded; with `parentReview` on, the delegating session there, and the delegating LLM still able to send it back (fewer of its send-backs than `maxReviewRounds`) it moves to `reviewing` (a `review` notice is queued for the delegator, whose report file explains `hestia delegate review`), otherwise to `delivered` (with the reason). `blocked: true` skips the workspace check and moves to `needs_attention`.
- `review`: with the tool token it is the delegating LLM (`hestia delegate review`), only in `reviewing`, and `fromSessionId` must be the delegating session (without it 403 `login_required`). `pass` → `delivered` (`passed`, pushed as "passed by the LLM, waiting for you"); `send_back` → `working`, `round + 1`, a `review` report, and a `feedback` message queued for the delegate; with its send-backs already used up (the limit was just lowered, say) → `delivered` (`review_rounds`). With the login token it is the user, only in `reviewing`/`delivered`, only `send_back` (`pass` gets 400 `invalid_request`; accepting is `accept`), and never limited by `maxReviewRounds`. While in `reviewing`, the delegating session going away or moving on to another conversation → `delivered` (`parent_gone`/`parent_switched`), and a request to review not yet sent is dropped. When the delegating conversation hits its usage limit while in `reviewing` and continuity waits for the reset, the user is pushed once (at most once per review, kept in `parentHeldNoticeAt`); it doesn't go to the user by itself.
- `cleanup`: login token only, only in `accepted`/`rejected`/`stopped`, and only for a worktree of its own (a shared folder gets `invalid_request`). Before removing the worktree it closes the delegate's tmux (as `POST /sessions/:id/close` does: the CLI is asked to exit, then the tmux ends and the session is listed as ended); a CLI that won't exit gets 409 `delegate_still_running` (`params.reason`: `cli_busy`, `exit_unverified`, `in_transition`) and nothing is touched. The two refusals below are checked before the tmux is closed. Removes the worktree (`git worktree remove`, never `--force`; uncommitted or untracked files get 409 `workspace_dirty`; a folder already gone is only `git worktree prune`d); with `deleteBranch: true` it deletes the branch too, but only one merged into the repo's current `HEAD` (`git branch -d`), and an unmerged one gets 409 `branch_not_merged` — checked first, so nothing is removed. Once the worktree is gone it can be called again to delete only the branch; with both done it gets `invalid_request`.
- Back to the delegating conversation: on delivery (`review` when it is to be reviewed), `--blocked`, the user's accept/reject, and a declined or expired proposal, a notice is queued in `outbox`; the backend types it in only while the delegating CLI is running, `idle`, has no prompt on screen, isn't being switched or handed off, and its last turn ended (or last message was sent) over 30 seconds ago — one at a time. It is one line, `DELEGATION_MESSAGES.parent`, pointing at `.hestia/delegations/<id>/report.md` in the delegating session's cwd (written when it is sent; named `report-for-parent.md` in a shared folder, so it doesn't overwrite the delegate's own report), read back after sending, typed in once more when it arrived cut short or not at all, and otherwise given up with a `decision` report. When the delegating session is gone, it is given up with a report too. `outbox` is in the state file, so it keeps waiting across a restart.
- Feedback reaches the delegate the same way: when it is sent, the feedback is written to `.hestia/delegations/<id>/feedback-<round>.md` in the delegate's cwd and one line, `DELEGATION_MESSAGES.feedback`, is typed in once it is idle, then read back; once the delegation is over it isn't sent (a `decision` report says so).
- The messages typed into a conversation (the delegate's brief instruction and feedback, the delegator's notices) are recognized with `delegationMessageKind` (`brief`, `feedback`, `parent`); clients label them like handoff messages, not as the user's own, and don't warn that they may not have arrived.
- `stop` with the tool token needs `fromSessionId`, which must be the delegation's delegating session (without it 403 `login_required`, another session `invalid_request`, one the app doesn't manage `not_in_managed_tmux`).
- A delegate's session DTO has `delegation` (see "A delegate's session knows its delegation: `delegation_origin`").
- The session DTO's optional `closable` (2026-10-12): `{ reason, into }` when a branch line's or delegate's session looks finished and can be closed — its own worktree not removed, nothing uncommitted, its CLI not at work, and either `reason: 'merged'` (its HEAD is in the branch the repo it was cut from has checked out; `into` is that branch, `'HEAD'` when detached) or `reason: 'unchanged'` (no commit made at all; `into` is `null`); a branch line must also be open, started and not failed, and a delegation `accepted`/`rejected`/`stopped`. `null` otherwise. Re-checked at most every 30 seconds per session, so it can lag a little. Only a hint: closing is still `POST /forks/:id/close`/`POST /delegations/:id/cleanup` with their own checks. Older backends without the field simply offer nothing.
- The session DTO's optional `spawnClosedAt` (2026-10-13): when a branch line's or delegate's session was closed (its fork closed, its delegation's worktree removed); `null` otherwise. Its folder is gone, so `recoverable` is always `false` — it can't be resumed, only read. Updated right after a successful close or cleanup. Older backends without the field mean not closed.
- Push notifications: with `notify: 'key'`, proposals, deliveries, entering `needs_attention`, and `stopped` (`launch_failed`); `notify: 'all'` adds the start of work, the understanding report, a delivery going to the LLM's review, and each send-back by the LLM. The delegating LLM passing it (`passed`), its send-backs running out, and a review skipped because the delegator is gone all count as a delivery and are pushed with `key` too. The link is `/session/<delegating session>?delegation=<id>` (with `host=` as usual), which opens that delegation's detail in the app (where a proposal is approved or declined).
- New error codes: `login_required` (403), `delegation_state` (409, `params.state`), `workspace_dirty` (409), `not_in_managed_tmux` (400), `delegation_disabled` (409), `profile_not_allowed` (409, `params.profile`), `limit_reached` (409, `params.limit`, `params.max`), `quota_too_low`, `quota_low_confirm` (409, `params.remaining`, `params.min`, `params.until`), `branch_not_merged` (409), `delegate_still_running` (409, `params.reason`). Also: `not_found`, `invalid_request`, `launch_profile_unavailable`.

## Session trash: `session_trash`

Deleting a session no longer drops its record: it moves to its project's trash, where it can be restored or deleted permanently.

| Endpoint | Body / query | Returns |
|---|---|---|
| `DELETE /api/sessions/:id` | – | 204: ends its tmux, then moves the record to the trash. An unknown id, or one already in the trash, also answers 204 |
| `GET /api/sessions/trash` | `projectId` (optional) | `TrashedSessionList`: `{ sessions: TrashedSessionDto[] }`, most recently deleted first. Without `projectId`, every project's, including projects that were deleted or no longer exist |
| `POST /api/sessions/:id/restore` | – | 200 with the session (the same shape as `GET /sessions/:id`); it comes back `dead`, and no CLI is recovered automatically |
| `POST /api/sessions/:id/purge` | – | 204: deletes it from the trash for good — the registry record only; the dialogue archive and the CLI's transcript files are left alone |

- `TrashedSessionDto` is `SessionDto` plus `deletedAt` and `lastMessage: { role: 'user' | 'assistant', text, at } | null`: the active conversation's last turn, else that of the last conversation with any turns; the reply when it has one, else the message; `text` is at most 200 characters (`TRASH_LAST_MESSAGE_CHARS`). Like every session DTO, it carries no local path.
- A session in the trash is as good as gone for every other endpoint: `GET /sessions`, `GET /sessions/:id`, search, the list stream and every per-session endpoint don't see it (404). Moving it to the trash sends `deleted` on the list stream, and `deleted` on `GET /sessions/:id/events`, which then ends; any later write to it also only sends `deleted`.
- Restoring it sends a new event type, `restored`: `{ type: 'restored', session: SessionDto }` on the list stream, `{ type: 'restored', session }` on `GET /sessions/:id/events` (with the legacy fields, like `update`). Later changes are `update` again. Unlike `update`, a client that has seen the session's `deleted` should ignore a late `update` but take `restored`: lift the deletion, then add it back to the list. Clients ignore an event type they don't know; older web frontends treat it on the list stream as deleting an id that isn't there (no effect), and on the per-session stream as an `update`.
- A session in the trash is always `dead`, with no launch, recovery, clear or switch in progress, and none of them can start on it.
- New error code: `session_not_trashed` (409, restoring or purging a session that isn't in the trash). Also: `not_found` (404), `invalid_request` (400, an empty `projectId`).
- Added in the same batch, `recovery_cwd_missing` (409): `POST /sessions/:id/recover`, and `POST /sessions/:id/conversations/:conversationId/resume` when its tmux has to be recreated, answer this when the session's working folder no longer exists, without creating a tmux.
- Only live sessions keep a project from being deleted (`project_has_sessions`); sessions in the trash don't, and once the project is deleted they can still be found and restored from the trash without `projectId`.

## Conversation recaps: `recap`

Each conversation (`ConversationSegment`) has a short list of what the user asked for in it, each item marked with how far it got. The backend keeps it up to date in the background with a one-shot CLI run on an account the user picks (Codex CLI or Claude Code), each time sending "the list so far plus the turns not yet in it"; a status the user changed is never changed back. Off by default. Types live in `contract/recap.ts`.

| Endpoint | Body / query | Returns |
|---|---|---|
| `GET /api/recap/settings` | – | `ConversationRecapSettingsResponse`: the settings, `enabledAt`, `pause`, `queue` |
| `PUT /api/recap/settings` | Any fields of `ConversationRecapSettings` | Same as above |
| `GET /api/recap/profiles` | – | `{ profiles: LaunchOption[] }`: the accounts a recap can run on, only launch options whose runtime is `codex-cli` or `claude-code` |
| `GET /api/recap/models` | `profileId` (required), `refresh=1` (optional, skips the cache) | `ConversationRecapModelCatalog`: the same as `GET /sessions/:id/models` without `current`; both share one cache |
| `GET /api/sessions/:id/recaps` | – | `SessionRecapsResponse`: `{ enabled, conversations: ConversationRecapView[] }`, newest `sequence` first |
| `POST /api/sessions/:id/conversations/:conversationId/recap/refresh` | – | 202 with that conversation's `ConversationRecapView`: queued first, without waiting for the conversation to go quiet or for a failure's backoff. Without a recap this is "create recap", from the first turn |
| `PATCH /api/sessions/:id/conversations/:conversationId/recap/items/:itemId` | `{ status }` | 200 with that conversation's `ConversationRecapView`. Allowed while recaps are off too |

- Settings: `enabled` defaults to false; turning it on requires `profileId` and `model`. `profileId` must be in `GET /recap/profiles`. When the account lists its own models (`source: 'account'`, Codex), `model` must be in the list and `effort` null or one of that model's `efforts`; for a fixed list (`builtin`, Claude Code) only `model` is checked and `effort` must be null. The backend never picks a model for the user. The backend writes `enabledAt` each time recaps go from off to on. Picking another account or model lifts a `profile_unavailable` or `model_rejected` pause; another account also lifts `account_limited`.
- Which conversations are recapped on their own: one that has a recap and new finished turns; one without a recap only when one of its turns has a user message later than `enabledAt` (then from its first turn). Other conversations without a recap are `not_created` until the user asks; with `backfillOld: true` they are recapped in the background at the lowest priority. A conversation has to be quiet for 3 minutes first; the turn being replied to doesn't count as finished. One run at a time, at most 20 turns a batch, in the order user requests > new turns > backfill.
- `ConversationRecapItem`: `id` (made by the backend), `title` (one sentence, plain text, at most 40 characters), `status` (`implemented`, `accepted`, `planned`, `not_implemented`, `uncertain`), `statusSource` (`user` means the user changed it: later recaps neither change its status nor merge or drop it; its title may still be reworded), `turns: { from, to }` (`Turn.index`, both ends included), `createdAt`, `updatedAt`, `statusChangedAt`.
- `ConversationRecapView`: `totalTurns` is the finished turns, `coveredTurns` how many of them (from the first) are in the recap, `pendingTurns` the difference. `state` is `disabled` (recaps are off; existing items are still returned), `unavailable` (a conversation without a provider, `available: false`), `empty`, `not_created`, `waiting` (for the conversation to go quiet), `queued`, `running`, `up_to_date`, `behind` (partly recapped, stopped or waiting to retry), `failed` (failed before any turn was recapped, waiting to retry), or `paused`.
- `error`: `{ code, params?, retryAt }`, where `code` is a `RecapErrorCode`: `invalid_output`, `run_failed`, `run_timeout`, `account_limited`, `model_rejected`, `profile_unavailable`, `runner_unavailable`. Codes only, for the client to word; the CLI's own output only goes to the backend's log. Failures in a row wait 1, 5 and 30 minutes, then 2 hours each.
- `pause` (in the settings and in every view): `{ code: 'profile_unavailable' | 'model_rejected' | 'account_limited', until, at }`; every recap stops. `account_limited` lifts itself at `until` (without one, the account is checked again every 15 minutes); the other two need another account or model in the settings. The backend never switches accounts by itself.
- `generator` only has `profileLabel`, `runtimeId`, `model` and `effort`, never a local path.
- Recaps are kept beside the backend's conversation archive (`<conversationId>.recap.json`), not in the registry. For a session in the trash these endpoints answer 404; its recap files are kept.
- SSE: a new event type `recap` (`ConversationRecapEvent`: `{ type: 'recap', sessionId, conversationId, state, coveredTurns, totalTurns, updatedAt }`, without the items) on `GET /sessions/events` and `GET /sessions/:id/events`, **sent only to connections whose stream URL has `include=recap`** (several values comma-separated). It is sent when a conversation is queued, starts, gets a batch written, fails, and on a pause and its lifting; a client re-reads `GET /sessions/:id/recaps` when `state` or `updatedAt` changes. It has to be asked for because web frontends from before the trash took an unknown event on the list stream as deleting its `sessionId`.
- New error codes: `recap_disabled` (409, refresh while recaps are off), `recap_unavailable` (409, a conversation without a provider), `recap_item_not_found` (404). Also: `not_found` (404, no such session or conversation, or in the trash), `invalid_request` (400), `launch_profile_unavailable` (400), `model_unknown` (400, `params.model`), `model_list_failed` (502, `params.cli`, `params.reason`).

## CLI usage analytics

The `usage_analytics` capability declares local CLI history. Dependency-free types live in `contract/usage-analytics.ts`. Every endpoint below requires authentication.

| Endpoint | Behavior |
|---|---|
| `GET /usage-analytics/facets` | Account sources, providers, reliably attributed projects and tmux sessions, capabilities and scan status |
| `GET /usage-analytics/summary` | Local calendar dates `from` inclusive / `to` exclusive and an IANA `timezone`, up to 400 days; totals, daily values, model/account groups and coverage |
| `GET /usage-analytics/days/:date` | Daily detail with the same timezone and filters; at most 100 CLI sessions, with `sessionsTruncated` |
| `POST /usage-analytics/refresh` | Coalesces background indexing jobs and returns 202 `UsageScanStatus`; GET only reads persisted data |

Summary and daily queries accept `accountId`, `provider`, `projectId` and `tmuxId`, combined with AND; omitted filters mean all. Invalid dates, timezones, ranges and unknown filter values return 400 `invalid_request`.

`inputTokens` excludes cache read/write; `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. Reasoning is an output subset and is never added twice. `requestCount` counts deduplicated model requests, not user messages; `sessionCount` is distinct across the whole query, rather than the sum of daily counts.

`costUsd` is an API-equivalent estimate, null when any request is unpriced (0 for an empty scope), with `unpricedRequests`. Accounts identify CLI profiles/log sources, not verified historical login identities. Coverage describes observed retained local data; no event does not prove no use on other devices. Responses contain no source file paths, conversation text or credentials.

## The notes trash: `note_trash`

Deleting a note no longer deletes it: it goes to its project's (or the inbox's) trash, where it can be restored. There's no deleting for good, and nothing is cleared automatically.

| Endpoint | Body | Returns |
|---|---|---|
| `DELETE /api/projects/:id/notes/:noteId` | – | 204: into the trash. An unknown note, or one already in the trash, is a 404 |
| `GET /api/projects/:id/notes/trash` | – | `{ notes: TrashedNoteDto[] }`, the latest deleted first |
| `POST /api/projects/:id/notes/:noteId/restore` | – | 200 and the `NoteDto`, as it was before it was deleted |

- `TrashedNoteDto` is a `NoteDto` plus `deletedAt` (`contract/projects.ts`).
- A note in the trash is, to every other endpoint, not there: `GET …/notes` doesn't list it, editing its text is a 404, marking notes used or done and moving them to another project skip it; its tags leave the project's tag list, and come back when it's restored.
- New error code: `note_not_trashed` (409, restoring a note that isn't in the trash). Also: `not_found` (404).
- Frontend: with this capability the delete confirmation says the notes go to the trash, and the sidebar's trash has a "Notes" tab; without it, the "can't be undone" confirmation stays and there's no such tab.

## Branch lines: `fork`

Opening another line from a conversation (the main line): the backend makes a new git worktree and branch and a new tmux, starts a CLI in it with the main line's memory, and both work at the same time. A branch line reports nothing back and delivers nothing; it has no flow states. The backend only records which conversation, turn and commit it came from. Only the user opens or closes one. Types are in `contract/fork.ts`.

| Endpoint | Body | Returns | Local tool token |
|---|---|---|---|
| `GET /api/forks` | Query `session` (the main line's or the branch line's session), `open=1` (only those not closed) | `ForkListResponse`, newest first | Yes |
| `GET /api/forks/:id` | – | `ForkResponse` | Yes |
| `GET /api/forks/preview` | Query `parentSessionId`, `profileId?` | `ForkPreview`: `{ memory, memoryReason, profileId, workspace, parentDirtyFiles, turnsAtFork }`; writes nothing | Yes |
| `POST /api/forks` | `StartForkRequest`: `{ parentSessionId, profileId?, title?, instruction?, confirmLowQuota? }` | 201, `ForkResponse` | No (`login_required`) |
| `POST /api/forks/:id/close` | `CloseForkRequest`: `{ force? }` | `CloseForkResponse`: `{ fork, outcome: { tmuxClosed, workspace: 'removed' \| 'kept' \| 'shared', keptReason? } }` | No |
| `POST /api/forks/:id/relaunch` | – | `ForkResponse` (its CLI gone — a failed launch, or it quit before taking over: `failedAt`/`issue` cleared, started again from the top and the brief given again; 409 `cli_already_running` while it runs; capability `handoff_relaunch`) | No |

- Memory (`memory`): `native` when the chosen profile is the main line's current one, the CLI supports a native fork, and the main line's conversation has the CLI's id and a verified transcript (Claude Code `--resume <id> --fork-session --session-id <new id>`, Codex `codex fork`; the tested versions are in [CLI version alignment](cli-version-alignment.en.md)); otherwise `brief`, with `memoryReason` `other_profile`, `runtime_unsupported` or `conversation_unforkable`. Without `profileId`, the main line's current one.
- Both write a brief at `<branch line cwd>/.hestia/forks/<id>/brief.md` (`.hestia/.gitignore` is `*`): that this is a branch line, which the main line is, how many turns it had at the fork, the workspace (a native fork remembers the main line's paths; the brief tells it to use the worktree), the main line's uncommitted files (not carried over), the rules, and the user's first instruction. In `brief` mode it also has the main line's last request (cut to about 1000 characters), where its recap is, and where the upstream conversation can be read; **the conversation is not copied**. Once the CLI is ready, one line of `FORK_MESSAGES.brief` is sent and read back, and sent once more if it didn't arrive; `forkMessageKind` recognizes that line, so a client can label it as the branch line's brief.
- Workspace: a `<repo name>-fork-<id>` worktree and a `fork/<id>-<ASCII words of the title>` branch, placed as a delegation's are, from the main line's `HEAD` at the time (`origin.commit`); outside a git repo, the main line's own folder (`workspace.isolation: 'shared'`). The preview's `workspace.path` and `branch` show the id not chosen yet as `…`; `parentDirtyFiles` are the whole repo's uncommitted files (relative to the repo root), `null` outside git.
- Status comes from the fields (`forkStatus`): `closedAt` → `closed`, `failedAt` → `failed`, a non-null `startup` → `starting`, otherwise `open`. `issue` is something during the start that needs a person (`workspace_trust`, `startup_prompt`, `cli_exited`, `brief_not_delivered`; `launch_failed` on failure), pushed once per reason. The four start steps (workspace → tmux → launch → brief) are shared with delegation and pick up after a restart; the trust prompt is answered by the backend. When the branch line's session is deleted → `closedAt`, `closedReason: 'session_removed'`, and the worktree stays.
- `childSessionId` is chosen and saved before the response. A branch line's session DTO has `fork: { forkId, fromSessionId, fromConversationId, sharedFolder }` (`null` for other sessions); its tmux carries `HESTIA_FORK_ID` (also when recovered), and when continuity hands its tmux over, the handoff brief says it is a branch line.
- Conversations have one more start reason, `startReason: 'fork'`: a branch line's first conversation. Its turns are only the ones after the fork: Claude's fork copies the main line's records (timestamps unchanged) to the start of its own transcript, and when binding it the backend records the number of turns asked before the branch line started as the offset and doesn't import them; Codex's fork copies nothing, so the offset is 0. A client that doesn't know the value can treat it as an ordinary start.
- `close`: first closes the branch line's tmux (as `POST /sessions/:id/close`; `force: true` ends it without waiting for the CLI; a CLI that won't exit is 409 `fork_still_running`, `params.reason`: `cli_busy`, `exit_unverified`, `in_transition`). Then the worktree: when the branch is merged into the repo's main checkout's current `HEAD` and nothing is uncommitted, the worktree is removed and `git branch -d` run (a branch line branch with no commits at all counts as merged); otherwise both are kept and the answer is `workspace: 'kept'` with `keptReason` (`branch_not_merged`, `workspace_dirty`), which is a normal outcome. A shared folder answers `shared`. The backend doesn't merge, push or `-D`. It may be called again: on a closed one it checks the worktree again.
- Quota: under 20% left on the target account, or over its limit as continuity recorded it, answers 409 `quota_low_confirm` (`params.remaining`, `params.min`, `params.until`); sent again with `confirmLowQuota: true`, it opens.
- Push: when the start fails or needs a person; the link is `/session/<main line>?fork=<id>`.
- `hestia conversation show [--upstream | --session <id> [--conversation <cid>]] [--last N | --turns a..b]`: reads a conversation through the existing `GET /sessions/:id` and `GET /sessions/:id/conversations/:conversationId` and prints it locally as markdown to stdout, writing no file. `--upstream` reads `HESTIA_FORK_ID` → `GET /forks/:id` first and prints only up to turn N at the fork; without it, `HESTIA_DELEGATION_ID` → `GET /delegations/:id`, printing the delegating conversation up to `parentTurnsAtStart` turns (all of it when `null`); with neither, it looks this tmux's session up in `GET /forks?session=`, then `GET /delegations?session=`, for the one whose `childSessionId` it is. `--turns` goes by `Turn.index`. The `hestia` command has no subcommand to open a branch line.
- New error codes: `nothing_to_fork` (409, the main line has no conversation or no turn yet) and `fork_still_running` (409, `params.reason`). Reused: `invalid_request`, `not_found`, `launch_profile_unavailable`, `quota_low_confirm`, `login_required`.

## Checking the CLI before a launch, and cancelling a launch: `launch_cancel`

- Before `POST /sessions/:id/launch` sends its command, the backend looks for the launch option's executable with this tmux's `default-shell`, as a login and interactive shell, in the session's folder (a path is checked on disk instead). When it is **definitely not there**, it answers 409 `launch_cli_not_found` with the executable's name in `params.command`, and the session never starts launching; when the check can't tell (a timeout, an unreadable shell), the launch goes ahead as before. When continuity hands a session over to another launch option, the same check runs before the running CLI is asked to exit; `/clear` restarts the same CLI and doesn't check.
- Bare-name probes merge the tmux server and session environments and remove API login secrets. Custom shells or pane commands and unreadable context allow the launch to proceed. The probe does not reflect exports or functions changed inside an existing shell.
- The session DTO gains an optional `launchStartedAt`: when the launch still waiting to be confirmed was sent, `null` when there is none. Older backends don't send it.
- `POST /sessions/:id/launch/cancel` (no body): gives up on a launch still waiting to be confirmed. The backend resets the tmux pane (ending whatever the command may have started) and puts the session back as it was before the launch, with no error; it answers 200 with the session. With no launch waiting, or while the launch request itself is still being sent, it answers 409 `no_launch_to_cancel`; when the pane can't be reset, 503 `pane_reset_failed`, and the launch keeps waiting.
- Dispatch, confirmation, and cancellation share atomic ownership of the same launch attempt; an operation already owned by another caller also returns 409 without resetting the pane.
- Frontend: while a launch is waiting, the panel shows how many seconds it has waited (from `launchStartedAt`, or from when the view saw it when there is none) and the terminal's last lines; it offers "Cancel launch" only on a backend with `launch_cancel`.

## A delegate's session knows its delegation: `delegation_origin`

- The session DTO gains an optional `delegation`: for a delegate's session, `{ delegationId, fromSessionId, fromConversationId }` (which delegation it works on, and the session and conversation that started it; `null` when that is no longer known); `null` for every other session. Backends older than `delegation_origin` don't send it.
- Written when a delegation makes its delegate's session, never changed after. At start-up the backend fills it in, from the delegations, on delegates' sessions made before it existed (it only adds the field and removes nothing, so it can run again).
- Clients use it to show how sessions relate (the sidebar, the note on the delegate's side). With a backend without this capability, they look for the entry of `GET /delegations?session=` whose `childSessionId` is the session itself.

## A turn's process: `turn_process`

A turn's text split into its reply and what was said on the way, plus its tools, thinking and details, are **read from the CLI's own records on request** and never stored in Hestia's conversation archive (`contract/process.ts`).

- `turns` in `GET /sessions/:id/conversations/:cid` are `PublicTurn`s (`Turn` with an optional `process`). Only the latest 50 turns carry one:
  - `{ status: 'available', open, parts, counts }`: `parts` are `{ kind: 'reply' | 'progress', text, at }` whose texts joined with a blank line **equal** the turn's `assistant.text` (without the old interrupted marker); `open` means the turn is still going. `counts` holds `read`/`edit` (files), `run`/`search`/`web`/`agent`/`other` (calls), `failed`, `runFailed` and `thinking`.
  - `{ status: 'transcript_missing' }`: the CLI's record is gone (Claude keeps it 30 days by default); `'unmatched'`: the stored turn isn't in the record; `'unavailable'`: the stored text differs from the record, or the conversation has no bound record; `'unsupported'`: this CLI's records aren't read this way (Agy). All show the turn whole, as before.
  - No field (an older backend, or an earlier turn) also means showing it whole.
- `GET /sessions/:id/conversations/:cid/turns/:index/process` → `{ provider, process, items }`, `items` being `{ id, kind, label, at, status: 'ok' | 'error' | 'running', hasDetail, afterPart }`. `:index` may be `open`: the newest user message onwards, whether or not it is a turn yet; its `parts` are always empty.
- `GET …/turns/:index/process/items/:itemId` → `{ input?, output?, diff?, thinking?: string | null, exitCode?, truncated, originalBytes? }`, each field at most 256 KiB. `itemId` is only matched against that turn's items.
- `GET …/turns/:index/git` → `{ since, until, repos: [{ root, projectRoot, commits: [{ sha, subject, committedAt, files: [{ path, status }] }], truncated, uncommitted }] }`: the commits made in the turn's time (at most 50), other sessions' commits to the same repo included.
- Subagents: `GET /sessions/:id/subagents/:agentId` adds `turns` (same shape), with `…/subagents/:agentId/turns/:index/process` and `…/items/:itemId`.
- The list, details and git take the login token only; the tool token gets 403 `login_required` (output and diffs can hold secrets). The brief in a conversation's detail takes either token.
- New error codes: `turn_not_found` (404), `transcript_missing` (410), `process_unsupported` (409), `process_item_not_found` (404).

### Images in a process item: `process_images`

- A detail may carry `images: { index, source: 'result' | 'file', name: string | null }[]`: the images the item showed the CLI. `result` is a tool result's own image (a base64 image in Claude's `tool_result`, as when Read opens an image), `file` the file a tool looked at (Codex's `view_image`), `name` its file name. No images, no field.
- `GET …/turns/:index/process/items/:itemId/images/:image` (`:image` being the `index`) returns the image itself; subagents have `…/subagents/:agentId/turns/:index/process/items/:itemId/images/:image`. Login token only; read it as a blob, never put it in a URL. Responses carry `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store`.
- The type comes from the bytes alone: only PNG, JPEG, GIF and WebP are sent (never SVG), at most 15 MB. A `file` is where the transcript says, inside the project or not, never a path a request names; sensitive files (`.ssh`, keys, `.env` and the like) and the backend's own folders are always refused; only regular files are read (a folder or a device gets 404), and what was opened is checked to still be that file.
- Errors: `process_image_not_found` (404: no such image, the file is gone, not a regular file), `path_sensitive` (403), `unsupported_media` (415 not an image the app shows; 413 too large).

## How long transcripts are kept: `transcript_retention`

- `GET /transcript-retention` → `{ defaultDays: 30, minDays: 1, maxDays: 3650, accounts: [{ id, name, source, file, state: 'ok' | 'unreadable', days }] }`: `cleanupPeriodDays` in each Claude account's (native and Janus) `settings.json` (`days: null`: not set, Claude Code's default applies).
- `PUT /transcript-retention/claude/:accountId { days, expectedDays }` writes it in that account's settings file. `days` is a whole number from 1 to 3650 (0 fails Claude Code's own validation and is refused); `expectedDays` is the value the user saw, and a different current value → 409 `retention_changed`; a settings file that isn't a JSON object → 409 `retention_file_unreadable`. Only that key changes; other settings, the file's mode, indent and final line break stay. It writes a temporary file and renames it, giving up (`retention_changed`) if the file changed before the rename.
- Both take the login token only. A client sends the `PUT` only after the user confirms.

## File links in the chat: `session_files`

Local file paths a reply mentions become read-only views in the app (`contract/session-files.ts`). Decided at display time only; the stored conversation is never changed. All three endpoints take the login token only; the tool token answers 403 `login_required`. An unknown session answers 404 `not_found`.

| Endpoint | Input | Answer |
|---|---|---|
| `POST /api/sessions/:id/file-refs` | `{ paths: string[] }`, at most 50, each at most 1024 characters (more answers 400 `invalid_request`) | `FileRefsResponse`: `{ refs: [{ input, status, root?, path?, relative?, line?, col?, size?, kind?, repoRoot? }] }`, one per distinct `input`. Stat only, **never any contents** |
| `GET /api/sessions/:id/files` | `path` | `SessionFileContent`: `RepoFileContent` (the same 1 MiB and binary checks as `repo/file`) plus `root`, `relative`, `absolute`, `repoRoot` |
| `GET /api/sessions/:id/files/raw` | `path` | The image itself (png, jpeg, gif, webp, avif, bmp, ico), up to 10 MB |

- Allowed roots: the session's `cwd`, each of the project's paths, the project's delegation and branch line worktrees while they exist (those `/repos` lists with `spawn`), and the top of the session's own worktree when it is a delegate or a branch line. Realpaths, without duplicates; the backend's own state folder and denied paths never count. Project paths and delegation/branch line worktrees are `repoRoot: true` (the Git view opens them: a client can hand `root` and `relative` to `repo/*`).
- Input: may carry `:12`, `:12:3`, `#L12` or `#L12-L20` (answered as `line`/`col`); a `file://` URL is decoded to its path; `~/` paths and other URLs are always `outside`. An absolute path belongs to the deepest root holding it; a relative one is tried under the `cwd`, the primary path, then the other roots, the first where it exists winning.
- Every path goes through the same fence as `repo/*` (realpath, symlinks out, `..`, `.git`, the backend's state folder), plus the sensitive-file rules.
- `status`: `file` (a regular file under a root — the only kind a client links), `outside` (in no allowed root, or out of one through a symlink), `missing`, `not_file` (a folder or the like), `blocked` (a sensitive file or the backend's state, decided **before anything is looked at on disk**, without `root`/`path`). `kind`: `image` (one `files/raw` serves), `binary_or_large` (a known binary extension or over 1 MiB), `text` (anything else; whether it is binary is known once read).
- `files` and `files/raw` check everything again when reading: after opening, the realpath, the sensitive rules and the inode are compared again, so a symlink swapped in between is refused.
- `files/raw` serves images only: SVG, HTML and text answer 415 `unsupported_media`; over 10 MB answers 413 `unsupported_media`. The answer carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline`, `Cache-Control: private, no-store`. A client fetches it with the login token as a blob and shows it from an object URL, never putting the token in a URL.
- Error codes: `path_outside_project` (403, not in an allowed root), `path_sensitive` (403, new), `path_not_found` (404, missing or not a file), `unsupported_media` (415/413, new), `login_required`, `invalid_request`.

### Sensitive files

Files likely to hold secrets (`isSensitivePath` in the shared package `@maderaojen/fs-guard`, case-insensitive): the names `.env`, `.env.*` (except `.env.example`/`.sample`/`.template`/`.dist`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.jks`, `*.keystore`, `*.ppk`, `*.kdbx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `credentials`, `credentials.*`, `.credentials.json`, `*.credentials.json`, `service-account*.json`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `.htpasswd`, `secrets.*`, `*.secret`, `*.secrets`; and any path through `.git`, `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.codex/auth.json` or `.config/gh`. Both the path as written and its realpath are checked. The chat's file links answer `blocked`/`path_sensitive`; for `repo/*` see "A project's files and git" above. A second guard: the folder fences are the real boundary.

## The composer's attachments: `composer_attachments`

The composer can attach any file and long pasted text (`contract/attachments.ts`, `UserMessage` in `contract/sessions.ts`). A backend without this capability takes images only and words `promptText` the old way; clients handle it as before.

- `POST /api/sessions/:id/uploads` takes any file up to `UPLOAD_MAX_BYTES` (90 MB, under the 100 MB request a Cloudflare tunnel passes); over it answers 400 `upload_too_large`. An image (png, jpeg, webp, heic, heif) is `kind: 'image'` with id `<session>/<uuid><ext>` as before. Any other file is `kind: 'file'` with id `<session>/<uuid>/<name>` and a `name`: the original name keeping letters and digits of any script, `.`, `-` and `_`, everything else turned into `_`, never starting with `.`, at most 120 characters (the extension kept). A note's upload (`POST /api/notes/uploads`) still takes images only, up to 10 MB.
- `GET /api/sessions/:id/uploads/:folder/:name` always serves the file as a download: `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, never opened in the browser whatever it holds. It takes `?media=` like images do.
- `promptText` is the file's path on the host alone, without "請看這張圖片：". The CLI reads that path itself.
- A message's attachments are recognized from its text, both ways: a path under `UPLOADS_DIR` (images and files), and an image path after the old wording (wherever `UPLOADS_DIR` was then). A file's attachment carries `name` too. A client shows a `kind` it doesn't know as a file.
- `POST /api/sessions/:id/messages` takes `pastes: [{ start, end }]` (at most 100): the parts of `text` that were pasted as a block. The conversation remembers each part's first 32 characters, length and hash (never the text itself), the latest 200. In the turns sent, a message where those parts are found carries `pastes: [{ start, end }]`, which a client may show as one card each. A part the CLI wrote down differently isn't found and shows as text.

## Compatibility and deprecations

While `contractVersion` stays 1, the backend keeps the fields and endpoints below for older clients. New clients shouldn't rely on them: a later version removes them, and its release notes will say so.

| Kept for older clients | New clients read |
|---|---|
| `error` in error responses (the same as `message`) | `code`, `message`, `params` |
| A session's `status`, `claudeClearPending`, `turns` (still sent by the existing endpoints, not by `GET /sessions/events`) | `activity` and `turnPhase`, `clearPending`, `GET /sessions/:id/conversations/:conversationId` |
| The sentence in `lastError` when stuck | `stuckSince` |
| `（已中斷）` at the end of reply text | `assistant.interrupted` |
| `path` in upload responses, `imagePath` on notes | `attachment` |
| `POST /sessions/:id/recover-claude` | `POST /sessions/:id/recover` |
| `GET /sessions/:id/messages` | `GET /sessions/:id/conversations/:conversationId` |
| `GET /sessions/:id/pane` | `GET /sessions/:id/pane/stream` |
| `POST /sessions/:id/resume` (only sets the reply state back to ready for input; its name is easily confused with `/conversations/:id/resume`) | Nothing needed |

A client facing an older backend goes by whether there is `GET /meta` and which `capabilities` it declares, degrading item by item: a feature that isn't declared isn't offered, never assumed.

## Conversation search scope

`GET /sessions/search?q=...&limit=20&cursor=...` accepts an optional `sessionId` (1–256 characters). When provided, only that tmux session's conversations are searched, with filtering applied before pagination. Omit it to search all sessions outside the trash. The response format and existing cursors are unchanged.

## Directory selection and search

DTOs are defined in `contract/fs.ts`. Both endpoints take the user's login token only (the tool token gets 403 `login_required`, since 2026-10-13) and return directories only.

- `GET /api/fs?path=...&base=...` returns `DirListing`. Omitting path selects the host HOME. Absolute paths, `~/`, and paths relative to base are supported; the canonical path must be a readable directory. Base defaults to `/`.
- `GET /api/fs/search?path=...&query=...` requires a nonempty query of at most 1024 characters and a path of at most 4096 characters, without NUL. Matching is case-insensitive, literal contiguous substring matching against descendant relative paths, including across `/`. Returns `DirSearch`; each entry includes its relativePath for display and highlighting.
- Traversal is bounded by 2000 directories, 20000 entries, 100 results and 1500ms. Disconnecting cancels traversal. No directory names are silently excluded. Directory symlinks can match, but are not traversed. `incompleteReasons` are `timeout`, `limit`, `unreadable` and `symlink`.
- With `complete=false`, candidates can be accepted manually but a single returned entry does not prove uniqueness. Even with complete=true, the frontend must consider edit intent before completing.

Compatibility: `/meta` announces `filesystem_search`. Clients call recursive search only when declared. Older hosts retain current-level substring filtering with a visible limitation and no auto-completion. The pure domain module resolves `~/` and `../` to absolute paths using the initial HOME and current canonical base, so direct paths also work on older hosts.

Product terms follow [Product terminology](terminology.en.md).

## Login session management (`auth_sessions`)

- `GET /api/auth/sessions` returns `LoginSessionsResponse`: `{ sessions: [{ id, createdAt, lastUsedAt, expiresAt, current }] }`. Times are Unix milliseconds; `expiresAt` is the earlier idle or absolute deadline. Only active sessions of the same account and local-only identity appear. No token or stored token digest is returned; responses use `Cache-Control: no-store`.
- `DELETE /api/auth/sessions/:id` returns `{ ok: true, revoked: boolean }` and only revokes the caller's account sessions. Both endpoints require a user login; anonymous requests and local tool tokens receive 403 `login_required`. Public IDs use a separate hash and cannot authenticate API requests.
- Logins expire after 90 days at most, or 30 days without use. The same deadlines apply after restart. Revocation immediately closes that login's SSE connections and invalidates unused stream tickets and media tokens without affecting other logins. Each SSE event and heartbeat also checks parent-login expiry.
- Logout, pairing revocation, and individual revocation await a successful state-file write before reporting success. Write failure returns 500 `internal_error`; the session remains revoked in memory and the request can be retried. Anonymous or random-token logout does not write state.
