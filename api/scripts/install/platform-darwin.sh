# shellcheck shell=bash
#
# macOS: the backend as a launchd LaunchAgent (~/Library/LaunchAgents), in
# the logged-in user's GUI session, and the Tailscale app's own CLI.
# Sourced by scripts/install.sh, which calls only the platform_* functions
# listed there.
#
# Why a LaunchAgent and not a LaunchDaemon: an agent runs inside the GUI
# login session, so everything started from it — the tmux server, and every
# CLI in it — reaches the login Keychain and the Xcode accounts (a session
# building an iOS app needs them; outside it, xcodebuild says "No
# Accounts"). The price: it runs only while the user is logged in, so an
# always-on Mac wants automatic login
#.
#
# bash 3.2 (macOS's /bin/bash): no associative arrays, no ${var,,}, and
# ${NAME} — braces — next to non-ASCII text.

PLATFORM_ID=darwin
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
# A launchd label is reverse-DNS by convention: this one plus --service-name.
LAUNCHD_LABEL_PREFIX="me.maderaojen."
SERVICE_LOG_DIR="$HOME/Library/Logs/Hestia"
# The Tailscale app's CLI, when it isn't linked onto PATH (the app's
# Settings → "Install CLI" puts a /usr/local/bin/tailscale wrapper there).
TS_MAC_APP_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

platform_service_configure() {
  local name="${1%.service}"
  name="${name%.plist}"
  name="${name#"$LAUNCHD_LABEL_PREFIX"}"
  [[ "$name" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "$(msg install.option.badServiceName name "$1")"
  SERVICE_NAME="$LAUNCHD_LABEL_PREFIX$name"
  SERVICE_FILE="$LAUNCH_AGENTS_DIR/$SERVICE_NAME.plist"
  SERVICE_LOG="$SERVICE_LOG_DIR/$name.log"
}

# The user's GUI session is where the agent lives: none over a plain ssh
# login to a Mac nobody is logged in to at the screen.
platform_service_available() {
  have launchctl && launchctl print "$LAUNCHD_DOMAIN" >/dev/null 2>&1
}

platform_service_unavailable_warn() {
  warn "$(msg install.darwin.noGui user "$USER" domain "$LAUNCHD_DOMAIN")"
}

platform_service_working_dir() {
  plutil -extract WorkingDirectory raw -o - "$SERVICE_FILE" 2>/dev/null || true
}

# The agent's life, as launchd sees it — one of:
#   missing    no plist
#   unloaded   a plist launchd doesn't have (not bootstrapped, or no GUI session)
#   running    loaded, with a process
#   stopped    loaded, no process, never failed (or exited 0)
#   failed     loaded, no process, last exit non-zero (KeepAlive retries it)
# install: any → write the plist; loaded → bootout; → bootstrap (RunAtLoad
# starts it). remove: loaded → bootout; then delete the plist.
launchd_job_state() {
  [ -f "$SERVICE_FILE" ] || { printf missing; return 0; }
  local info state last
  info="$(launchctl print "$LAUNCHD_DOMAIN/$SERVICE_NAME" 2>/dev/null)" || { printf unloaded; return 0; }
  state="$(printf '%s\n' "$info" | awk -F' = ' '/^\tstate = / { print $2; exit }')"
  last="$(printf '%s\n' "$info" | awk -F' = ' '/^\tlast exit code = / { print $2; exit }')"
  if [ "$state" = running ]; then
    printf running
  else
    case "$last" in
      ''|0|'(never exited)') printf stopped ;;
      *) printf failed ;;
    esac
  fi
}

launchd_loaded() {
  launchctl print "$LAUNCHD_DOMAIN/$SERVICE_NAME" >/dev/null 2>&1
}

# bootout returns before launchd has quite let go; bootstrapping again
# too soon fails with "Bootstrap failed: 5: Input/output error".
launchd_bootout() {
  launchctl bootout "$LAUNCHD_DOMAIN/$SERVICE_NAME" >>"$LOG_FILE" 2>&1 || return 1
  local i
  for i in $(seq 20); do launchd_loaded || return 0; sleep 0.5; done
  return 0
}

# xml_escape TEXT — TEXT safe inside a plist <string>.
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# A UTF-8 LANG for the agent: this shell's, when it is one.
service_lang() {
  case "${LC_ALL:-${LANG:-}}" in
    *.UTF-8|*.utf8|*.UTF8|*.utf-8) printf '%s' "${LC_ALL:-$LANG}" ;;
    *) printf en_US.UTF-8 ;;
  esac
}

write_plist() {
  mkdir -p "$LAUNCH_AGENTS_DIR" "$SERVICE_LOG_DIR"
  # An XML comment may not hold "--".
  local origin="$API_DIR/scripts/install.sh"
  origin="${origin//--/- -}"
  cat >"$SERVICE_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- $UNIT_MARKER ($(xml_escape "$origin")) — re-run it to change this file. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$SERVICE_NAME")</string>
  <!-- Absolute node path, and the PATH of the shell that installed it: an
       agent gets neither nvm's PATH nor the AI CLIs' install locations.
       env-file, not env-file-if-exists: without its settings the service
       must fail, not start with no account. -->
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>--env-file=.env</string>
    <string>dist/src/main.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$API_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$PATH")</string>
    <!-- launchd gives an agent no locale; tmux, asked by the API, then
         prints control characters as "_" and non-ASCII text may suffer.
         The installer's own UTF-8 locale, else en_US.UTF-8. -->
    <key>LANG</key>
    <string>$(xml_escape "$(service_lang)")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restarted when it fails, as systemd's Restart=on-failure. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- The API starts the tmux server itself. When the job stops, launchd
       would otherwise kill its whole process group; abandoning it leaves
       the tmux server and every session in it running (systemd's
       KillMode=process). -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$SERVICE_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$SERVICE_LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$SERVICE_FILE" >>"$LOG_FILE" 2>&1 || die "$(msg install.darwin.badPlist file "$SERVICE_FILE" log "$LOG_FILE")"
}

platform_service_install() {
  write_plist
  # A job turned off with `launchctl disable` refuses to bootstrap.
  launchctl enable "$LAUNCHD_DOMAIN/$SERVICE_NAME" >>"$LOG_FILE" 2>&1 || true
  case "$(launchd_job_state)" in
    # Loaded: bootout and bootstrap again, so a changed plist and the new
    # build are both picked up. AbandonProcessGroup means this never
    # touches running tmux sessions.
    running|stopped|failed) launchd_bootout || true ;;
  esac
  run_quiet "$(msg install.darwin.loading name "$SERVICE_NAME")" launchctl bootstrap "$LAUNCHD_DOMAIN" "$SERVICE_FILE"
}

platform_service_status() {
  local state
  if ! platform_service_available; then
    if [ -f "$SERVICE_FILE" ]; then msg install.darwin.statusNoGui name "$SERVICE_NAME"; else msg install.status.serviceMissing name "$SERVICE_NAME"; fi
    return 0
  fi
  state="$(launchd_job_state)"
  case "$state" in
    missing) msg install.status.serviceMissing name "$SERVICE_NAME" ;;
    unloaded) msg install.darwin.statusUnloaded name "$SERVICE_NAME" ;;
    *) msg install.status.serviceState name "$SERVICE_NAME" state "$state" ;;
  esac
}

platform_service_remove() {
  if [ -f "$SERVICE_FILE" ]; then
    if platform_service_available && launchd_loaded; then
      # Stopping only node: AbandonProcessGroup leaves the tmux server and
      # every session in it running.
      launchd_bootout || warn "$(msg install.uninstall.stopFailed)"
    fi
    rm -f "$SERVICE_FILE"
    say "$(msg install.uninstall.removed path "$SERVICE_FILE")"
    [ -f "$SERVICE_LOG" ] && note "$(msg install.darwin.logLeft log "$SERVICE_LOG")"
  else
    say "$(msg install.uninstall.noService path "$SERVICE_FILE")"
  fi
  return 0
}

platform_service_log_command() {
  printf 'tail -n 100 %s' "$(printf '%q' "$SERVICE_LOG")"
}

platform_service_follow_command() {
  printf 'tail -f %s' "$(printf '%q' "$SERVICE_LOG")"
}

# No linger here: a LaunchAgent runs while its user is logged in (at the
# screen, or by automatic login) and starts again at the next login. Said,
# not asked; --no-linger changes nothing.
platform_keep_running() {
  local auto sleep_minutes
  auto="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
  if [ -n "$auto" ] && [ "$auto" = "$USER" ]; then
    ok "$(msg install.darwin.autoLoginOn user "$USER")"
  elif [ "$(fdesetup isactive 2>/dev/null || true)" = true ]; then
    note "$(msg install.darwin.loginNeededFileVault)"
  else
    note "$(msg install.darwin.loginNeeded)"
  fi
  sleep_minutes="$(pmset -g 2>/dev/null | awk '$1 == "sleep" { print $2; exit }' || true)"
  if [ -n "$sleep_minutes" ] && [ "$sleep_minutes" != 0 ]; then
    note "$(msg install.darwin.sleeps minutes "$sleep_minutes")"
  fi
  return 0
}

platform_node_os() {
  printf darwin
}

# shasum (Perl) is part of macOS; sha256sum only of recent releases.
platform_sha256_available() {
  have shasum
}

platform_sha256_check() {
  shasum -a 256 -c --quiet -
}

# ---- tailscale -------------------------------------------------------------

# Only the Tailscale app: it runs tailscaled with the system's blessing, and
# `tailscale serve --https=PORT http://127.0.0.1:…` (proxying, all Hestia
# asks of it) works through its CLI without root. Nothing is downloaded or
# run as a second tailscaled here.
platform_tailscale_pick() {
  local cli
  for cli in "$(command -v tailscale 2>/dev/null || true)" "$TS_MAC_APP_CLI"; do
    [ -n "$cli" ] && [ -x "$cli" ] || continue
    if "$cli" status --json >/dev/null 2>&1; then
      TS_CMD=("$cli")
      return 0
    fi
  done
  return 1
}

platform_tailscale_provide() {
  if have tailscale || [ -x "$TS_MAC_APP_CLI" ]; then
    die "$(msg install.darwin.tailscaleSilent)"
  fi
  die "$(msg install.darwin.tailscaleMissing)"
}

platform_tailscale_serve_failed() {
  warn "$(msg install.darwin.serveFailed)"
}
