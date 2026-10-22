# Host platform caveats

- Updated: 2026-10-22
- Related: [Install guide](../guides/install.en.md), [CLI version alignment](cli-version-alignment.en.md)
- Chinese version: [host-platform-caveats.md](host-platform-caveats.md)

This list records the exceptions the backend runs into on each operating system (Linux and macOS for now), and those of the platforms the app runs on (iOS's WebKit for now): what you see, why, whether the code can tell, and what to do. Add an entry when you hit a new one; when it is fixed, change its status instead of deleting it, so later changes don't walk back into it.

Each entry's ID is shared with the code's error codes, interface text keys and pre-install checks, so the docs and the code can find each other.

**Status** means:

- **Handled**: the code avoids or fixes it; nothing for you to do.
- **Hinted**: the code notices it and tells you what to do.
- **Recorded**: the code can't notice it yet; this page explains it, with what is planned.

## Summary

| ID | Platform | Status | In one line |
|---|---|---|---|
| [`macos.launchd.no-locale`](#macoslaunchdno-locale) | macOS | Handled | The service has no locale, tmux prints a tab as `_`, and a new conversation stays "starting" |
| [`macos.tcc.prompt-blocks`](#macostccprompt-blocks) | macOS | Recorded | Touching Documents and similar folders opens a prompt on the Mac; until someone answers, the operation hangs |
| [`macos.tcc.denied-stays`](#macostccdenied-stays) | macOS | Recorded | After "Don't Allow" macOS never asks again and access keeps failing |
| [`macos.tcc.new-node-asks-again`](#macostccnew-node-asks-again) | macOS | Recorded | A different Node.js binary has to be allowed again |
| [`macos.service.needs-login`](#macosserviceneeds-login) | macOS | Hinted | The backend runs only while someone is logged in; FileVault rules out automatic login |
| [`macos.power.sleep`](#macospowersleep) | macOS | Hinted | The backend is unreachable while the Mac sleeps |
| [`macos.xcode.no-accounts`](#macosxcodeno-accounts) | macOS | Recorded | Exporting an iOS app from a session fails with `xcodebuild` saying `No Accounts` |
| [`macos.tailscale.app-only`](#macostailscaleapp-only) | macOS | Handled | The Tailscale app can't serve a folder; a separately installed `tailscaled` runs as root |
| [`all.tailscale.port-taken`](#alltailscaleport-taken) | All | Handled | The tailnet HTTPS port is already used by another service |
| [`web.chromium.local-network-access`](#webchromiumlocal-network-access) | Web (Chromium browsers) | Recorded only | A new frontend address can't reach the backend: the browser has to allow "local network access" again |
| [`macos.ps.bsd`](#macospsbsd) | macOS | Handled | BSD `ps` options, columns and time format differ from Linux |
| [`macos.tmux.pane-command`](#macostmuxpane-command) | macOS | Handled | tmux names a pane's program by its executable file; Claude Code becomes a version number |
| [`macos.bash32.multibyte-var`](#macosbash32multibyte-var) | macOS | Handled | bash 3.2 takes a multibyte character right after a variable as part of its name |
| [`macos.no-sha256sum`](#macosno-sha256sum) | macOS | Handled | There is no `sha256sum` |
| [`ios.webkit.no-snapshot-gesture-off`](#ioswebkitno-snapshot-gesture-off) | iOS app | Handled | Swiping back from the left edge on Settings shows a white page instead of the page before |

## macOS

### `macos.launchd.no-locale`

- **Platform**: macOS 26.7, tmux 3.8; first seen 2026-10-20
- **What you see**: a new conversation from the app keeps showing "starting", although Claude Code is already waiting at its prompt in tmux.
- **Why**: a service started by launchd has no locale (no `LANG`). tmux then prints a tab in a `display-message` format as `_`, so the backend could not split "command + tab + pid", never recognised the CLI in the pane, and never confirmed the launch. It doesn't reproduce from a terminal, which has `LANG`.
- **How to detect**: run the same code with the service's environment (`env -i` plus the LaunchAgent's `PATH`).
- **What to do**: handled. The backend asks tmux for "pid, space, command" and splits at the first space; the installer also gives the LaunchAgent a UTF-8 `LANG` (the installing shell's, else `en_US.UTF-8`).
- **Status**: Handled

### `macos.tcc.prompt-blocks`

- **Platform**: macOS 26.7; first seen 2026-10-20
- **What you see**: adding a project or browsing folders does nothing on the phone and keeps spinning. On the Mac's screen, "node would like to access files in your Documents folder" is waiting.
- **Why**: macOS protects Desktop, Documents, Downloads, iCloud Drive and removable or network volumes. The first time the backend (or the tmux and CLIs it starts) touches one of them, macOS asks; until someone answers, that operation waits. Each kind of folder is asked about separately.
- **How to detect**: the code can't tell yet.
- **What to do**:
  - You: on the Mac, add the service's `node` (the first of the LaunchAgent's `ProgramArguments`, shown by `launchctl print gui/$(id -u)/me.maderaojen.hestia-api`) under System Settings → Privacy & Security → Full Disk Access. It won't ask again.
  - Planned: on macOS the backend times operations on protected folders and, after a few seconds, tells the app (and sends a push) to go to the Mac and allow it; right after installing, the service reads these folders once itself, so the prompts come up while you are there, and reports the result. Note that Node has only a few background threads for file work: a few of them stuck can stall the whole backend.
- **Status**: Recorded

### `macos.tcc.denied-stays`

- **Platform**: macOS; first seen 2026-10-20
- **What you see**: one folder can never be read (`Operation not permitted`) and no prompt appears any more.
- **Why**: "Don't Allow" was chosen when asked; macOS keeps that answer and doesn't ask again.
- **How to detect**: on macOS, `EPERM` under a protected folder.
- **What to do**: turn `node` on under System Settings → Privacy & Security → Files and Folders, or use Full Disk Access as above. Planned: the backend returns this as a distinct error code, and the app says where to change it.
- **Status**: Recorded

### `macos.tcc.new-node-asks-again`

- **Platform**: macOS; first seen 2026-10-20
- **What you see**: after an upgrade or reinstall the folder prompts come back.
- **Why**: privacy permissions belong to the executable. Upgrading Node.js, switching versions with `nvm` or reinstalling all mean a different `node`, which macOS treats as a new program.
- **How to detect**: the code can't tell.
- **What to do**: use the Node.js the installer provides (used automatically when no suitable system Node is found, or with `--bundled-node`); then only upgrading it on purpose needs allowing again.
- **Status**: Recorded

### `macos.service.needs-login`

- **Platform**: macOS; first seen 2026-10-20
- **What you see**: after the Mac restarts, the phone can't reach this host until someone logs in at the Mac.
- **Why**: the backend is a launchd LaunchAgent, which runs only while its user is logged in. A LaunchAgent rather than a LaunchDaemon (which runs from boot) because only inside the login session do the CLIs in its sessions reach the Keychain and the Xcode accounts. A Mac with FileVault on can't log in automatically.
- **How to detect**: the installer reads the automatic login and FileVault settings.
- **What to do**: the installer explains it. An always-on Mac should log in automatically; with FileVault on, use `sudo fdesetup authrestart` for planned restarts, which unlocks and logs in once after the restart.
- **Status**: Hinted

### `macos.power.sleep`

- **Platform**: macOS; first seen 2026-10-20
- **What you see**: after a while without use, the phone can't reach this host.
- **Why**: a Mac sleeps when idle by default.
- **How to detect**: the installer reads `sleep` from `pmset -g`.
- **What to do**: the installer reminds you; turn off automatic sleep under System Settings → Energy, or prevent sleep on power.
- **Status**: Hinted

### `macos.xcode.no-accounts`

- **Platform**: macOS 26.7, Xcode 27.1; first seen 2026-10-20
- **What you see**: building an iOS app in a session, the archive succeeds and exporting the IPA fails: `error: exportArchive No Accounts`.
- **Why**: `xcodebuild` can't read the account signed in to Xcode, so it can't create an Ad Hoc profile. Seen in two cases: Xcode's account state had gone bad (removing and re-adding it fixed it), and running outside the desktop session, e.g. over ssh (possibly unreadable there; not verified on its own).
- **How to detect**: the build's output.
- **What to do**: in Xcode → Settings → Accounts remove the Apple ID, add it again, quit Xcode and retry. The backend runs as a LaunchAgent, so its sessions live in the logged-in desktop session and avoid the ssh case. An App Store Connect API key with the App Manager role can't stand in for the account (no access to cloud-managed distribution certificates).
- **Status**: Recorded

### `macos.tailscale.app-only`

- **Platform**: macOS, Tailscale 1.104; first seen 2026-10-20
- **What you see**: with a separately installed `tailscaled` (Homebrew, running as root), `tailscale serve` needs root or an operator who can sudo, and the HTTPS certificate may never arrive; with the Tailscale app, serving a folder is refused (sandbox).
- **Why**: the two kinds of Tailscale on macOS have different permission models.
- **How to detect**: on macOS the installer only looks for the Tailscale app's CLI.
- **What to do**: handled. Hestia only uses `tailscale serve` to proxy to a local port (`http://127.0.0.1:…`), which the Tailscale app does without root; on macOS the installer installs no `tailscaled` of its own and, without the app, says to install it.
- **Status**: Handled

### `macos.ps.bsd`

- **Platform**: macOS 26.7; first seen 2026-10-20
- **What you see**: Codex and Agy conversations don't match up, or whether a CLI is still running is "unknown".
- **Why**: BSD `ps -e` means "show the environment", not "every process" (that is `-A`); `comm` is argv[0] (possibly a full path) and is cut to 16 characters unless it is the last column; `lstart` is translated with the locale. macOS has no `/proc` either.
- **How to detect**: tests against macOS's real `ps` output.
- **What to do**: handled. The macOS implementation uses `ps -A`, puts `comm` last and takes its base name, reads times with `LC_ALL=C`, and uses `lsof` instead of `/proc` for open files.
- **Status**: Handled

### `macos.tmux.pane-command`

- **Platform**: macOS 26.7, tmux 3.8; first seen 2026-10-20
- **What you see**: whether a CLI is still running is always "unknown".
- **Why**: tmux on macOS reports `#{pane_current_command}` as the executable file's name the kernel keeps, not argv[0]. Claude Code's executable is named after its version (e.g. `2.1.304`).
- **How to detect**: a test makes a pane with `exec -a claude /bin/sleep` and compares tmux's name for it.
- **What to do**: handled. On macOS the backend reads argv[0] of the pane's foreground process group leader, as tmux on Linux does.
- **Status**: Handled

### `macos.bash32.multibyte-var`

- **Platform**: macOS's `/bin/bash` (3.2); first seen 2026-10-20
- **What you see**: a message from the installer is missing a part, or under `set -u` it stops saying a variable is unbound.
- **Why**: bash 3.2 takes a multibyte character (e.g. a full-width parenthesis) right after `$VAR` as part of the variable's name.
- **How to detect**: run the script with macOS's `/bin/bash`.
- **What to do**: handled. A variable next to non-ASCII text is always written `${VAR}`.
- **Status**: Handled

### `macos.no-sha256sum`

- **Platform**: macOS; first seen 2026-10-20
- **What you see**: the installer fails to verify the Node.js it downloaded.
- **Why**: macOS has no `sha256sum`.
- **How to detect**: —
- **What to do**: handled. On macOS the built-in `shasum -a 256` is used.
- **Status**: Handled

## All platforms

### `all.tailscale.port-taken`

- **Platform**: all; first seen 2026-10-20
- **What you see**: after installing, another service you had (another site, say) is gone, or Hestia's address opens something else.
- **Why**: the tailnet HTTPS port (443 by default) already proxies to another service.
- **How to detect**: the installer reads `tailscale serve status` before building or replacing anything.
- **What to do**: handled. When the port is taken the installer stops before changing anything and asks you to pick another with `--tailscale-https-port` (e.g. 8443).
- **Status**: Handled

### `web.chromium.local-network-access`

- **Platform**: the web app in Chrome and other Chromium browsers (seen in Chrome 155 on macOS); first seen 2026-10-22
- **What you see**: after opening a new frontend address (moving a development frontend to another subdomain, say), adding the host or logging in keeps failing as if the backend were down, while the same backend works from the old address.
- **Why**: the backend is only on Tailscale (a `100.x` address), which Chromium treats as the local network. A public site may only reach local addresses once you allow "local network access", and that permission is kept **per site**: the old address was allowed, the new one has to be allowed again. Until then the request is blocked before it is sent; the console says `Permission was denied for this request to access the 'local' address space` and the page only gets `Failed to fetch`, which looks the same as a stopped backend or a CORS mismatch.
- **How to detect**: the page can't tell why, only that the request failed. From the host the backend is fine (`curl` to localhost and to the ts.net address answer 200, and the CORS preflight is right).
- **What to do**: allow local network access for that address and reload: click the icon left of the address bar → Site settings → Local network access → Allow (or Chrome Settings → Privacy and security → Site settings → Additional permissions → Local network access). The apps are not affected. A hint in the login page's connection error is planned.
- **Status**: Recorded only

## iOS app

### `ios.webkit.no-snapshot-gesture-off`

- **Platform**: the iOS app's `WKWebView` (WebKit behaviour; iOS Safari is not affected); first seen 2026-10-21
- **What you see**: in the app, after opening Settings from Home, swiping right from the left edge uncovers a plain white page instead of Home; Home only comes back once you let go. The page's own back button is fine.
- **Why**: the edge swipe slides a *snapshot* of the page before. WebKit takes it at the moment history moves on from that page, and only while `allowsBackForwardNavigationGestures` is on. The app used to turn the gesture off on Home (there is nothing to go back to from there), so leaving Home took no snapshot and swiping back to it could only draw white. Safari keeps the gesture on, so it has one.
- **How to detect**: the code can't tell (nothing signals whether a snapshot was taken); only on a device.
- **What to do**: handled, in the web code only (no native change). Home no longer turns the gesture off; it blocks it at its origin as iOS Safari does: a touch starting within 24 px of the left edge is `preventDefault()`ed on touchstart, except on a control such as a button (`web/src/shell/navigation/nativeBackGesture.ts`). Chat still turns it off where the web's own edge swipe runs (its back button reaches into the edge, and blocking a touch there would eat the tap), but turns it on for the moment Chat is left (the navigation's `beforeEach`) and back to what the next page wants once the navigation ends, so WebKit can take Chat's snapshot. To be confirmed on a device.
- **Status**: Handled
