# Installing the Hestia backend

- Updated: 2026-10-22
- 中文: [install.md](install.md)

The frontend is the Hestia app (iOS/Android). It doesn't touch your computer, and it **comes with no backend**: everyone runs a backend on their own machine, then points the frontend at it with "Add host". This document explains how to install that backend. Nothing here needs root, not even Tailscale.

> **The backend must not be exposed to the internet.** A Hestia backend amounts to full control of this machine: once signed in, it can run any command as you. It listens on this machine only (`127.0.0.1`), and other devices reach it in exactly two ways: **Tailscale** (`--tailscale`, see "Reaching it through Tailscale") or the **Hestia app's SSH connection** (see "Connecting over SSH"). Don't expose the backend to the internet by any other means (a reverse proxy, a tunnel service, a port forward on your router, a changed listen address): then the only thing protecting it is the username and password.

## Requirements

- Linux (a systemd user service; without systemd it can run in the foreground), or macOS (a launchd LaunchAgent, running while you are logged in at the Mac; see "macOS"). On Windows, install inside WSL (which is Linux; see "Windows")
- Node.js: **you don't have to install it.** If the system's node satisfies `engines` in `api/package.json` (currently 22.12 or later), it is used; if it is missing, too old (for example v20) or comes without npm, the script downloads the latest official release of the same major version from nodejs.org, verifies its SHA-256 and puts it in `~/.local/share/hestia/node/`, for your user only. The system's node is left alone
- tmux (macOS: `brew install tmux`)
- At least one AI CLI: `claude`, `codex`, `gemini` or `agy` (installing works without one, but you can't open a conversation)
- Recommended: a [Tailscale](https://tailscale.com/) account (free for personal use), with the Tailscale app installed and signed in on your phone. On Linux the installer takes care of Tailscale on this machine, so you don't install it yourself; on macOS, install the Tailscale app and sign in first

## Install

### Signed release install (trusted public key required)

First independently provision the release public key and trusted local installer as described in [release signing](release-signing.en.md). The new installer requires both a trusted key and a signature; maintainers must bootstrap the first signed release. Old unsigned releases are unsupported.

```bash
HESTIA_RELEASE_PUBLIC_KEY=/path/to/trusted-release-public.pem sh /path/to/trusted-install.sh --tailscale
```

Every argument after the trusted installer path is passed unchanged to the installer (see the options table below). This line:

1. Downloads the latest bundle `hestia-vX.Y.Z.tar.gz` along with `SHA256SUMS` and `SHA256SUMS.sig` from [GitHub Releases](https://github.com/maderaojen/tessera-hestia/releases), first verifies the release signature, then its SHA-256, and checks that no path or link in the bundle leads outside `hestia-vX.Y.Z/`.
2. Unpacks it into a staging folder `~/.local/share/hestia/app.new/`, carries over the current install's `.env`, and runs `npm ci --omit=dev` (the bundle is already built; nothing to build). If this step fails, the existing install is left exactly as it was.
3. Swaps it in as `~/.local/share/hestia/app/`, then runs the bundle's `scripts/install.sh` (account and password, the user service (systemd on Linux, launchd on macOS), Tailscale, the pairing QR code). Its questions are asked on the terminal.

Environment variables adjust it: `HESTIA_VERSION=vX.Y.Z` (a specific version; default: the latest) and `HESTIA_HOME` (default `~/.local/share/hestia`). For example `HESTIA_VERSION=vX.Y.Z sh /path/to/trusted-install.sh`.

**Running it again upgrades**: settings and data both live in the state folder `~/.config/madera/hestia/` (the settings are its `.env`), and are kept, the service restarts, and conversations in tmux are not affected.

### From source

```bash
git clone https://github.com/maderaojen/tessera-hestia.git
tessera-hestia/api/scripts/install.sh --tailscale
```

This runs `npm ci` and builds locally. To upgrade: `git pull`, then run the same script again.

### Installer options

Below, `api/` means the program folder: `~/.local/share/hestia/app/` for the one-line install, the repo's `api/` when installed from source.

The script asks for the account, the password (not echoed) and the port, and uses defaults for the rest. To avoid questions, give everything as options:

```bash
printf '%s\n' "$PASSWORD" | api/scripts/install.sh --yes --username me --password-stdin --tailscale
# The verified local installer also accepts the environment variable:
HESTIA_PASSWORD="$PASSWORD" sh /path/to/trusted-install.sh --yes --username me --tailscale
```

| Option | Purpose |
| --- | --- |
| `--yes` / `--non-interactive` | Ask nothing; values not given keep the last settings or the defaults |
| `--username NAME` | The login account |
| `--password-stdin` | Read the password from stdin; the environment variable `HESTIA_PASSWORD` also works. When a password already exists, leaving it out keeps it |
| `--port PORT` | The API port, default 4791 |
| `--cors-origins LIST` | Allowed frontend origins, comma-separated; **replaces** the defaults. `default` switches back to the four Hestia app WebView origins: `capacitor://localhost`, `https://localhost`, `tauri://localhost` and `http://tauri.localhost` (see "Connecting a frontend"). The web pairing link skips these four app origins |
| `--state-dir DIR` | The state folder, default `${MADERA_HOME:-${XDG_CONFIG_HOME:-~/.config}/madera}/hestia` (`~/.config/madera/` is where the Tessera family's tools all keep their data; see "Paths and names"); a relative path is made absolute before it is written |
| `--session-prefix P` | The prefix of the tmux session names this backend creates, default `hestia-`; letters, digits, `-` and `_` only |
| `--tailscale` | Let your devices reach the API over HTTPS through Tailscale; see "Reaching it through Tailscale" |
| `--tailscale-https-port PORT` | The HTTPS port on the tailnet, default 443; pick another (for example 8443) if a different service already uses it |
| `--service-name NAME` | The user service's name, default `hestia-api` (on macOS the LaunchAgent `me.maderaojen.hestia-api`); give each a different name when one machine runs two backends |
| `--command-name NAME` | The command's name in `~/.local/bin`, default `hestia`; lowercase letters, digits and `-` only. Give each a different name when one machine runs two backends; the commands this backend gives an LLM (reporting a delegation done, say) use it too. A re-run without it keeps the last name, and `--uninstall` removes only the link of this name |
| `--no-service` | Don't install the user service (systemd / launchd); only build and configure |
| `--no-linger` | Linux: don't enable linger (see below); by default the script asks, and with `--yes` it enables it. macOS has no linger, so this does nothing there (see "macOS") |
| `--bundled-node` | Use the downloaded Node.js even when the system's node is new enough |
| `--skip-build` | Skip `npm ci` / `npm run build` (the one-line install has already installed the dependencies and adds this itself) |
| `--deps-only` | Only pick Node.js and install the dependencies (building from source), writing no settings and installing no service; the one-line install uses it to prepare a new version in the staging folder |
| `--status` | Only show the current install's state (service, API, account, Tailscale address) and the pairing link, changing nothing |
| `--uninstall [--purge]` | Remove it; see below |

The script and the `hestia` command speak Traditional Chinese or English: `HESTIA_LOCALE` first, then `LC_ALL`, `LC_MESSAGES` and `LANG` (`C`/`POSIX` don't count); with none of them, Traditional Chinese. For example `HESTIA_LOCALE=en api/scripts/install.sh --status`.

The password never appears on a command line or in a file: only its scrypt hash is written (the same as `npm run set-credentials`). To change the password later, run the installer again (it restarts the service); or run `npm run set-credentials` in the program folder (for a one-line install, `cd ~/.local/share/hestia/app && npm run set-credentials`) and restart the service yourself. The sign-in account can't contain `#` (`.env` would read the rest as a comment).

## What is installed, and where

| Location | Contents |
| --- | --- |
| `api/node_modules`, `api/dist` | Dependencies and the build (one-line install: the bundle's own `dist/`, and `node_modules` holds only what it needs to run) |
| `api/.hestia-release` | Only in a bundle: its version. When the installer sees it, it only installs dependencies and doesn't build |
| `~/.config/madera/hestia/.env` (mode 600; `api/.env` is a link to it, and everything reads and writes through that link) | `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, `PORT`, `HOST` (always `127.0.0.1`; see "Security"), `CORS_ALLOWED_ORIGINS` (left blank without `--cors-origins`, meaning the backend's defaults), `HESTIA_STATE_DIR`, `HESTIA_SESSION_PREFIX`, `HESTIA_ENV_VERSION` (the version of the installer that wrote this `.env`, used on upgrade to decide whether old settings need migrating), `HESTIA_NODE_BIN` (the path of the node chosen this time, so the `hestia` command runs the same node as the service; older versions kept it in `api/.node-bin`, which running the installer again removes). The service loads it with `--env-file`, so if the settings go missing the service fails to start rather than running with no account |
| `~/.config/systemd/user/hestia-api.service` | The Linux user service: `Restart=on-failure`, `KillMode=process` (restarting the API doesn't end the conversations in tmux) |
| `~/Library/LaunchAgents/me.maderaojen.hestia-api.plist`, `~/Library/Logs/Hestia/hestia-api.log` | The macOS user service (a LaunchAgent) and its log: `RunAtLoad`, restarted on failure (`KeepAlive`), `AbandonProcessGroup` (stopping or restarting the API doesn't end the conversations in tmux) |
| `~/.local/share/hestia/node/` (`node/` under `HESTIA_HOME` when that is set) | Only when the system's node is too old or has no npm (or with `--bundled-node`): the downloaded Node.js, with `current` pointing at the version in use |
| `HESTIA_PUBLIC_URL` in `api/.env` | With `--tailscale`: this backend's address on the tailnet, which `hestia pair` uses to build the pairing link |
| `~/.local/bin/hestia` | A link to `api/bin/hestia`, which opens a tmux in your terminal that the phone sees too. If it already points at another install, the script asks first; with `--yes` it keeps the existing one |
| `~/.local/bin/tailscale`, `tailscaled`, `~/.config/systemd/user/tailscaled.service`, `~/.local/share/tailscale/` | Only on Linux, with `--tailscale`, when the machine has no usable Tailscale: the official binaries, a service running as your user, and its state (never on macOS, which uses the Tailscale app) |
| `~/.config/madera/hestia/` (mode 700; see "Paths and names" below) | State: the session list, projects, notes, uploaded images, the conversation backups (`dialogue/`) |

### Paths and names

Every host path and name the backend uses is decided in `api/src/config.ts`, and each can be overridden with an environment variable in `api/.env` (blank means unset):

| Variable | Default |
| --- | --- |
| `HESTIA_STATE_DIR` | `${MADERA_HOME:-${XDG_CONFIG_HOME:-~/.config}/madera}/hestia` |
| `HESTIA_SESSION_PREFIX` | `hestia-` |
| `HESTIA_TMUX_SOCKET` | the prefix without its trailing `-` (`hestia`): Hestia's own tmux server, reached with `tmux -L hestia attach` |
| `HESTIA_DIALOGUE_ROOT` | `<state folder>/dialogue` |
| `HESTIA_USER_BIN_DIR` | `~/.local/bin` (where `janus` and `claude` are looked for) |
| `HESTIA_WORKTREES_DIR` | unset: a delegation's or branch line's new worktree goes into `<repo name>-worktrees/` beside the repo, or, when the repo's parent can't be written, `${XDG_DATA_HOME:-~/.local/share}/madera/hestia/worktrees`. Set (an absolute path): all of them go there |

- The settings file `.env` lives in the state folder, and the program folder's `api/.env` is only a link, so replacing the whole program folder never loses settings. Older versions kept `.env` directly in `api/`; running the installer again moves it into the state folder and puts a link in its place. When `--state-dir` moves to another folder, the settings are copied there and the old copy is kept.
- The installer writes the state folder and tmux prefix it settled on into `.env`, so the service and the `hestia` command (whose environments may differ, for example in `MADERA_HOME` or `XDG_CONFIG_HOME`) always agree, and running it again never renames them.
- On start, the backend logs one line each (Linux: `journalctl --user -u hestia-api.service`; macOS: `~/Library/Logs/Hestia/hestia-api.log`) saying which state folder, prefix, tmux server and conversation backup location it uses, and whether each came from `.env`.
- Changing the prefix later only affects new sessions; sessions already in the registry keep matching their tmux whatever their prefix. When one machine runs two backends, give them different state folders and prefixes, so neither takes the other's sessions for its own; and different service names, ports and command names (`--service-name`, `--port`, `--command-name`), so each command talks to its own backend.
- Janus and Mnemosyne are **optional** tools from the same family (Tessera), not yet published; Hestia works fully without them. Janus lets one computer use several Claude Code / Codex accounts, and when it is installed Hestia lists its accounts among the launch options and in quota lookup; Mnemosyne exports the CLIs' conversation records.
- `MADERA_HOME` is the Tessera family's shared data root (default `~/.config/madera`), which Janus and Mnemosyne use too; Hestia lives in its `hestia/`. Only an absolute path counts. Set when installing, it is followed and pinned in `.env`; set after an install, it does not move the existing state folder (use `--state-dir` for that).
- To export the conversation backups to Mnemosyne, set `HESTIA_DIALOGUE_ROOT=~/.config/madera/mnemosyne/dialogue` (an absolute path).
- The AI CLIs' own folders: Codex follows `CODEX_HOME`, Gemini CLI follows `GEMINI_CLI_HOME` (the parent of `.gemini`); unset, they are `~/.codex` and `~/.gemini`. Claude Code's native account is always `~/.claude`, deliberately not following an inherited `CLAUDE_CONFIG_DIR` (see `docs/reference/account-status.en.md`).

If the service file (`~/.config/systemd/user/hestia-api.service`; on macOS `~/Library/LaunchAgents/me.maderaojen.hestia-api.plist`) exists but wasn't written by this script (for example, one you created by hand), the script stops rather than overwrite it; check its contents, move it away and run again, or add `--no-service`.

The service has the node path and `PATH` of the moment it was installed written into it (a user service can't see nvm or where the CLIs are installed). After switching Node versions or installing a CLI somewhere new, run the installer again.

A user service only runs while you are logged in by default, so once you log out (for example, by closing SSH) the phone can't reach it. The installer asks whether to enable linger (default yes), which keeps the backend and Tailscale running after logout and reboot; most systems let users enable it for themselves, and when administrator rights are needed the script prints the `sudo loginctl enable-linger $USER` to run.

Without systemd: add `--no-service`, then run `cd api && node --env-file=.env dist/src/main.js` in a tmux window. Note that `--env-file` doesn't override variables already in the environment: if the shell has exported `PORT`, `HOST` or `AUTH_*`, the shell's values win.

### macOS

On a Mac (Apple Silicon or Intel; the system's own bash is fine), the backend is installed as a launchd **LaunchAgent** (`~/Library/LaunchAgents/me.maderaojen.hestia-api.plist`), reloaded with `launchctl bootout` / `bootstrap gui/<uid>` on every run of the installer. Install tmux first (`brew install tmux`); Node.js works as on Linux: when it isn't recent enough, the script downloads the macOS build and verifies it with `shasum -a 256`.

- **Why a LaunchAgent**: it runs in your logged-in desktop session, so the tmux it starts and the CLIs in it can use the login keychain and Xcode's accounts (for example, to let Claude build an iOS app on this Mac). A LaunchDaemon, which starts at boot without a login, runs outside that session: `xcodebuild` finds no accounts and the keychain stays locked.
- **The price: someone logged in at the Mac.** There is no linger: it starts when you log in at the Mac, and closing a terminal or an ssh login doesn't stop it; after logging out of the desktop or a restart, it waits for the next login. For a Mac that stays on, turn on automatic login (System Settings → Users & Groups → Automatically log in as). With FileVault on, automatic login isn't available, so after a restart someone has to log in at the Mac (for a planned restart, `sudo fdesetup authrestart` unlocks it once). It can't be reached while asleep either: prevent automatic sleeping in System Settings → Energy. The installer checks these and says so.
- Over ssh into a Mac **nobody is logged in to at the screen**, there is no session to install the service in; the script says so and prints the command to run it in the foreground. Log in at the Mac and run it again.
- Stopping or restarting the backend doesn't end tmux: the LaunchAgent sets `AbandonProcessGroup`, which, like Linux's `KillMode=process`, stops only node.
- **Documents, Desktop, Downloads and similar folders**: the first time the backend touches one, the Mac shows "node would like to access…" on its screen, and that operation hangs until someone answers; the phone just sees no response. Right after installing, add the service's `node` (the `program` in `launchctl print gui/$(id -u)/me.maderaojen.hestia-api`) under System Settings → Privacy & Security → Full Disk Access.
- Other macOS caveats (a service without a locale, sleep, Xcode accounts and more) are in [Host platform caveats](../reference/host-platform-caveats.en.md).
- Handy commands: `launchctl print gui/$(id -u)/me.maderaojen.hestia-api` (status), `launchctl kickstart -k gui/$(id -u)/me.maderaojen.hestia-api` (restart), `tail -f ~/Library/Logs/Hestia/hestia-api.log` (log). The log isn't rotated; empty it when it gets big.

### Windows

Installing on Windows itself isn't supported (the backend needs tmux). Use WSL 2: run `wsl --install` in PowerShell, open its Ubuntu terminal, and install as on Linux. A user service needs systemd inside WSL (recent WSL Ubuntu has it on; otherwise add `[boot]` and `systemd=true` to `/etc/wsl.conf`, then `wsl --shutdown`); without it, run in the foreground with `--no-service`. The backend stops when Windows shuts down or on `wsl --shutdown`.

## Connecting a frontend

1. **Scan to sign in (recommended)**: when installed with `--tailscale`, the script ends by printing a **QR code**. Once the phone has the Tailscale app installed and signed in to the same account, tap "Scan QR code" under "Add host" in the Hestia app (or scan it with the phone's camera, which hands it straight to the app). It first shows this host's full address and asks "Add and sign in to this host?"; once you've checked it is your own host, tap "Add and sign in", with no account or password to type (tap "Cancel" for an address you don't recognize). The QR code holds a **one-time pairing code**: valid for 3 minutes, usable once, and placed after the `#` of the address (browsers never send that part to any server). To add another phone, or when the code has expired, run `hestia pair` on this host to get a new one.

   After printing the QR code, `hestia pair` stays on a countdown and, once the code is used, shows which device used it and when. If it wasn't you, type `r` as prompted to revoke that sign-in. Add `--no-wait` to skip waiting (the install script does this when it prints its QR code).

   When adding a host over SSH, the "Sign in to Hestia" step after connecting has the same "Scan QR code to sign in": scan the QR code from `hestia pair`. The app takes only the pairing code from it and signs in through the SSH connection, with no account or password.

   `hestia pair` can print two kinds of link, chosen with `--link` (without it, `HESTIA_PAIR_LINK` in `api/.env`, else `app`):

   | `--link` | Prints | In the QR code |
   | --- | --- | --- |
   | `app` (default) | The Hestia app's deep link `hestia://pair?url=<backend address>#code=<code>` | This link (the camera hands it straight to the app) |
   | `web` | The web frontend's link `https://<web frontend>/login?mode=add&url=<backend address>#pair=<code>` (for a web frontend of your own) | This link |
   | `both` | Both, with the same code; whichever is used first counts | The web link |

   The web link opens the first web origin in `CORS_ALLOWED_ORIGINS` (skipping the app's origins). The app's own scanner accepts both kinds (the format is in "Pairing links" in `docs/reference/api-contract-v1.en.md`). Either way, the app, like the web frontend, **shows the backend's address first and pairs only once the user confirms**.
2. **By hand**: open the Hestia app. The first time, it goes straight to "Add host"; once you have a host, choose "Add host" from the host menu on the sign-in page or from the sidebar's "主機" (Hosts) section, enter the backend's address (`hestia pair` or `--status` shows it, for example `machine.tailnet.ts.net`; `https://` may be left out, but everything up to `.ts.net` has to be there), then sign in with the account and password set during install.
3. The frontend first checks that the backend's API version is compatible, and if not, says which side needs updating.
4. Afterwards, switch hosts from the sidebar's "主機" (Hosts) section, where any host can also be renamed, signed out of or removed. The design is described in `docs/reference/multi-host-design.en.md`.

The backend only accepts the frontend origins listed in `CORS_ALLOWED_ORIGINS`. Left blank (the default), it allows the four fixed Hestia app WebView origins: `capacitor://localhost` on iOS, `https://localhost` on Android, `tauri://localhost` on macOS and `http://tauri.localhost` on Windows. The official web frontend is not included. If you host a web frontend of your own, list every allowed origin explicitly with `--cors-origins`. **The list replaces the defaults**, so include the relevant app origins too if those apps should connect (for example `--cors-origins "https://my-frontend.example,capacitor://localhost,https://localhost,tauri://localhost,http://tauri.localhost"`). `*` is ignored. App WebViews use bearer tokens and do not receive `Access-Control-Allow-Credentials`. The web pairing link skips all four fixed app origins and opens the first ordinary web origin in the list, falling back to the official web frontend if none is listed.

### Connecting over SSH (Hestia app)

The Hestia app (iOS, Android) can also reach the backend over SSH: the app opens an SSH forward on the phone to `127.0.0.1:4791` on this machine. The backend keeps listening on `127.0.0.1` only, with no need for `tailscale serve` or an HTTPS address. The web frontend has no such option.

You need:

- sshd running on this machine, reachable from the phone (for example its Tailscale `100.x` address or the local network). This path relies on your own sshd, so its security is the backend's security: sshd should **allow key authentication only** (`PasswordAuthentication no` and `KbdInteractiveAuthentication no` in `/etc/ssh/sshd_config`), all the more if it can be reached from the internet.
- sshd allowing TCP forwarding: `AllowTcpForwarding` in `/etc/ssh/sshd_config` isn't `no` (the default is `yes`), and there is no `DisableForwarding yes`. If it is blocked, the app says the host doesn't allow SSH forwarding.
- The backend as installed, listening on `127.0.0.1` only. If you changed its port, change the remote API port under "Advanced" when adding the host in the app.
- Limits of the iOS app: sshd needs an ed25519 or ECDSA host key, and a server with only an RSA host key can't be reached (a stock Linux or macOS sshd has an ed25519 one by default); when importing a passphrase-protected private key, only one encrypted with aes128/192/256-ctr (the `ssh-keygen` default) can be read, and any other is reported as unsupported.

Steps:

1. In the app, under "Settings › Account & security › SSH keys", tap "Generate key" (ed25519; the private key stays in the phone's secure storage and never leaves the phone), tap "Copy restricted version (recommended)", and add that line to `~/.ssh/authorized_keys` on this machine:

   ```
   restrict,port-forwarding,permitopen="127.0.0.1:4791" ssh-ed25519 AAAA… hestia-…
   ```

   The restricted version means the key can only forward to Hestia's API (`127.0.0.1:4791`): no shell, no commands, no forwarding to any other port. If the phone is lost, the key is good for nothing but reaching Hestia, which still asks for a username and password. You can also import a private key you already have (ed25519, or RSA of 2048 bits or more, in OpenSSH format; convert an old PEM key first with `ssh-keygen -p -f <key file>`). The app can also sign in with an SSH password, but that needs sshd to allow password authentication, which isn't recommended.
2. In the app's "Add host", choose "SSH", fill in the SSH host (a host name or IP), port, user name and key, and tap "Connect".
3. On the first connection the app shows this machine's host key fingerprint. Check it on this machine:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   (The app shows the file for the key's type, for example `ssh_host_ecdsa_key.pub`.) Tap "Trust and connect" only if they match. If the fingerprint ever changes, the app stops the connection without sending any credentials and asks you to check and confirm again.
4. Sign in to Hestia with the username and password set at install; or tap "Use a pairing code instead" and paste the link or code that `hestia pair` printed on this machine (the app takes only the code, whatever address the link names).

To the backend, requests over SSH come from this very machine, so **local-only accounts can sign in**. The app keeps the SSH connection only while it is in the foreground: it disconnects 30 seconds after going to the background and reconnects when you come back. Notifications don't need the connection.

## Reaching it through Tailscale (recommended)

By default the backend only listens on `127.0.0.1`; nobody on the network can reach it. Tailscale puts your own devices on one private network (a tailnet), so the phone can connect back without this machine opening any port to the outside. `--tailscale`:

1. **Finds Tailscale**: a system Tailscale that this user can drive is used as it is. macOS uses only the Tailscale app (the `tailscale` command, or the app's own `/Applications/Tailscale.app/Contents/MacOS/Tailscale`): when it isn't installed or doesn't answer, the script says to install, open and sign in to the app, and stops. On Linux, when there is none, it **installs a copy for you alone**: it downloads the official binaries from `pkgs.tailscale.com`, verifies their SHA-256, puts them in `~/.local/bin`, and runs them as the user service `tailscaled.service` in userspace networking mode (no TUN device, so no root is needed; `tailscale serve` still works).
2. **Signs in**: when this machine hasn't joined a tailnet yet, it prints a sign-in address and QR code (you can scan it with the phone to sign in) and waits for you (up to 15 minutes).
3. **Exposes the API**: `tailscale serve --bg --https=<port> http://127.0.0.1:<API port>`. The first time a tailnet uses serve, Tailscale asks you to allow it once; the script shows that address (and a QR code) and carries on once it is allowed.
4. Writes `https://<machine name>.<tailnet>.ts.net` into `HESTIA_PUBLIC_URL` in `api/.env`, then runs `hestia pair` to print the pairing QR code.

`tailscale serve` is reachable only from the devices on your tailnet and gets a Let's Encrypt certificate automatically. The backend's address has to be HTTPS: the frontend is an HTTPS page, and browsers won't let it call an http address; an IP address can't get a certificate browsers trust, hence the `ts.net` name Tailscale provides.

- If the system Tailscale refuses `tailscale serve` from a normal user, authorize it once: `sudo tailscale set --operator=$USER`.
- The script won't take over a port on the tailnet that already forwards to another service (an HTTPS proxy or a TCP forward); when Tailscale is already running, it stops before building or touching the service, and you can pick another with `--tailscale-https-port` (for example `--tailscale-https-port 8443`).
- Linux: Tailscale is a user service too, and like the backend relies on linger to keep running after logout and reboot (see above).
- macOS: the Tailscale app lets `tailscale serve` proxy to the backend without sudo; turn on HTTPS certificates for your tailnet first (the DNS page of the Tailscale admin console).

## Security

- This backend opens tmux, browses files and starts AI CLIs: **whoever has the account and password has your user's shell on this machine.** Use a long password you don't use anywhere else.
- **Don't expose the backend to the internet**: use it only through Tailscale or the Hestia app's SSH connection. Don't publish it by any other means (a reverse proxy, a tunnel service, a port forward on your router, a changed listen address): then the only thing protecting it is the username and password.
- The backend listens on this machine only: `HOST` may only be `127.0.0.1` (or `::1`, `localhost`), and the backend refuses to start on any other address. If an older install's `.env` has another address, running the installer again resets it to `127.0.0.1` and prints a warning; if you had set up a reverse proxy, tunnel service or port forward for it, turn that off too.
- **Don't use Tailscale Funnel** (`tailscale funnel`): Funnel publishes the service to the whole internet, exactly what the point above rules out. Use `serve`, for your own tailnet only.
- Only you can read the settings (`.env`) and the state folder; never commit `.env` to git (it is already in `.gitignore`).
- When connecting over SSH (the app), security rests on your own sshd: let it allow key authentication only (see "Connecting over SSH"), and use the restricted line the app offers in `authorized_keys` (`restrict,port-forwarding,permitopen="127.0.0.1:4791"`), so the key can only forward to Hestia's API.
- While the app is connected over SSH, it opens a local port on the phone's `127.0.0.1` (random, and open only while the app is in the foreground). Other apps on the phone can reach it too, and to the backend they count as "local" as well: they don't get a sign-in token and still need a username and password, but on this phone a local-only account is open to every app, and their wrong guesses may lock this machine's local sign-in for a while. If that worries you, don't use a local-only account over SSH from this phone.

## Running it again, upgrading and changing settings

```bash
# One-line install: run the same line again
HESTIA_RELEASE_PUBLIC_KEY=/path/to/trusted-release-public.pem sh /path/to/trusted-install.sh
# From source
cd tessera-hestia && git pull
api/scripts/install.sh
```

To change settings without changing versions, run `scripts/install.sh` in the program folder directly (for the one-line install, `~/.local/share/hestia/app/scripts/install.sh --skip-build`).

When already installed, the script first shows the current state (the same as `--status`) and asks one question: "Keep the current settings, and only update the program and restart?" Pressing Enter keeps every setting and the password, rebuilds and restarts the service, and keeps the same Tailscale address; conversations in tmux are not affected. Add `--yes` to skip the question.

Answer n to change things one by one. For the password there are three choices: Enter keeps it, `v` checks whether the password you remember is right (and offers to reset it if not), `r` resets it. The script doesn't ask for the old password first: anyone who can run it on this machine can edit `api/.env` directly anyway, so that check would stop nobody. The password protects against remote sign-in.

## Uninstalling

A one-line install:

```bash
~/.local/share/hestia/app/scripts/install.sh --uninstall           # stop and remove the service and the hestia command, keeping settings and state
~/.local/share/hestia/app/scripts/install.sh --uninstall --purge   # also delete the settings (.env) and the state folder
rm -rf ~/.local/share/hestia                                       # finally, delete the program and any Node.js it downloaded
```

A source install: run `api/scripts/install.sh --uninstall` (or with `--purge`) in the repo, then delete the repo yourself.

`--uninstall` won't delete itself while running, and ends by printing the command that deletes the program folder (after `--purge` it no longer holds a `.env`). The Node.js the installer downloads when the system's isn't recent enough lives in `~/.local/share/hestia/node/` (`node/` under `HESTIA_HOME` when that is set), and `--uninstall` leaves it alone: the last line above deletes it too; with a source install, `rm -rf ~/.local/share/hestia/node` yourself once it isn't needed.

`--purge` only deletes a state folder that is certainly Hestia's: installing puts a `.hestia-state` marker file in it, and deletion checks for that marker. Without the marker, or when the folder is `/`, your home folder, a folder containing your home folder, or a folder directly under your home folder (for example `~/work` or `~/.config`), it refuses, says why, and deletes nothing; delete it yourself if you need to.

When `--state-dir` points at a folder that already holds other files, the installer doesn't change its permissions (it only warns, suggesting a dedicated empty folder), and puts a `.hestia-shared` marker in it, so `--purge` won't delete it later either.

On macOS, `--uninstall` unloads and deletes the LaunchAgent; its log in `~/Library/Logs/Hestia/` stays.

Uninstalling turns off the `tailscale serve` that forwards to this backend; Tailscale itself stays (it may be serving other things). On Linux, to remove the Tailscale it installed too: `systemctl --user disable --now tailscaled.service`, delete `~/.local/bin/tailscale*`, `~/.config/systemd/user/tailscaled.service` and `~/.local/share/tailscale/`, and remove this machine in the Tailscale admin console. tmux sessions are not closed.

Product terms follow [Product terminology](../reference/terminology.en.md).
