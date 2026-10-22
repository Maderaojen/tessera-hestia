# Account status (usage / 5-hour / 7-day quota)

- Updated: 2026-10-19
- 中文: [account-status.md](account-status.md)

Implemented in `api/src/account-status/`. To check it on a real machine, run `cd api && npm run probe-account-status`: it queries again right away, writes the result to the snapshot file, and prints it.

## The snapshot file and when it updates
Every query result is written to one file, `STATE_DIR/account-status.json` (for the state folder see `docs/guides/install.en.md`; default `~/.config/madera/hestia/account-status.json`).
**Reads only ever read this file; they never wait for a CLI.**

| Trigger | When | What happens |
|---|---|---|
| `schedule` | At :00 / :15 / :30 / :45 every hour (a `setTimeout` inside the API process, aligned to the quarter hour) | All accounts are queried again |
| `startup` | When the API starts and the snapshot file is missing or older than 15 minutes | All accounts are queried again |
| `view` | The frontend opens the sidebar (`POST /refresh {force:false}`) | Queried again only if the snapshot is older than 5 minutes |
| `manual` | The frontend's ↻ button (`POST /refresh`, force by default) | Always queried again |

- Only one sweep runs at a time; calls arriving later share the one in progress. Accounts are queried one after another, never several CLIs at once.
- The file is written to a temp file and renamed, so a reader never sees half-written content.
- `POST /refresh` doesn't wait for the sweep: it returns the current snapshot at once, with `sweeping: true` and HTTP status 202. The frontend then polls `GET` according to `sweeping`: every 3 seconds while a sweep runs, otherwise every 30 seconds (only while the sidebar is open). So results from a scheduled sweep show up on screen by themselves too.
- **When one account fails temporarily** (`error`), its last successful numbers are kept and marked `stale: true`, with `error` and `lastSuccessAt` recorded. The screen shows "data from N minutes ago".
- **A definite result** (not signed in, not installed, unsupported) replaces the old data outright.
- Cost: each sweep really starts the CLI once for every Claude account (about 3–5 seconds, using no quota), and records one `/usage` entry in each account's `history.jsonl`. That entry is filed under the probe folder's project, so it never shows up in the history ↑ brings up in other projects.

## Where accounts come from
`janus list --json`: Janus accounts are started with `janus run <name>` (the same as opening a session);
default accounts with `source: native` run the CLI directly. Without Janus, it falls back to the native defaults of claude/codex/gemini.
Native accounts clear any inherited `CLAUDE_CONFIG_DIR`, so the parent process's settings can't steer a query to a different account.

## Per provider (principle: official API > official CLI; never read tokens, never call non-public endpoints; the one exception is under "Login expiry and logging in again")

| Provider | Method | Data | Verified (2026-09-24) |
|---|---|---|---|
| Codex | The official `codex app-server` JSON-RPC: `account/read`, `account/rateLimits/read` | Plan, 5h/7d used %, reset times, credits | ✅ codex-cli 0.156.1, tested with 3 accounts (one not signed in) |
| Claude | The official CLI: start `claude --safe-mode` on a separate tmux socket (`hestia-usage-probe`), send `/usage`, parse the screen | 5h/7d (and per-model weekly) used %, reset times; plan and email from `oauthAccount` in `.claude.json` | ✅ Claude Code 2.1.281, tested with 3 accounts |
| Gemini | Not implemented | — | No `gemini` CLI installed here; reports `not_installed` |
| Copilot | Not implemented | — | Reports `unsupported` |

### Claude details
- Anthropic has no public API for subscription usage. `api.anthropic.com/api/oauth/usage` is a non-public endpoint (it needs an OAuth token and has a strict rate limit), and is **deliberately not used**.
- The statusLine JSON in the official docs also has `rate_limits`, but only passively, while a session is running, and it would mean changing every account's settings, so it wasn't adopted.
- The probe runs in `STATE_DIR/usage-probe` (an empty folder). The first query for each account shows "trust this folder", and Yes is chosen automatically.
- It starts with `--safe-mode`, so the account's hooks, plugins, MCP servers and CLAUDE.md are not loaded; otherwise every query would run the user's `SessionEnd` hooks when it ends.
- `/usage` is a local command and sends no model request (the panel shows `Total cost: $0`). Each takes about 3–5 seconds.
- When the API runs as a systemd user service, PATH only has the system defaults. The probe adds `~/.local/bin` and the bin folder of the service's node itself. Environment variables are passed into the pane through `env(1)`, because tmux 3.4 ignores `new-session -e PATH=…`.
- Reset times are the panel's text (for example `Resets Sep 25, 12am (Asia/Taipei)`), converted to ISO using the time zone in it; a format it can't read gives `resetsAt: null`, with the original text kept in `resetsText`.
- Risk: if a CLI release changes the panel's text, parsing breaks. The fixtures are real captured screens (`api/test/account-status/fixtures/`) and can be updated directly when that happens.

### Gemini (candidates for when it is done)
CodexBar's approach: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`, but that is a non-public endpoint too.
Following "official CLI first", Gemini CLI's built-in `/stats` should be evaluated first.

## Login expiry and logging in again (Claude, capability `account_login`)

### Reading when a login expires: the one exception to "never read tokens"
The Claude CLI only warns "Your login expires in N day(s) · run /login to renew" in a conversation once fewer than 3 days are left, and there is no official way to ask earlier. So Hestia reads **exactly one field** from `.credentials.json` in each Claude account's config dir: `claudeAiOauth.refreshTokenExpiresAt` (ms timestamp). The decision is ADR 0028.

- The config dir is the account's `home` (from `janus list --json`; `~/.claude` for the native default, `~/.claude-<name>` for a Janus account), not a hardcoded path.
- Rules (`account-status/login-expiry.ts`): read the file, parse the JSON, take out only this number; every other field (tokens, scopes, plan) is never kept, logged, returned or written to the snapshot. A missing file or field (e.g. macOS keeps it in the Keychain) or broken content is "unknown", with no error message logged (a JSON parse error's message quotes the file).
- Refreshing the access token does not extend it; only a new login does (Claude Code 2.1.296). Once it has passed, the CLI asks for a login when the access token (about 8 hours) runs out; Hestia doesn't read the access token's expiry and simply reports "expired".
- Every sweep reads it (even when the CLI isn't installed or the query fails); the snapshot keeps `login: { expiresAt, state }`. `state` is worked out again from the current time on every read: `ok`, `expiring` (within 3 days, as the CLI), `expired`, `unknown`. Unsupported providers have `login: null`. When a temporary failure keeps old numbers, `login` is still this sweep's reading.

### Frontend
- Sidebar quota: under the account's name, "Login expires in N d" (hours when less than a day) or "Login expired", with "Sign in again" beside it; an account the CLI asks to sign in (not signed in) gets the button too.
- A session's quota on the chat page: a dot on the orb and before the desktop summary's heading (yellow when expiring, red when expired or signed out); the open card has a line about it and "Sign in again" beside it.
- A native default account that is the same person as a Janus account is normally hidden; but their logins expire separately, so it stays visible while its own login needs attention.

### Logging in again from the app
The backend runs the CLI's own login the way the account is normally started: Janus `janus run <name> auth login --claudeai [--email <known email>]`, native `claude auth login --claudeai [--email …]` with `CLAUDE_CONFIG_DIR` cleared. Over pipes (its own process group, `BROWSER=true` so no browser opens), it reads the sign-in URL the CLI prints and hands it to the app; the user opens it on any device, signs in, and pastes the code the page shows back into the app, which the backend writes to the CLI's stdin. Exchanging and storing the credentials is done by the CLI itself; Hestia never sees a token. The URL is the official manual-code page (`redirect_uri` `platform.claude.com/oauth/code/callback`, not localhost), so it can be finished on a phone.

| Method | Path | Response |
|---|---|---|
| POST | `/account-status/:accountId/login` | 201 `{ loginId, url, state: 'awaiting_code', expectedEmail }`; 409 `login_in_progress` when the account is already signing in; 400 `login_unsupported` for a provider that can't; 502 `login_start_failed` when the CLI gives no URL within 30 seconds |
| POST | `/account-status/logins/:loginId/code` `{ code }` | `{ state: 'succeeded' \| 'invalid_code' \| 'failed', email, emailMatches }`; after `invalid_code` another code can be sent; 409 while the previous one is being checked |
| DELETE | `/account-status/logins/:loginId` | 204; cancels and ends the CLI |

- Only the user's own login (`requireLogin`): the local tool token (which any LLM in a tmux has) always gets 403 `login_required`, so an LLM can't replace an account's credentials.
- One per account at a time; 10 minutes without finishing, cancelling, failure or success ends the whole process group. Logins live in memory only.
- The code's shape (`code#state`) is checked first; one that doesn't fit is answered `invalid_code` without reaching the CLI.
- After success it runs `auth status --json` the same way, takes only `email`, and compares it with the email known before (`emailMatches`; the app warns on a mismatch), then re-reads quota in the background (a new sweep after any one already running).
- Security rules: the CLI's output is only matched against keywords and for the URL; the code is written to stdin and forgotten. Logs carry the account id and an outcome (started, succeeded, failed, cancelled, timed out) only; error messages are fixed texts, never the CLI's output or what the user typed.
- Not yet verified: a full login has not been run against a real account (it would replace its credentials; the protocol is tested with a fake CLI); finishing the sign-in page on a phone; whether a running CLI picks up the new credentials by itself (for now the app only suggests restarting that CLI if it still asks to sign in).

## How the frontend shows it

- **The sidebar's "Quota" section**: every account whose quota can be read.
- **The session quota on the chat page**: shown only while the CLI is running: the account and provider this session uses, 5h/7d usage and reset times. It can be turned off in settings (Settings › General › Usage display › Show usage in conversations, on by default; this device only); on the phone the header has no quota switch: the orb hides itself from its long-press menu and Settings shows it again.
  - **Phone**: a small 48px frosted-glass orb at the right, below the header (`QuotaOrb.vue`): the outer ring is 7-day usage, the inner ring 5-hour usage, and the two lines in the middle are the time left until reset (`formatUntilReset`: 5h in hours with one decimal, in minutes under an hour; 7d in whole days, in hours under a day, in minutes under an hour; always rounded up). A tap animates the circle's size and corner radius into a detailed frosted-glass card (full reset times, plan, how fresh the data is); another tap, a tap elsewhere, or Esc shrinks it back. The orb can be dragged: it follows the finger as soon as it moves, and when let go settles on the nearer left or right edge, staying between the bottom edge of the header's own row and the composer's top (not counting the terminal peek and git panel that drop down from the header: opening them doesn't move the orb, which stays on top of them); its place is kept on the device (`hestia:quota-orb`: the edge and a fraction of the height), and the card opens toward the middle of the screen (rightward from the left edge, upward in the lower half). Holding it still for about half a second opens a menu: hide the quota, or put the orb back where it started (top right). The conversation no longer keeps room for the orb; if it covers something, drag it away.
  - **Frosted glass caveat**: the orb has to sit **outside** the header (`.chat-quota-anchor` in `ChatView`, aligned to the header's measured bottom edge). The header is itself a `backdrop-filter`; inside it, the header becomes the backdrop root and the orb could only blur the header. Headless Chromium still skips the card's blur on this page (WebKit is fine), so the card's background is raised to 78% opacity, keeping the text clear in every engine.
  - **Desktop**: three lines of faint small text left of the header's terminal button; a click lays a clear card over them without shifting the layout.
  - All three layouts share `SessionQuotaContent.vue` (the title, one line each for 5h and 7d, the details).
- **Account mapping**: the backend's public field `quotaAccountId` is derived from the session's launch settings and holds only an id, never a path: `janus:<provider>:<profileName>` for a Janus launch, `native:<provider>:default` for a native one. Agy and the old Gemini CLI have no quota source yet and return null; the card says quota lookup isn't supported yet.
- **Updates**: while the sidebar or any session card is on screen, the frontend reads the snapshot every 30 seconds (the multi-viewer polling in `quotaState.ts`); each new viewer asks for `refresh {force:false}` only once, and actually querying the CLI is still bounded by the 5-minute minimum, so showing it costs no extra quota.
- **The quota meter's "port"**: `QuotaMeterProps = { percent: number | null; tone }` is the interface every style implements; `QUOTA_METERS` maps the style chosen in settings to its component and the width it reserves. There are `bar` (a bar, the default) and `ring` (a circle). A new style is one component taking these props, registered there, and `quotaMeter.spec.ts` checks it against the same contract automatically. The sidebar and the session card only use it through `QuotaMeter`, so changing the setting switches both.

Product terms follow [Product terminology](terminology.en.md).
