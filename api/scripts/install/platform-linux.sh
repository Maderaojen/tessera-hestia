# shellcheck shell=bash
# The node -e snippets are single-quoted on purpose: their ${...} is
# JavaScript, not shell.
# shellcheck disable=SC2016
#
# Linux (and Windows through WSL, which is Linux): the backend as a systemd
# --user service, kept running after logout by linger, and a Tailscale of
# this user's own when the system has none. Sourced by scripts/install.sh,
# which calls only the platform_* functions listed there.

PLATFORM_ID=linux
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

platform_service_configure() {
  SERVICE_NAME="${1%.service}.service"
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "$(msg install.option.badServiceName name "$SERVICE_NAME")"
  SERVICE_FILE="$UNIT_DIR/$SERVICE_NAME"
}

systemd_user_available() {
  have systemctl && systemctl --user show-environment >/dev/null 2>&1
}

platform_service_available() {
  systemd_user_available
}

platform_service_unavailable_warn() {
  warn "$(msg install.service.noSystemd)"
}

platform_service_working_dir() {
  sed -n 's/^WorkingDirectory=//p' "$SERVICE_FILE"
}

# systemd reads backslashes, double quotes and % specially inside a quoted
# value; escape them so an odd path or PATH entry survives as written.
sd_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//%/%%}"
  printf '"%s"' "$s"
}

write_unit() {
  mkdir -p "$UNIT_DIR"
  cat >"$SERVICE_FILE" <<EOF
$UNIT_MARKER ($API_DIR/scripts/install.sh) — re-run it to change this file.
[Unit]
Description=Hestia API backend
After=network.target

[Service]
Type=simple
WorkingDirectory=$API_DIR
# Absolute node path, and the PATH of the shell that installed it: a user
# service gets neither nvm's PATH nor the AI CLIs' install locations.
# --env-file, not --env-file-if-exists: without its settings (a link into
# a state folder that is gone) the service must fail, not start as a
# backend with no account and the default state folder.
ExecStart=$(sd_quote "$NODE_BIN") --env-file=.env dist/src/main.js
Environment=$(sd_quote "PATH=$PATH")
Restart=on-failure
RestartSec=3
# The API starts the tmux server itself, so the server lands in this unit's
# cgroup. With the default KillMode=control-group, every restart/stop/crash
# would SIGTERM the tmux server too and take down every managed session.
# Only stop the node process; tmux sessions outlive API restarts.
KillMode=process

[Install]
WantedBy=default.target
EOF
}

platform_service_install() {
  write_unit
  systemctl --user daemon-reload
  run_quiet "$(msg install.service.enable name "$SERVICE_NAME")" systemctl --user enable "$SERVICE_NAME"
  # restart, not start: a re-run is an upgrade and must load the new build.
  # KillMode=process means this never touches running tmux sessions.
  systemctl --user restart "$SERVICE_NAME"
}

platform_service_status() {
  if [ ! -f "$SERVICE_FILE" ]; then
    msg install.status.serviceMissing name "$SERVICE_NAME"
  elif systemd_user_available; then
    msg install.status.serviceState name "$SERVICE_NAME" state "$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
  else
    msg install.status.serviceUnknown name "$SERVICE_NAME"
  fi
}

platform_service_remove() {
  if [ -f "$SERVICE_FILE" ]; then
    if systemd_user_available; then
      # Stopping only the node process: KillMode=process leaves the tmux
      # server and every session in it running.
      systemctl --user disable --now "$SERVICE_NAME" || warn "$(msg install.uninstall.stopFailed)"
    fi
    rm -f "$SERVICE_FILE"
    systemd_user_available && systemctl --user daemon-reload
    say "$(msg install.uninstall.removed path "$SERVICE_FILE")"
  else
    say "$(msg install.uninstall.noService path "$SERVICE_FILE")"
  fi
}

platform_service_log_command() {
  printf 'journalctl --user -u %s -e' "$SERVICE_NAME"
}

platform_service_follow_command() {
  printf 'journalctl --user -u %s -f' "$SERVICE_NAME"
}

# A user service stops when its user's last login ends, unless systemd
# keeps a manager running for them (linger) — then it also starts at
# boot. Asked, yes by default: a phone can't reach a backend that stopped
# when the terminal closed. Most systems let a user turn it on for
# themselves; otherwise it takes sudo, which this never runs.
platform_keep_running() {
  if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)" = yes ]; then
    ok "$(msg install.linger.on)"
  elif [ "$LINGER" = 0 ]; then
    note "$(msg install.linger.skipped user "$USER")"
  elif confirm "$(msg install.linger.ask)" y; then
    if loginctl --no-ask-password enable-linger "$USER" >>"$LOG_FILE" 2>&1 \
      && [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)" = yes ]; then
      ok "$(msg install.linger.turnedOn)"
    else
      warn "$(msg install.linger.needsAdmin)"
      link "sudo loginctl enable-linger $USER"
    fi
  else
    note "$(msg install.linger.off user "$USER")"
  fi
}

platform_node_os() {
  printf linux
}

platform_sha256_available() {
  have sha256sum
}

platform_sha256_check() {
  sha256sum -c --quiet -
}

# ---- tailscale -------------------------------------------------------------

# A system-wide Tailscale is used when there is one; otherwise one is
# installed for this user alone: the official static binaries, run as a
# user service in userspace-networking mode (no TUN device, so no root).
# That mode is enough here: the API only needs to be reached, never to
# reach into the tailnet itself.
TS_USER_STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tailscale"
TS_UNIT_NAME="tailscaled.service"
TS_UNIT_FILE="$UNIT_DIR/$TS_UNIT_NAME"
TS_SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/tailscale/tailscaled.sock"

# Which tailscaled to talk to: the system one when it answers this user,
# else this user's rootless one. Fails when neither is running.
platform_tailscale_pick() {
  if have tailscale && tailscale status --json >/dev/null 2>&1; then
    TS_CMD=(tailscale); return 0
  fi
  if [ -S "$TS_SOCKET" ] && [ -x "$BIN_DIR/tailscale" ]; then
    TS_CMD=("$BIN_DIR/tailscale" "--socket=$TS_SOCKET"); return 0
  fi
  return 1
}

platform_tailscale_provide() {
  if have tailscale; then
    warn "$(msg install.tailscale.systemSilent)"
  else
    note "$(msg install.tailscale.installing)"
  fi
  install_user_tailscale
}

platform_tailscale_serve_failed() {
  if [ "${TS_CMD[0]}" = tailscale ]; then
    warn "$(msg install.tailscale.serveNeedsOperator user "$USER")"
  else
    warn "$(msg install.tailscale.serveFailed)"
  fi
}

install_user_tailscale() {
  systemd_user_available || die "$(msg install.tailscale.noSystemd)"
  have curl || die "$(msg install.tailscale.noCurl)"
  have sha256sum || die "$(msg install.tailscale.noSha256sum)"
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv6l) arch=arm ;;
    i386|i686) arch=386 ;;
    *) die "$(msg install.common.unsupportedCpu arch "$(uname -m)")" ;;
  esac
  if [ -f "$TS_UNIT_FILE" ] && ! grep -qF "$UNIT_MARKER" "$TS_UNIT_FILE"; then
    die "$(msg install.tailscale.unitNotOurs unit "$TS_UNIT_FILE" name "$TS_UNIT_NAME")"
  fi

  local tarball tmp
  tarball="$(curl -fsSL 'https://pkgs.tailscale.com/stable/?mode=json' | ts_json "(d) => d.Tarballs && d.Tarballs[\"$arch\"]")" \
    || die "$(msg install.tailscale.noDownloadInfo)"
  [ -n "$tarball" ] || die "$(msg install.tailscale.noBinary arch "$arch")"
  tmp="$(mktemp -d)"
  note "$(msg install.tailscale.downloading file "$tarball")"
  curl -fsSL "https://pkgs.tailscale.com/stable/$tarball" -o "$tmp/$tarball" \
    && curl -fsSL "https://pkgs.tailscale.com/stable/$tarball.sha256" -o "$tmp/sha256" \
    || { rm -rf "$tmp"; die "$(msg install.tailscale.downloadFailed)"; }
  (cd "$tmp" && printf '%s  %s\n' "$(tr -d '[:space:]' <sha256)" "$tarball" | sha256sum -c --quiet -) \
    || { rm -rf "$tmp"; die "$(msg install.tailscale.badChecksum)"; }
  tar -xzf "$tmp/$tarball" -C "$tmp"
  mkdir -p "$BIN_DIR" "$TS_USER_STATE_DIR"
  install -m 755 "$tmp/${tarball%.tgz}/tailscale" "$tmp/${tarball%.tgz}/tailscaled" "$BIN_DIR/"
  rm -rf "$tmp"
  ok "$(msg install.tailscale.installed version "$("$BIN_DIR/tailscale" version | head -n 1)" dir "$BIN_DIR")"

  mkdir -p "$UNIT_DIR"
  cat >"$TS_UNIT_FILE" <<EOF
$UNIT_MARKER ($API_DIR/scripts/install.sh) — re-run it to change this file.
[Unit]
Description=Tailscale for Hestia (this user only, userspace networking)
After=network-online.target

[Service]
Type=simple
# Userspace networking: no TUN device, so no root. Enough for tailscale
# serve, which is all Hestia needs.
ExecStart=$(sd_quote "$BIN_DIR/tailscaled") --tun=userspace-networking --statedir=$(sd_quote "$TS_USER_STATE_DIR") --socket=%t/tailscale/tailscaled.sock
RuntimeDirectory=tailscale
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  run_quiet "$(msg install.tailscale.starting name "$TS_UNIT_NAME")" systemctl --user enable --now "$TS_UNIT_NAME"
  local i
  for i in $(seq 20); do [ -S "$TS_SOCKET" ] && break; sleep 0.5; done
  platform_tailscale_pick || die "$(msg install.tailscale.notStarted name "$TS_UNIT_NAME")"
}
