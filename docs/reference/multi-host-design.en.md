# Multi-host design (open platform)

- Updated: 2026-10-21
- 中文: [multi-host-design.md](multi-host-design.md)

## Goal, and what doesn't change

The frontend (the Hestia app) lets every user point it at their own backend: set the backend's address, sign in, get a bearer token. The web version uses the same API but isn't offered; the app reaches the backend by its Tailscale address or through an SSH tunnel (see "Security boundary: the backend is never exposed to the internet" below).

**The frontend comes with no backend** (since 2026-09-28): there is no "default host", and the author's own backend isn't offered either. On first open there are no hosts, and the router sends every page to the add-host form on the sign-in page; the author's own backend is connected by adding a host too.

## Authentication

| Use | Credential | Where it goes | Lifetime | Scope |
|---|---|---|---|---|
| The API in general | Sign-in token | `Authorization: Bearer` | At most 90 days; sign-out, revocation, 30 days idle or a password change expires it earlier (API restarts do not affect it) | Everything |
| Live streams (`EventSource`) | Stream ticket | `?ticket=` | 60 seconds, invalid once used | Only `GET /sessions/:id/events`, `/sessions/:id/pane/stream` |
| Images (`<img>`) | Media token | `?media=` | 30 minutes, reusable | Only `GET /sessions/:id/uploads/:file`, `/notes/uploads/:file` |
| The local CLI | Local tool token | `X-Hestia-Token` | Until the API restarts | Everything, direct local connections only |

- `POST /auth/login` and `POST /auth/pair` return the token in the body only and set no cookie; every later request carries it as `Authorization: Bearer`. The backend **doesn't accept cookies**: a browser attaches a cookie to requests any site makes (a form posted from another site, say), while a header can only be set by the page that got the token.
- **Version check**: when adding a host (and when signing in to the current host again), once sign-in succeeds the frontend reads `GET /meta` with the new token, and saves and uses the host only if `contractVersion` equals the frontend's `CONTRACT_VERSION`. If it differs, or there is no `/meta` (an old backend), it signs that token out, saves nothing, and explains whether the backend or the app needs updating (`ensureCompatible` in `shell/hostSwitch.ts`). `/meta` sits behind sign-in, so the check can only come after sign-in.
- `POST /auth/logout` revokes the request’s sign-in token, its media tokens and unused stream tickets, and closes existing SSE streams. Backends advertising `auth_sessions` provide Signed-in devices in settings, showing creation, last use and expiry with individual revocation; revocation also invalidates derived credentials and streams immediately.
- The rule for local-only accounts (`AUTH_LOCAL_USERS`) applies to every kind of credential: any request that was forwarded (carrying forwarding headers) is refused.
- **A direct local connection must use a loopback Host**: a request treated as local (direct over loopback, without forwarding headers) must have `Host` set to `127.0.0.1`, `localhost` or `[::1]` (any port), or it gets 403 `host_not_allowed`. This stops DNS rebinding: another site pointing its own domain at 127.0.0.1, so that a browser on this machine connecting directly to the API would be treated as local. Requests relayed by `tailscale serve` and the like carry the public domain and forwarding headers and aren't affected; a development proxy has to set Host to 127.0.0.1 (Vite's `changeOrigin`, for example).
- **Scan-to-pair asks first** (the same on the web and in the app; the link formats are in "Pairing links" in `docs/reference/api-contract-v1.en.md`, and the app uses `hestia://pair?url=…#code=…`): when a link with `#pair=` opens, the code is removed from the address bar at once and kept only in memory; the screen first shows the full origin of the host to be added, and `POST /auth/pair` is called only on "Add and sign in"; "Cancel" discards the code and the address. An address that isn't `.ts.net` gets an extra warning line. Anyone can send such a link, and pairing automatically would let them quietly add, and switch you to, their backend.
- **Where sign-in lockout counts attempts from**: in order, the **last** entry of `X-Forwarded-For` (`tailscale serve` puts the address it saw last, so the earlier entries are the client's own), then the socket address. `CF-Connecting-IP` and `X-Real-IP` aren't used: `tailscale serve` passes the client's own value through unchanged, so trusting either would let every guess claim a new source. A request through an SSH tunnel carries no forwarding header, so its source is the socket address (this machine). Each source is locked for 15 minutes after 5 failures; 50 failures across all sources within 15 minutes (`AUTH_GLOBAL_MAX_LOGIN_FAILURES`) pause all sign-ins until the older failures are 15 minutes old. Passwords are checked with asynchronous scrypt, run exactly once per attempt (against a fixed dummy hash when the account doesn't exist), so timing doesn't reveal whether an account exists.
- Tokens, tickets and media tokens are all stored on the server keyed by their SHA-256, and lookups compare digests, so a guess sharing a prefix doesn't leak a timing difference.
- The long-lived sign-in token **never goes into a URL**. Only tickets and media tokens appear in URLs, and both have a path allowlist (case-sensitive, no trailing slash, GET only); anything outside it gets 401.
- **Sign-in tokens survive API restarts**: sign-in tokens issued by `POST /auth/login` and `POST /auth/pair` are written to `session-tokens.json` in the state dir (mode 0600; `loadSessionTokens` in `auth.ts` reads them back on start, before listening). The file holds only each token's SHA-256, the account (`username`, `localOnly`), a fingerprint of the password hash, and timestamps, **not the tokens themselves**, so reading the file doesn't let anyone sign in. Stream tickets, media tokens, pairing codes and the local tool token still live only in memory (short-lived, or reissued on every start).
  - **Expiry**: a token expires after 30 days idle (`SESSION_TOKEN_IDLE_TTL_MS`) or 90 days from issue (`SESSION_TOKEN_MAX_TTL_MS`); daily use never extends that maximum. Last-used timestamps are persisted at most hourly (`SESSION_TOKEN_TOUCH_INTERVAL_MS`), not on every request.
  - **Changing the password signs everyone out**: each token remembers a fingerprint of the password hash it was issued under. Running the installer again or `npm run set-credentials` produces a new `AUTH_PASSWORD_HASH` (a new salt even for the same password), and after a restart every old token is void. A local-only account is checked against its own hash in `AUTH_LOCAL_USERS`.
  - **An account that's gone**: if `AUTH_USERNAME` is renamed, or a local account is removed from `AUTH_LOCAL_USERS`, its tokens are dropped at restart. The local-only rule still applies after a restart.
  - If the file is missing, damaged or in a format it doesn't recognize, it logs one line and starts with no tokens (everyone signs in once more); it never keeps the API from starting.

### Why streams use one-time tickets, and images media tokens

- `EventSource` can't send headers. Only one stream is open at a time, and the frontend reconnects after a drop anyway, so before each connection it trades for a one-time ticket with `POST /auth/stream-ticket` (`openEventStream` in `api.ts`, reconnecting with a new ticket 3 seconds after a drop).
- Images are different: one screen has many, and the browser may reload any of them at any time. A one-time ticket per image would mean an extra request per thumbnail, and would fail on reload. So they use a reusable media token that can only read images instead. The frontend keeps it in a reactive ref read while rendering; it is renewed halfway through its lifetime, and renewing rebuilds every image URL. The worst case if it leaks is that, for a few minutes, someone can read the images the user uploaded; it never becomes a way to sign in.
- Another option was fetching a blob and turning it into an object URL. That would make `uploadedImageUrl()` asynchronous and force changes to the note components (which other branches were changing at the time), so it wasn't adopted.

## CORS

`CORS_ALLOWED_ORIGINS` is a comma-separated list of frontend origins. Unset or blank, it is `DEFAULT_CORS_ALLOWED_ORIGINS` from `api/src/config.ts`: the four fixed Hestia app WebView origins, Capacitor iOS `capacitor://localhost`, Capacitor Android `https://localhost`, Tauri macOS `tauri://localhost`, and Tauri Windows `http://tauri.localhost` (`APP_WEBVIEW_ORIGINS`). A web frontend isn't in the defaults; a backend that wants one lists it. The frontend origins are defined in one place, and the installer asks the built `config.ts` for them too (`scripts/install-config.ts`). When set, the list **replaces** the defaults, so name every app and web origin that should be allowed; the installer warns and prints a command to add missing app origins. `*` is ignored with a warning: allowed frontends are always listed explicitly. Preflight allows bearer `Authorization`. None of the four app WebView origins receives `Access-Control-Allow-Credentials`, even when explicitly included in a custom list; ordinary web origins retain the existing behavior.

The cost of allowing `https://localhost` and `http://tauri.localhost` by default: the corresponding local WebView origins can call the API cross-origin. The backend accepts bearer tokens; all four app WebView origins **never** get `Access-Control-Allow-Credentials`. Anyone who doesn't need the app can list only their own web frontend with `--cors-origins`. `hestia pair --link web` skips all four fixed app origins (including the HTTP `http://tauri.localhost`) and selects an ordinary web origin, falling back to the official web frontend if none is listed.

## Host storage in the frontend

- `lib/hosts.ts` reads and writes `{ id, name, baseUrl, token, connection? }` through synchronous `HostStorage.load()` / `save()`. Web `localStorage` (`hestia:hosts`) holds metadata with every token set to `null`; token-bearing snapshots use per-tab `sessionStorage`, surviving reloads and host switches in that tab. Closing a tab does not guarantee continued login; browser session restoration can restore sessionStorage. Legacy persistent tokens are scrubbed from localStorage before migration into the current tab and never override an explicitly logged-out tab. Native apps use platform secure storage (below).
- The optional `HostStorage.flush()` waits for queued writes and reports failures; the browser adapter also implements it to report browser storage errors. The previous tab snapshot is removed before replacement so failed replacements cannot revive an old token.
- Full page loads use `afterHostWrites()`; ordinary logout and removal wait for `flushHostWrites()`. Storage failures display an error and stop successful navigation. Native write errors propagate, and failure to delete unreadable stored credentials stops initialization.
- `baseUrl` accepts HTTPS or loopback HTTP without credentials, queries or fragments. Existing `http://[::1]` metadata is retained, but the API client explicitly refuses direct HTTP IPv6 loopback because Chromium rejects IPv6 literals in CSP host sources. The error asks for HTTPS or adding localhost again and signing in. Credentials are never silently redirected to localhost, which could reach a different IPv4 service. Development and SSH tunnels should use the explicitly allowed `localhost` / `127.0.0.1`.
- The add-host form lets you leave out `https://`: `machine.tailnet.ts.net` is taken as `https://machine.tailnet.ts.net` (`http` still has to be written out, and is still loopback only). `.ts.net` is never added for you: the tailnet's name can't be guessed, and a bare machine name (such as `my-pc`) fails TLS, so the form asks for the full Tailscale address instead. Saved hosts and the address in a pairing link still need the full `https://`.
- `connection`: without it, the host is a **URL** host (reached straight at `baseUrl`; the only kind on the web). The app's **SSH** hosts carry a `connection`: the SSH server (host, port, user), the Hestia API as seen from the SSH server (default `127.0.0.1:4791`), a reference to the credentials (a key id or a password id; the secret itself isn't here), the host key the user confirmed, and the `localPort` of the listener on the phone. Older data has no such field and is read as it is; nothing to migrate.
- An SSH host's `baseUrl` is always `http://127.0.0.1:<localPort>` (never `localhost`: the app's own pages are at `https://localhost`, and Capacitor intercepts every request to `localhost`). `localPort` is picked at random (30000–59999) when the host is added and then kept, so everything that reads `baseUrl` synchronously (the API client cache, image URLs) stays as it is. If another app happens to hold that port, the tunnel binds another one and the app updates the host's `localPort` and `baseUrl`, reloading the page if it is the current host.
- Telling whether a host is already in the list: URL hosts compare `baseUrl`; SSH hosts compare the SSH server, user and remote API (not the phone's port). The same backend reached both ways is two hosts, each signed in on its own.
- `api.ts` resolves the current host on each call, never at build time.
- Adding a host is signing in: it is saved only once sign-in succeeds. If the host is already in the list, only that host's token is updated (an SSH host's host key must match the one saved; if it doesn't, the new key has to be confirmed in that host's details first).
- Switching hosts reloads the page: sessions, projects, quota and streams are spread across module-level stores and mounted views, and a reload is more reliable than resetting each one.
- The reload is covered by a mask (the handover and state in `shell/hosts/hostSwitchMask.ts`, covering in `hostSwitchCover.ts`, taking over and lifting in `hostSwitchResume.ts`): it grows out of the tapped card or sidebar row (or fades in, for a gesture); once it covers the screen, `{ hostId, hostName, startedAt, fromId, look }` goes into the tab's sessionStorage (`hestia:host-switch`) and the page reloads. On the new page `public/host-switch-boot.js` paints the same mask in the first frame; when the note is under 10 seconds old and for this host, the app takes over and fades it once the list first shows. An SSH host also waits for its tunnel; when it fails, or isn't up in 20 seconds, the mask says why, with a retry and the way back to the previous host. The note holds only the host's id, name and look, never a token.

### Host storage in the native app

- The host list (tokens included) is kept in the platform's secure storage: the iOS Keychain, and on Android SharedPreferences encrypted with a Keystore key (`@aparajita/capacitor-secure-storage`), under one key `hosts` with the prefix `hestia.`, never in the WebView's `localStorage`.
- iOS: not synced to iCloud, with the access level `whenUnlockedThisDeviceOnly` (readable only while unlocked, never carried to another device by a backup). Android: `allowBackup="false"`; Keystore keys are never backed up anyway.
- **Startup order**: read it once from the secure storage into memory, swap in the native implementation with `setHostStorage()`, and **only then** mount the app (the router's first guard already reads the current host). After that `load()` returns the snapshot in memory; `save()` updates memory first, then queues the write on a sequential queue (the last write always finishes last); `flush()` waits for the queue to drain.
- **Reinstalling on iOS**: uninstalling an iOS app doesn't delete its Keychain items. The app keeps an "this install is initialized" flag in plain app preferences (deleted on uninstall); without it, everything under the `hestia.` prefix is cleared first, so a reinstall never shows the previous hosts and tokens.
- **Unreadable data** (corrupted, or its key gone): once the entry is successfully deleted, the user is told to add their hosts again. If deletion fails, initialization stops rather than allowing old credentials to reappear at the next start.

### Frontend development server

Vite listens on `127.0.0.1:3000` by default and uses an explicit hostname allowlist. To connect through a trusted reverse proxy or another development device, specify the listen address and comma-separated hostnames from `web/`:

```sh
VITE_DEV_HOST=0.0.0.0 VITE_DEV_ALLOWED_HOSTS=dev.example.test npm run dev
```

List only development domains you control, never allow all hosts. Keep firewall and proxy access restricted to development use. `VITE_DEV_BASE` controls the development path, defaulting to `/dev/23000/`. These settings affect the frontend development server only; the backend remains restricted to loopback.

### Security boundary: the backend is never exposed to the internet

A Hestia backend amounts to full control of its machine: once signed in, it can run any command as the user. So the backend **listens on loopback only** (`HOST` may only be `127.0.0.1`, `::1` or `localhost`; it refuses to start on any other address), and other devices reach it in exactly two ways:

- **Tailscale**: `tailscale serve` on that machine relays HTTPS from the tailnet to loopback, reachable only from devices in the user's own tailnet (the installer's `--tailscale`).
- **SSH (the app)**: the app opens a port forward to loopback through the user's own sshd (see "SSH connections (the app)" below). This path is exactly as secure as that sshd, which should allow key authentication only.

Exposing the backend to the internet by any other means (a reverse proxy, a tunnel service, a port forward on a router, a changed listen address) is unsupported and should not be done: then the only thing protecting it is the username and password. The backend still treats any request carrying a forwarding header (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`) as relayed rather than local, so even if someone puts a relay in front of it anyway, local-only accounts and the local tool token aren't opened up by it; that is an extra safeguard, not support for such a setup.

### Security boundary: all hosts share one origin

Web host tokens share the frontend origin’s per-tab sessionStorage and runtime; localStorage retains metadata only. DOMPurify and escaping protect rendered backend content, but frontend XSS can still access all hosts currently signed in within that tab. Only add trusted backends. Native secure storage protects credentials at rest, not against malicious JavaScript running in the app. CSP restricts script sources and framing; HTTPS API destinations remain broad to support user-selected hosts, so CSP does not prevent every possible data leak.

## localStorage partitions

`lib/storageKeys.ts` manages every key:

- **Device scope**: settings, layout, sidebar, note filters and host metadata; credentials are excluded from localStorage.
- **Host scope**: `sessions-snapshot`, `sessions-cached-at` (when the list was cached, for the host overview's cards), `projects-snapshot`, `account-status`, `chat-scroll`. Each host uses `hestia:host:<id>:<name>`.
- "Clear local cache" under Settings › About & maintenance (it asks first) clears every host's cache; removing a host clears only that host's data.

## Push notifications

**Model: on the web, a browser receives one host's notifications at a time; the iOS/Android app has a switch per host and can receive several at once.**

- A browser has only one push subscription, bound to one `applicationServerKey`; each backend signs with its own VAPID key, so receiving two hosts' notifications at once is technically impossible.
- The switch under Settings › Notifications refers to the **current host**. Its states are `on`, `off` and `elsewhere` (held by another host, which the hint names). Turning it on moves the subscription to this host and, with the old host's own token, tells the old host to unregister. After switching hosts, you see that host's state.
- When subscribing, the frontend sends the id it gave this host (`hostId`, URL-safe characters only). The backend stores it in the subscription and adds `?host=<id>` to every notification's link. Opening a notification makes the router switch to that host first, then open the conversation.
- A subscription created by the removed default host has an owner this browser can no longer find, and shows as `elsewhere`; turning notifications on for the current host just replaces it (there is no host to tell to cancel; when that backend later sends a push it gets an "expired" response and cleans up by itself).
- When `push-handler.js` decides whether the conversation is already on screen, it compares only the path, not `?host=`: session ids are random UUIDs, so a path maps to one conversation on one host.
- Notifications are turned off before removing the host that holds the subscription.
- Not done on the web: a central relay, or the frontend providing one shared VAPID key so several hosts can push at once. To be evaluated when receiving several hosts' notifications at once in a browser is really needed.
- **The app**: its WebView has no Web Push, so it goes through the app publisher's push relay to FCM (see "The app's push subscriptions" in the [API contract](api-contract-v1.en.md)). The same phone's subscription credential can be given to any number of hosts, so each host has its own switch and there is no `elsewhere` state; a backend too old for it (no `native_push`) shows as `outdated`. Notification links carry `?host=` as well, and opening one switches host first. While the app is in the foreground it shows no system notification but an in-app notice instead, and none for the conversation on screen.

## Where the native app plugs in

- **Storage**: see "Host storage in the native app" above.
- **Pairing links**: the app registers the `hestia://` scheme and takes the link from `hestia pair --link app` (on a cold start and while it is open) to the same confirmation as the web's `#pair=`, calling `POST /auth/pair` only once confirmed. The pairing code is kept in memory only, never in the address or the history.
- **Push**: see "Push" above (the app goes through the push relay and FCM / APNs, with a switch per host).
- **API client**: `createApiClient(host)` in `apiClient.ts` makes one instance per host (requests, uploads, media token and streams all bound to that host), and `clientFor(host)` caches it per host id, swapping in a new one when the address or token changes. The functions in `api.ts` fetch the current host's client on each call, so switching hosts behaves the same.
- **SSH**: see the next section.

## SSH connections (the app)

The app (iOS, Android) can reach a host over SSH; the web and the PWA have no such option.

- **SSH is only the transport**: the app opens an SSH local port forward on the phone, `127.0.0.1:<localPort>` → the Hestia API as seen from the SSH server. Everything after that is the ordinary HTTP API (login → bearer → stream ticket / media token, SSE, uploads), and screens and behavior are the same as for a URL host. The remote machine still needs the Hestia backend installed.
- **Connection gate**: `apiClient.ts` has an optional `setConnectionGate`, set only by the app. Every request, upload and stream ticket first waits for the tunnel of its `baseUrl` to be ready (up to 20 seconds); a timeout is handled like a network that's down (retries, "unreachable", a stream reconnecting). Errors the user has to deal with, such as a fingerprint mismatch or a failed login, fail at once. URL hosts' requests go straight through, and the web's request path is unchanged.
- **Tunnel lifetime**: the tunnel lives on the native side, so switching hosts (a full page reload) doesn't break it. The current host's tunnel is kept up while the app is in the foreground; other SSH hosts' tunnels open only when needed (for example to sign out before removing the host) and close after 60 seconds without connections. Thirty seconds after the app goes to the background the SSH connection closes, and it reconnects when the app comes back; a dropped connection reconnects with backoff, at once on a network change. The sidebar's "主機" (Hosts) section doesn't connect to every SSH host just to check on it: one without an open tunnel shows "SSH・切換時連線" (connects when switched to).
- **Status**: when the current host is an SSH host, a banner at the top of the screen shows while it takes over a second to connect, while it reconnects, or when it failed (retry, or go to the host's details).
- **Push doesn't need the tunnel**: notifications go "backend → push relay → FCM / APNs → phone", and the backend only needs outbound internet. The tunnel is needed only to turn notifications on or off for that host, or to subscribe again when the push token changes.
- **SSH secrets stay in native storage, never in JS**: SSH private keys and passwords are kept by the app's native code in storage protected by the iOS Keychain / Android Keystore; JS only gets ids, public keys and fingerprints, and signing and authentication happen natively. There is no way to export a private key. Importing a key by pasting it passes it through the app's screen once (cleared as soon as it is sent), so the screen steers toward importing from a file. Reinstalling on iOS clears the SSH secrets too.
- **Host fingerprints (TOFU)**: on the first connection the app shows the SSH server's host key fingerprint (`SHA256:…`, as `ssh-keygen -lf` prints it) for the user to check, and connects only once trusted. After that the full public key is compared; a different one stops the connection **without sending any credentials**, and the user has to check the new fingerprint in the host's details and confirm twice. There is no "skip this time".
- **Requests through the tunnel are local to the backend**: with a loopback remote API address (the default), sshd connects to the backend from the same machine with no forwarding headers, and the backend treats it as a local request, so **local-only accounts can sign in**. Local requests still need authentication (a username and password, or the local tool token only readable on that machine).
- **Other apps on the phone can reach the tunnel's local port too**: they don't get Hestia's token, still need a username and password and are subject to the sign-in lockout; but to the backend they are "local" as well, so on this phone a local-only account's "local only" means "any app on this phone", and their failed sign-ins count against the same source as that machine's local tools (which may lock local sign-in for a while). The listener binds only to `127.0.0.1`, on a random port, and is open only while the app is in the foreground.

## To do, and known limits

- An SSE stream already open isn't cut off by signing out (it just won't reconnect).
- Push subscriptions aren't tied to an account.
- URLs carrying `?ticket=` / `?media=` may stay in the browser's history or a relay's logs. Both are short-lived and narrow in scope.
- SSH (the app):
  - Private keys: ed25519 and RSA (2048 bits or more) in OpenSSH format. ECDSA private keys, the old PEM format, FIDO / security keys, SSH certificates, jump hosts (ProxyJump), SSH agents and multi-step keyboard-interactive authentication aren't supported. Keys the app generates are ed25519.
  - iOS app: the SSH server needs an ed25519 or ECDSA host key; a server with only an RSA host key can't be reached (a stock Linux or macOS sshd has an ed25519 host key by default). The Android app also accepts RSA host keys (`rsa-sha2-256/512`).
  - iOS app: a passphrase-protected private key can only be read if it is encrypted with aes128/192/256-ctr (the `ssh-keygen` default); one encrypted any other way is reported as unsupported on import.
  - Hardware-backed keys (Secure Enclave / StrongBox) aren't supported.
  - The app doesn't run commands on the remote machine over SSH; to sign in with a pairing code, run `hestia pair` on the machine yourself and paste it into the app.
  - An SSH host's name, SSH address and remote API address can't be changed once added (remove it and add it again); its credentials can be changed in the host's details.
  - No tunnel in the background: it disconnects 30 seconds after the app goes to the background and reconnects when it comes back (notifications aren't affected).
  - The iOS app needs iOS 18 or later (provisional).
  - `http://` has no HTTP/2, so one SSH host takes at most 6 connections at a time; the app keeps at most 3 streams open.

Product terms follow [Product terminology](terminology.en.md).
