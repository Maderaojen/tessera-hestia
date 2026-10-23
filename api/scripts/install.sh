#!/usr/bin/env bash
# The node -e snippets are single-quoted on purpose: their ${...} is
# JavaScript, not shell.
# shellcheck disable=SC2016
# Installs (or upgrades) the Hestia backend for the current user, no
# root needed: builds api/, writes api/.env, installs a user service (a
# systemd --user unit on Linux, a launchd LaunchAgent on macOS; see
# scripts/install/platform-*.sh) and links the hestia command into
# ~/.local/bin. Safe to re-run —
# every step overwrites its own output and keeps what it didn't ask about
# (existing credentials, settings from the last run). See docs/guides/install.md.
#
#   api/scripts/install.sh [options]
#   api/scripts/install.sh --uninstall [--purge]
#
# Runs the same from a source checkout (api/ of the repo) and from a
# release bundle (unpacked by the one-line installer, install.sh at the
# repo root, into ~/.local/share/hestia/app): either way API_DIR is the
# folder above this script, and everything it writes (the .env link, the
# unit's WorkingDirectory) is relative to it. The bundle is already built
# and says so with RELEASE_MARKER; then only runtime dependencies are
# installed.
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# What this prints is in scripts/i18n/locales, in the hestia command's
# language (HESTIA_LOCALE, LC_ALL, LC_MESSAGES, LANG): msg KEY [NAME VALUE]...
HESTIA_I18N_DIR="$API_DIR/scripts/i18n"
# shellcheck source=i18n/msg.sh
. "$HESTIA_I18N_DIR/msg.sh"
ENV_FILE="$API_DIR/.env"
# In a release bundle only (written when the bundle is packed): its version.
RELEASE_MARKER="$API_DIR/.hestia-release"
IS_RELEASE=0
[ -f "$RELEASE_MARKER" ] && IS_RELEASE=1
DEFAULT_UNIT_NAME="hestia-api"
# At the top of every service file this script writes; see check_existing_unit.
UNIT_MARKER="# Written by Hestia scripts/install.sh"
BIN_DIR="$HOME/.local/bin"
# The command's name in BIN_DIR (--command-name, HESTIA_COMMAND_NAME in
# .env): hestia, unless a second backend on this machine needs its own.
# LINK is set once .env can be read; see command_name.
DEFAULT_COMMAND_NAME="hestia"
# Which frontends may call the API (CORS_ALLOWED_ORIGINS, read by
# server.ts): left blank in .env unless --cors-origins names others, so the
# API's own defaults apply (config.ts: the Hestia app WebViews alone) and an
# upgrade that adds one reaches this install too. This script names no
# frontend itself; see cors_defaults.
# Written to .env on every install: which installer wrote it, so a later
# one knows which of its settings may still need migrating (see the CORS
# step).
ENV_VERSION=2
DEFAULT_PORT=4791
DEFAULT_HOST=127.0.0.1

usage() {
  msg install.usage.text
  printf '\n'
}

# Colors and marks only on a terminal, never with NO_COLOR (no-color.org).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\e[0m' C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_CYAN=$'\e[36m'
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_CYAN=""
fi
say() { printf '  %s\n' "$*"; }
note() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok() { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
step() { printf '\n%s▶ %s%s\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
warn() { printf '  %s! %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die() { printf '\n%s✗ %s%s\n' "$C_BOLD$C_RED" "$*" "$C_RESET" >&2; exit 1; }
# link TEXT — something to open or copy: stands out.
link() { printf '    %s%s%s\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Long, noisy output (npm, systemctl) goes here instead of the screen; a
# failure shows its tail and where the whole of it is.
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/hestia-install.XXXXXX")"
# run_quiet DESC CMD... — one line while it runs, ✓ or the failure after.
run_quiet() {
  local desc="$1"; shift
  if [ -t 1 ]; then printf '  %s%s…%s' "$C_DIM" "$desc" "$C_RESET"; fi
  if "$@" >>"$LOG_FILE" 2>&1; then
    [ -t 1 ] && printf '\r\033[K'
    ok "$desc"
  else
    [ -t 1 ] && printf '\r\033[K'
    printf '  %s✗ %s%s\n' "$C_RED" "$desc" "$C_RESET" >&2
    tail -n 25 "$LOG_FILE" | sed 's/^/      /' >&2
    die "$(msg install.run.failed what "$desc" log "$LOG_FILE")"
  fi
}

# qr TEXT — TEXT as a QR code a phone camera can read, on a terminal only
# (uqr, from the API's own dependencies: available once npm ci has run).
# White on black set explicitly, so a light terminal theme doesn't invert it.
qr() {
  [ -t 1 ] || return 0
  (cd "$API_DIR" && node -e '
    import("uqr").then(({ renderUnicodeCompact }) => {
      for (const line of renderUnicodeCompact(process.argv[1], { border: 2 }).split("\n"))
        console.log(`    \x1b[97;40m${line}\x1b[0m`);
    });' "$1") 2>/dev/null || true
}

# ---- options ---------------------------------------------------------------

INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0
OPT_USERNAME="" OPT_PORT="" OPT_CORS="" OPT_STATE_DIR="" OPT_SESSION_PREFIX="" OPT_SERVICE_NAME="" OPT_COMMAND_NAME=""
TS_HTTPS_PORT=443
PASSWORD_STDIN=0 TAILSCALE=0 SERVICE=1 BUILD=1 DEPS_ONLY=0 UNINSTALL=0 PURGE=0 BUNDLED_NODE=0 UPDATE_NODE=0 STATUS=0 LINGER=1

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$(msg install.option.needsValue option "$1")"; }
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes|--non-interactive) INTERACTIVE=0 ;;
    --username) need_arg "$@"; OPT_USERNAME="$2"; shift ;;
    --password-stdin) PASSWORD_STDIN=1 ;;
    --port) need_arg "$@"; OPT_PORT="$2"; shift ;;
    # Removed: the API listens on loopback only (see the HOST step below).
    --host) die "$(msg install.option.hostRemoved)" ;;
    --cors-origins) need_arg "$@"; OPT_CORS="$2"; shift ;;
    --state-dir) need_arg "$@"; OPT_STATE_DIR="$2"; shift ;;
    --session-prefix) need_arg "$@"; OPT_SESSION_PREFIX="$2"; shift ;;
    --tailscale) TAILSCALE=1 ;;
    --tailscale-https-port) need_arg "$@"; TS_HTTPS_PORT="$2"; shift ;;
    --service-name) need_arg "$@"; OPT_SERVICE_NAME="$2"; shift ;;
    --command-name) need_arg "$@"; OPT_COMMAND_NAME="$2"; shift ;;
    --no-service) SERVICE=0 ;;
    --no-linger) LINGER=0 ;;
    --bundled-node) BUNDLED_NODE=1 ;;
    --update-node) UPDATE_NODE=1 ;;
    --skip-build) BUILD=0 ;;
    --deps-only) DEPS_ONLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --status) STATUS=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "$(msg install.option.unknown option "$1")" ;;
  esac
  shift
done
# The password would otherwise be read from the same stdin as the answers.
[ "$PASSWORD_STDIN" = 1 ] && INTERACTIVE=0

# This user's own Node.js, when the machine's is missing or too old (see
# download_node): beside the program in HESTIA_HOME, which the one-line
# installer passes on.
NODE_HOME="${HESTIA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hestia}/node"

# ---- platform --------------------------------------------------------------

# What differs between operating systems (the user service, keeping it
# running, Node.js downloads, Tailscale) is in one sourced module per
# platform (scripts/install/platform-*.sh), picked once, here;
# HESTIA_INSTALL_PLATFORM names one instead (tests). Every module defines
# the same functions, and the rest of this script calls only these
# (test/install-script.test.ts holds both to this list):
#
#   platform_service_configure NAME   SERVICE_NAME, SERVICE_FILE from --service-name
#   platform_service_available        whether a service can be installed now
#   platform_service_unavailable_warn why not (a warning)
#   platform_service_working_dir      the code folder the installed service runs
#   platform_service_install          write the service and (re)start it
#   platform_service_status           one line: is it installed, is it running
#   platform_service_remove           stop and remove it (--uninstall)
#   platform_service_log_command      a command showing its recent log
#   platform_service_follow_command   a command following its log
#   platform_keep_running             keep it up after logout / at boot (linger)
#   platform_node_os                  the OS part of nodejs.org's file names
#   platform_sha256_available         whether a SHA-256 checker is there
#   platform_sha256_check             check "HASH  FILE" lines on stdin, quietly
#   platform_tailscale_pick           set TS_CMD to a tailscale that answers
#   platform_tailscale_provide        make one answer, or die saying how
#   platform_tailscale_serve_failed   what to do when `tailscale serve` failed
#
# A module may use everything this script defines before sourcing it (msg,
# say, note, ok, warn, die, link, confirm, run_quiet, have, ts_json, the
# options and paths).
choose_platform() {
  case "${HESTIA_INSTALL_PLATFORM:-$(uname -s)}" in
    Linux|linux) printf linux ;;
    Darwin|darwin) printf darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) die "$(msg install.platform.windows)" ;;
    *) die "$(msg install.platform.unsupported system "$(uname -s)")" ;;
  esac
}
HESTIA_PLATFORM="$(choose_platform)" || exit 1
# shellcheck source=install/platform-linux.sh
. "$API_DIR/scripts/install/platform-$HESTIA_PLATFORM.sh"
platform_service_configure "${OPT_SERVICE_NAME:-$DEFAULT_UNIT_NAME}"
[[ "$TS_HTTPS_PORT" =~ ^[0-9]+$ ]] && [ "$TS_HTTPS_PORT" -ge 1 ] && [ "$TS_HTTPS_PORT" -le 65535 ] || die "$(msg install.option.badTailscalePort port "$TS_HTTPS_PORT")"

# ask QUESTION DEFAULT — the answer, or DEFAULT when not asking.
ask() {
  local answer
  if [ "$INTERACTIVE" = 0 ]; then printf '%s' "$2"; return; fi
  if [ -n "$2" ]; then read -r -p "  $1 [$2]: " answer; else read -r -p "  $1: " answer; fi
  printf '%s' "${answer:-$2}"
}

# confirm QUESTION DEFAULT(y|n) — succeeds on yes; not asking means DEFAULT.
confirm() {
  local answer hint="[y/N]"
  [ "$2" = y ] && hint="[Y/n]"
  if [ "$INTERACTIVE" = 0 ]; then [ "$2" = y ]; return; fi
  read -r -p "  ${C_BOLD}$1${C_RESET} $hint " answer
  answer="${answer:-$2}"
  [[ "$answer" == [yY]* ]]
}

# env_get KEY — the value in .env, empty when absent, read exactly as the
# service will read it: node's own parser (util.parseEnv is the one behind
# --env-file), so quotes, `export` and comments mean the same here as there.
# Before any node is around (--status, --uninstall on a machine without one),
# a plain last-KEY=-wins read, which is right for everything this script
# writes itself.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local node="${NODE_BIN:-}" value
  [ -n "$node" ] || node="$(command -v node 2>/dev/null || true)"
  if [ -n "$node" ] && value="$("$node" -e '
    const { parseEnv } = require("node:util");
    if (typeof parseEnv !== "function") process.exit(3);
    const [file, key] = process.argv.slice(1);
    const value = parseEnv(require("node:fs").readFileSync(file, "utf8"))[key];
    if (value !== undefined) process.stdout.write(value);
  ' "$ENV_FILE" "$1" 2>/dev/null)"; then
    printf '%s' "$value"
    return 0
  fi
  value="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)"
  printf '%s' "$value"
}

# command_name — what the command in BIN_DIR is called: --command-name,
# else what the last install wrote to .env, else hestia. The hestia
# command's own name in prompts (config.ts COMMAND_NAME) comes from the
# same .env value, so an LLM in one backend's pane runs that backend's
# command.
command_name() {
  local name="${OPT_COMMAND_NAME:-$(env_get HESTIA_COMMAND_NAME)}"
  name="${name:-$DEFAULT_COMMAND_NAME}"
  [[ "$name" =~ ^[a-z0-9-]+$ ]] || die "$(msg install.option.badCommandName name "$name")"
  printf '%s' "$name"
}
COMMAND_NAME="$(command_name)"
LINK="$BIN_DIR/$COMMAND_NAME"

# The state dir the API picks when nothing names one (config.ts
# resolveHostPaths, maderaHome): MADERA_HOME/hestia, else the XDG one.
# Only for --uninstall without a build; installing asks the API itself.
default_state_dir() {
  local root="${MADERA_HOME:-}"
  case "$root" in
    /*) ;;
    *)
      root="${XDG_CONFIG_HOME:-}"
      case "$root" in /*) ;; *) root="$HOME/.config" ;; esac
      root="$root/madera" ;;
  esac
  printf '%s' "$root/hestia"
}

# Left in the state dir by the install, so --purge can tell a folder this
# backend owns from whatever HESTIA_STATE_DIR happens to name.
STATE_MARKER=".hestia-state"
# Left instead when the state dir is a folder that already held other
# things at install time (see the install step), which --purge must keep.
SHARED_STATE_MARKER=".hestia-shared"

# state_dir_is_ours DIR — whether DIR is this backend's state dir: it has
# the marker and isn't marked shared.
state_dir_is_ours() {
  [ ! -e "$1/$SHARED_STATE_MARKER" ] || return 1
  [ -f "$1/$STATE_MARKER" ]
}

# canonical_dir DIR — resolve existing path components using portable shell
# primitives. BSD readlink (macOS) has no -f option and can report success
# with an empty result, so don't use `readlink -f || ...` here.
canonical_dir() {
  local dir="$1" parent leaf
  case "$dir" in /*) ;; *) printf '%s' "$dir"; return ;; esac
  if [ -d "$dir" ]; then
    (cd -P "$dir" 2>/dev/null && pwd -P) && return
  fi
  parent="${dir%/*}"
  leaf="${dir##*/}"
  [ -n "$parent" ] || parent=/
  if [ -d "$parent" ]; then
    parent="$(cd -P "$parent" 2>/dev/null && pwd -P)" || parent="${dir%/*}"
    printf '%s/%s' "${parent%/}" "$leaf"
  else
    printf '%s' "$dir"
  fi
}

# prepare_state_dir DIR — creates DIR, and locks it down (700) and marks it
# as ours only when it is ours: made just now, already holding this
# backend's state, or empty. --state-dir may name a folder with other
# things in it, whose permissions aren't ours to change.
prepare_state_dir() {
  if [ ! -e "$1" ] || state_dir_is_ours "$1" || { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }; then
    mkdir -p "$1"
    chmod 700 "$1"
    [ -f "$1/$STATE_MARKER" ] \
      || printf 'hestia state directory; --uninstall --purge deletes this whole folder.\n' >"$1/$STATE_MARKER"
    return 0
  fi
  [ -d "$1" ] || die "$(msg install.state.notFolder path "$1")"
  warn "$(msg install.state.shared path "$1")"
  warn "$(msg install.state.sharedAdvice)"
  # This tells --purge it's shared and must not be deleted whole, even
  # once the API's own state sits in it.
  [ -f "$1/$SHARED_STATE_MARKER" ] \
    || printf 'hestia keeps its state here, in a folder it does not own; --uninstall --purge leaves it alone.\n' >"$1/$SHARED_STATE_MARKER"
}

# place_env_file DIR — keeps the settings in DIR/.env, beside the rest of
# this install's data, so the program folder can be replaced whole; api/.env
# is a link to it, which is what the service, the hestia command and the
# npm scripts read. An api/.env that is still a file (an older install) is
# moved there; a link to another state folder takes its settings along.
place_env_file() {
  local target="$1/.env"
  if [ -L "$ENV_FILE" ]; then
    if [ "$(readlink -f "$ENV_FILE")" = "$(readlink -f "$target")" ]; then
      chmod 600 "$target"
      return 0
    fi
    if [ -f "$ENV_FILE" ] && [ ! -e "$target" ]; then cp "$ENV_FILE" "$target"; fi
    rm -f "$ENV_FILE"
  elif [ -f "$ENV_FILE" ]; then
    [ ! -e "$target" ] || die "$(msg install.env.both env "$ENV_FILE" target "$target")"
    mv "$ENV_FILE" "$target"
  elif [ -e "$ENV_FILE" ]; then
    die "$(msg install.env.notFile env "$ENV_FILE")"
  fi
  [ -e "$target" ] || : >"$target"
  chmod 600 "$target"
  ln -s "$target" "$ENV_FILE"
}

# purge_allowed DIR — succeeds when --purge may rm -rf DIR; otherwise
# prints why not and fails. A mistyped or hand-edited
# HESTIA_STATE_DIR must never turn --purge into deleting someone's
# home, a folder that holds it, or a top-level one like ~/work or ~/.config
# — nor any folder that doesn't look like ours.
purge_allowed() {
  local real home
  [ -n "$1" ] || { msg install.purge.noFolder; return 1; }
  real="$(canonical_dir "$1")"
  home="$(canonical_dir "$HOME")"
  while [ "${real%/}" != "$real" ]; do real="${real%/}"; done
  while [ "${home%/}" != "$home" ]; do home="${home%/}"; done
  if [ -z "$real" ]; then msg install.purge.root path "$1"; return 1; fi
  case "$real" in /*) ;; *) msg install.purge.relative path "$1"; return 1 ;; esac
  if [ "$real" = "$home" ]; then msg install.purge.home path "$1"; return 1; fi
  case "$home/" in "$real"/*) msg install.purge.holdsHome path "$1"; return 1 ;; esac
  if [ "${real%/*}" = "$home" ]; then msg install.purge.topLevel path "$1"; return 1; fi
  # Nothing there: nothing to delete, nothing to get wrong.
  [ -e "$real" ] || return 0
  if [ -e "$real/$SHARED_STATE_MARKER" ]; then
    msg install.purge.shared path "$1"
    return 1
  fi
  if ! state_dir_is_ours "$real"; then
    msg install.purge.notOurs path "$1" marker "$STATE_MARKER"
    return 1
  fi
}

# resolved_paths STATE_DIR PREFIX — the state dir and tmux session prefix the
# built API resolves (config.ts) from .env plus the given values (either may
# be empty), one per line. Asking config.ts keeps the defaults in one
# place. Our own variables from this shell are dropped: the service never
# sees them, only .env.
resolved_paths() {
  local env_flag=()
  [ -f "$ENV_FILE" ] && env_flag=(--env-file="$ENV_FILE")
  (cd "$API_DIR" && env -u HESTIA_STATE_DIR -u HESTIA_SESSION_PREFIX -u HESTIA_DIALOGUE_ROOT \
    ${1:+HESTIA_STATE_DIR="$1"} ${2:+HESTIA_SESSION_PREFIX="$2"} \
    node ${env_flag[@]+"${env_flag[@]}"} -e 'import("./dist/src/config.js").then((c) => console.log(`${c.STATE_DIR}\n${c.SESSION_PREFIX}`))')
}

# install_config ARGS — a value the API owns (its default frontends), from
# the built scripts/install-config.ts, so it is named in one place. Needs
# dist/, like resolved_paths.
install_config() {
  env -u HESTIA_SESSION_PREFIX node "$API_DIR/dist/scripts/install-config.js" "$@"
}

# cors_defaults — what a blank CORS_ALLOWED_ORIGINS allows, comma-separated.
cors_defaults() {
  install_config cors-defaults
}

# choose_cors — the CORS_ALLOWED_ORIGINS to write, blank for the API's
# defaults: --cors-origins (`default` for blank), else what .env has.
# Notes and warnings go to stderr.
choose_cors() {
  local cors missing
  if [ -n "$OPT_CORS" ]; then
    cors="$OPT_CORS"
    [ "$cors" = default ] && cors=""
  else
    cors="$(env_get CORS_ALLOWED_ORIGINS)"
    # Installers before ENV_VERSION 2 wrote their default, the official web
    # frontend alone, into .env; kept, it would shut the native app out for
    # good. Only that exact value, in a .env such an installer wrote, goes
    # back to the defaults: a list someone wrote themselves is theirs
    # (checked below), and so is the same value written by this installer.
    if [ -n "$cors" ] && [ "$(env_get HESTIA_ENV_VERSION)" != "$ENV_VERSION" ] \
      && [ "$cors" = "$(install_config web-frontend)" ]; then
      cors=""
      note "$(msg install.cors.reset defaults "$(cors_defaults)")" >&2
    fi
  fi
  if [ -n "$cors" ]; then
    missing="$(install_config missing-app-webviews "$cors")"
    if [ -n "$missing" ]; then
      warn "$(msg install.cors.missingApp cors "$cors" missing "$missing")"
      note "$(msg install.cors.howToAllow list "$cors,$missing")" >&2
    fi
  fi
  printf '%s' "$cors"
}

# The address this machine's own clients (health check, tailscale serve,
# the hestia command) connect to: HOST, with a wildcard bind reached
# over loopback — as config.ts connectHostFor does. Only loopback HOSTs are
# written now, but an older install's .env may still hold another one, and
# --status, --uninstall and a kept-settings upgrade look up the serve that
# install set up by this address.
local_api_url() {
  case "$1" in
    0.0.0.0) printf 'http://127.0.0.1:%s' "$2" ;;
    ::|"[::]") printf 'http://[::1]:%s' "$2" ;;
    *:*) local h="${1#[}"; printf 'http://[%s]:%s' "${h%]}" "$2" ;;
    *) printf 'http://%s:%s' "$1" "$2" ;;
  esac
}

# is_loopback_host HOST — whether HOST is one the API agrees to listen on
# (config.ts isLoopbackHost): this machine only, never the network.
is_loopback_host() {
  case "$1" in
    127.0.0.1|::1|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

# A unit this script didn't write (one set up by hand, say, with extra
# Environment= lines) is someone's configuration: never replace it
# silently. Checked before anything is built or written, so refusing
# leaves nothing half done.
check_existing_unit() {
  [ -f "$SERVICE_FILE" ] || return 0
  grep -qF "$UNIT_MARKER" "$SERVICE_FILE" ||
    die "$(msg install.service.notOurs unit "$SERVICE_FILE")"
  local previous
  previous="$(platform_service_working_dir)"
  if [ -n "$previous" ] && [ "$previous" != "$API_DIR" ]; then
    warn "$(msg install.service.otherCode previous "$previous" current "$API_DIR")"
    confirm "$(msg install.service.switchCode)" y || die "$(msg install.common.cancelled)"
  fi
}

# ---- tailscale helpers -----------------------------------------------------

# Tailscale puts this machine on the user's own private network (tailnet)
# and `tailscale serve` gives the API an https://<machine>.<tailnet>.ts.net
# address with a real certificate — reachable only from their own devices.
# Which tailscale to use, and what to do when there is none, is the
# platform's (platform_tailscale_pick, platform_tailscale_provide).
TS_CMD=()
ts() { "${TS_CMD[@]}" "$@"; }

# ts_json PROGRAM — runs a node snippet over `tailscale ... --json` on stdin.
ts_json() {
  node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let d; try { d = JSON.parse(s); } catch { process.exit(1); }
      const out = ('"$1"')(d);
      if (out !== undefined && out !== null) console.log(out);
    });'
}

# Logs this machine in to the user's tailnet when it isn't yet: prints the
# login URL `tailscale up` asks for and waits until it's used.
tailscale_login() {
  local state
  state="$(ts status --json 2>/dev/null | ts_json '(d) => d.BackendState')" || true
  [ "$state" = Running ] && return 0
  local log pid url="" i
  log="$(mktemp)"
  ts up >"$log" 2>&1 &
  pid=$!
  for i in $(seq 60); do
    # grep finding nothing yet is not an error (set -e with pipefail would
    # otherwise end the whole script here, silently).
    url="$(grep -oE 'https://login\.tailscale\.com/[^[:space:]]+' "$log" | head -n 1 || true)"
    [ -n "$url" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if [ -n "$url" ]; then
    say ""
    say "${C_BOLD}$(msg install.tailscale.loginTitle)${C_RESET}"
    note "$(msg install.tailscale.loginHow)"
    link "$url"
    qr "$url"
  else
    warn "$(msg install.tailscale.noLoginLink command "${TS_CMD[*]}")"
    [ -s "$log" ] && sed 's/^/  tailscale: /' "$log" >&2
  fi
  note "$(msg install.tailscale.waitingLogin)"
  for i in $(seq 900); do
    state="$(ts status --json 2>/dev/null | ts_json '(d) => d.BackendState')" || true
    [ "$state" = Running ] && break
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  rm -f "$log"
  [ "$state" = Running ] || die "$(msg install.tailscale.loginIncomplete state "${state:-$(msg install.common.unknown)}")"
  ok "$(msg install.tailscale.loggedIn)"
}

# serve_target PORT — what the tailnet port PORT is served from on this
# machine (empty when nothing): an HTTPS proxy's target, or a plain TCP
# forward's (tcp://…), which would be just as overwritten.
serve_target() {
  ts serve status --json 2>/dev/null | ts_json "(d) => {
    for (const [hostPort, web] of Object.entries(d.Web ?? {})) {
      if (!hostPort.endsWith(':$1')) continue;
      const root = (web.Handlers ?? {})['/'];
      return root ? (root.Proxy ?? root.Path ?? root.Text ?? 'other') : 'other';
    }
    const tcp = (d.TCP ?? {})['$1'];
    if (tcp && !tcp.HTTPS && !tcp.HTTP) return tcp.TCPForward ? 'tcp://' + tcp.TCPForward : 'other';
  }" || true
}

# serve_ports_for URL — the tailnet HTTPS ports that proxy to URL.
serve_ports_for() {
  ts serve status --json 2>/dev/null | ts_json "(d) => Object.entries(d.Web ?? {})
    .filter(([, web]) => (web.Handlers ?? {})['/']?.Proxy === '$1')
    .map(([hostPort]) => hostPort.split(':').pop()).join(' ')" || true
}

# tailnet_url [PORT] — this machine's https address on the tailnet for the
# HTTPS port PORT (default --tailscale-https-port).
tailnet_url() {
  local name port="${1:-$TS_HTTPS_PORT}"
  name="$(ts status --json 2>/dev/null | ts_json '(d) => d.Self && d.Self.DNSName && d.Self.DNSName.replace(/\.$/, "")')" || true
  [ -n "$name" ] || return 1
  if [ "$port" = 443 ]; then printf 'https://%s' "$name"; else printf 'https://%s:%s' "$name" "$port"; fi
}

# served_url API_URL — the tailnet address already serving API_URL, if any.
served_url() {
  platform_tailscale_pick || return 1
  local port
  port="$(serve_ports_for "$1" | awk '{print $1}')"
  [ -n "$port" ] || return 1
  tailnet_url "$port"
}

# ---- status ----------------------------------------------------------------

# What is installed here, read back from .env, the unit, the API and
# Tailscale: shown by --status, and before a re-run asks what to change.
show_status() {
  local user port host api_url cors state_dir prefix service health node_bin ts_state="" base=""
  user="$(env_get AUTH_USERNAME)"
  port="$(env_get PORT)"; port="${port:-$DEFAULT_PORT}"
  host="$(env_get HOST)"; host="${host:-$DEFAULT_HOST}"
  api_url="$(local_api_url "$host" "$port")"
  cors="$(env_get CORS_ALLOWED_ORIGINS)"
  [ -n "$cors" ] || cors="$(msg install.status.corsDefault defaults "$(cors_defaults 2>/dev/null || printf 'Hestia App')")"
  state_dir="$(env_get HESTIA_STATE_DIR)"
  prefix="$(env_get HESTIA_SESSION_PREFIX)"
  service="$(platform_service_status)"
  if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$api_url/api/health" 2>/dev/null; then
    health="$(msg install.status.healthy)"
  else
    health="$(msg install.status.unhealthy)"
  fi
  node_bin="$(env_get HESTIA_NODE_BIN)"
  [ -n "$node_bin" ] || node_bin="$(cat "$API_DIR/.node-bin" 2>/dev/null || true)"
  if platform_tailscale_pick; then
    ts_state="$(ts status --json 2>/dev/null | ts_json '(d) => d.BackendState')" || true
    base="$(served_url "$api_url")" || base=""
  fi

  say "$(msg install.status.program dir "$API_DIR")"
  say "$(msg install.status.username name "${user:-$(msg install.status.unset)}")"
  say "$(msg install.status.api url "$api_url" health "$health")"
  say "$(msg install.status.service service "$service")"
  say "$(msg install.status.stateDir dir "${state_dir:-$(msg install.status.notInEnvParens)}" prefix "${prefix:-$(msg install.status.notInEnv)}")"
  say "$(msg install.status.frontends cors "$cors")"
  [ -n "$node_bin" ] && say "$(msg install.status.node path "$node_bin")"
  if [ -z "${TS_CMD[*]}" ]; then
    say "$(msg install.status.tailscaleMissing)"
  elif [ "$ts_state" != Running ]; then
    say "$(msg install.status.tailscaleLoggedOut state "${ts_state:-$(msg install.common.unknown)}")"
  elif [ -n "$base" ]; then
    say "$(msg install.status.tailscale url "$base")"
    say "$(msg install.status.pairing)"
  else
    say "$(msg install.status.tailscaleNotServing)"
  fi
}

# verify_password — reads a password on the terminal and checks it against
# AUTH_PASSWORD_HASH (scrypt, as api/src/auth.ts stores it). The password
# goes to node on stdin, never in argv.
verify_password() {
  local attempt
  read -r -s -p "  $(msg install.password.verifyPrompt)" attempt; echo
  printf '%s' "$attempt" | AUTH_PASSWORD_HASH="$(env_get AUTH_PASSWORD_HASH)" node -e '
    const { scryptSync, timingSafeEqual } = require("node:crypto");
    let pw = ""; process.stdin.on("data", (c) => (pw += c)).on("end", () => {
      const [kind, salt, hash] = (process.env.AUTH_PASSWORD_HASH ?? "").split(":");
      if (kind !== "scrypt" || !salt || !hash) process.exit(2);
      const expected = Buffer.from(hash, "hex");
      const actual = scryptSync(pw, Buffer.from(salt, "hex"), expected.length);
      process.exit(timingSafeEqual(actual, expected) ? 0 : 1);
    });'
}

# ---- uninstall -------------------------------------------------------------

uninstall() {
  step "$(msg install.uninstall.title)"
  # Stops only node: the tmux server and every session in it keep running.
  platform_service_remove

  # Only our own link — a hestia command from somewhere else stays.
  if [ -L "$LINK" ] && [ "$(readlink -f "$LINK")" = "$(readlink -f "$API_DIR/bin/hestia")" ]; then
    rm -f "$LINK"
    say "$(msg install.uninstall.removed path "$LINK")"
  fi

  # The serve this install set up, if any; Tailscale itself stays — it may
  # well serve other things.
  if platform_tailscale_pick; then
    local port host api_url ts_port
    port="$(env_get PORT)"; host="$(env_get HOST)"
    api_url="$(local_api_url "${host:-$DEFAULT_HOST}" "${port:-$DEFAULT_PORT}")"
    for ts_port in $(serve_ports_for "$api_url"); do
      ts serve --https="$ts_port" off >/dev/null && say "$(msg install.uninstall.serveOff port "$ts_port" url "$api_url")"
    done
  fi

  local state_dir
  state_dir="$(env_get HESTIA_STATE_DIR)"
  if [ -z "$state_dir" ] && [ -f "$API_DIR/dist/src/config.js" ]; then
    state_dir="$(resolved_paths "" "" 2>/dev/null | sed -n 1p || true)"
  fi
  state_dir="${state_dir:-$(default_state_dir)}"
  if [ "$PURGE" = 1 ]; then
    local refusal
    if ! refusal="$(purge_allowed "$state_dir")"; then
      die "$(msg install.uninstall.purgeRefused reason "$refusal" env "$ENV_FILE")"
    fi
    if [ "$INTERACTIVE" = 1 ] && ! confirm "$(msg install.uninstall.purgeConfirm env "$ENV_FILE" dir "$state_dir")" n; then
      say "$(msg install.uninstall.kept)"
    else
      # The settings themselves, wherever the link leads, then the link.
      [ -L "$ENV_FILE" ] && rm -f "$(readlink -f "$ENV_FILE")"
      rm -f "$ENV_FILE"
      rm -rf "$state_dir"
      say "$(msg install.uninstall.purged env "$ENV_FILE" dir "$state_dir")"
    fi
  else
    say "$(msg install.uninstall.keptFiles env "$ENV_FILE" dir "$state_dir")"
  fi
  say "$(msg install.uninstall.tmuxLeft)"
  # The program itself is left in place: this script is running from it.
  [ "$IS_RELEASE" = 1 ] && say "$(msg install.uninstall.programLeft dir "$API_DIR" command "rm -rf $(printf '%q' "$API_DIR")")"
  return 0
}

if [ "$UNINSTALL" = 1 ] || [ "$STATUS" = 1 ]; then
  # Reading tailscale's JSON needs a node; the machine may have none.
  [ -x "$NODE_HOME/current/bin/node" ] && PATH="$NODE_HOME/current/bin:$PATH"
fi
if [ "$STATUS" = 1 ]; then
  [ -f "$ENV_FILE" ] || die "$(msg install.status.notInstalled env "$ENV_FILE")"
  have node || die "$(msg install.status.noNode)"
  show_status
  exit 0
fi
if [ "$UNINSTALL" = 1 ]; then
  uninstall
  exit 0
fi

# ---- prerequisites ---------------------------------------------------------

printf '\n%s%s%s\n' "$C_BOLD" "$(msg install.intro.title)" "$C_RESET"
[ "$IS_RELEASE" = 1 ] && note "$(msg install.intro.release version "$(cat "$RELEASE_MARKER")" dir "$API_DIR")"
if [ "$DEPS_ONLY" = 1 ]; then
  note "$(msg install.intro.stepsDeps)"
elif [ "$TAILSCALE" = 1 ]; then
  note "$(msg install.intro.stepsTailscale)"
else
  note "$(msg install.intro.steps)"
fi

step "$(msg install.check.title)"
[ "$DEPS_ONLY" = 1 ] || have tmux || die "$(msg install.check.noTmux)"

# node_ok NODE — whether NODE satisfies api/package.json's engines
# (">=X.Y.Z"); node itself does the comparison, so there's no version
# parsing in shell. Quiet: only the exit status.
node_ok() {
  "$1" -e '
    const want = require(process.argv[1]).engines.node.replace(/[^0-9.]/g, "").split(".").map(Number);
    const have = process.versions.node.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((have[i] ?? 0) > (want[i] ?? 0)) process.exit(0);
      if ((have[i] ?? 0) < (want[i] ?? 0)) process.exit(1);
    }
  ' "$API_DIR/package.json" 2>/dev/null
}

# A Node.js of this user's own, when the machine has none recent enough:
# the official build for this platform (Linux, macOS) of the newest release
# of the major version the engines field asks for, checked against
# nodejs.org's SHASUMS256.txt. The system's node, if any, is left alone.
# The newest release of the major version engines.node asks for, e.g. v22.23.4.
latest_node_version() {
  have curl || die "$(msg install.node.noCurl)"
  local major version
  major="$(sed -n 's/.*"node": *">= *\([0-9]*\).*/\1/p' "$API_DIR/package.json" | head -n 1)"
  [ -n "$major" ] || die "$(msg install.node.noEngines)"
  # index.json lists the newest release first.
  version="$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json | grep -oE "\"version\":\"v$major\\.[0-9]+\\.[0-9]+\"" | head -n 1 | cut -d '"' -f 4 || true)"
  [ -n "$version" ] || die "$(msg install.node.noVersion major "$major")"
  printf '%s\n' "$version"
}

# Downloads that release into NODE_HOME and points current at it. The
# version it replaces stays beside it, to point current back at if needed.
download_node() {
  have curl || die "$(msg install.node.noCurl)"
  platform_sha256_available || die "$(msg install.node.noSha256sum)"
  local version="$1" arch file tmp
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "$(msg install.node.unsupportedCpu arch "$(uname -m)" major "$(printf '%s' "${version#v}" | cut -d . -f 1)")" ;;
  esac
  file="node-$version-$(platform_node_os)-$arch.tar.gz"
  tmp="$(mktemp -d)"
  note "$(msg install.node.downloading version "$version")"
  curl -fsSL "https://nodejs.org/dist/$version/$file" -o "$tmp/$file" \
    && curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    || { rm -rf "$tmp"; die "$(msg install.node.downloadFailed)"; }
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | platform_sha256_check) \
    || { rm -rf "$tmp"; die "$(msg install.node.badChecksum)"; }
  rm -rf "${NODE_HOME:?}/$version"
  mkdir -p "$NODE_HOME/$version"
  tar -xzf "$tmp/$file" -C "$NODE_HOME/$version" --strip-components=1
  rm -rf "$tmp"
  ln -sfn "$version" "$NODE_HOME/current"
  ok "$(msg install.node.downloaded version "$version" dir "$NODE_HOME")"
}

# Which node runs everything here — the build, the service and the
# hestia command: the machine's own when it's recent enough and has npm
# beside it (unless --bundled-node), else this user's own copy, downloaded
# when needed. Some distributions package npm apart from node.
if [ "$BUNDLED_NODE" = 0 ] && have node && node_ok "$(command -v node)" && have npm; then
  NODE_BIN="$(command -v node)"
  [ "$UPDATE_NODE" = 0 ] || note "$(msg install.node.updateIgnored node "$NODE_BIN")"
else
  if [ "$BUNDLED_NODE" = 0 ]; then
    if have node && node_ok "$(command -v node)"; then
      note "$(msg install.node.noNpm version "$(node --version)")"
    elif have node; then
      note "$(msg install.node.tooOld version "$(node --version)" wanted "$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' "$API_DIR/package.json" | head -n 1)")"
    else
      note "$(msg install.node.missing)"
    fi
  fi
  # The downloaded node is kept until asked to update (--update-node): on
  # macOS, folder permissions belong to the node binary, so a new one is
  # asked about again (macos.tcc.new-node-asks-again in
  # docs/reference/host-platform-caveats.md). A newer release is only
  # mentioned, and not being able to look it up is no reason to stop.
  if ! { [ -x "$NODE_HOME/current/bin/node" ] && node_ok "$NODE_HOME/current/bin/node"; }; then
    download_node "$(latest_node_version)"
  else
    node_have="$("$NODE_HOME/current/bin/node" --version)"
    if [ "$UPDATE_NODE" = 1 ]; then
      node_latest="$(latest_node_version)"
      if [ "$node_latest" = "$node_have" ]; then
        ok "$(msg install.node.upToDate version "$node_have")"
      else
        note "$(msg install.node.updating version "$node_have" latest "$node_latest")"
        download_node "$node_latest"
      fi
    else
      node_latest="$(latest_node_version 2>/dev/null || true)"
      if [ -n "$node_latest" ] && [ "$node_latest" != "$node_have" ]; then
        note "$(msg install.node.updateAvailable version "$node_have" latest "$node_latest")"
      fi
    fi
  fi
  NODE_BIN="$NODE_HOME/current/bin/node"
  node_ok "$NODE_BIN" || die "$(msg install.node.notEngines node "$NODE_BIN")"
  # npm, npx and every node below (the build, the env writer) are
  # this one's.
  export PATH="$NODE_HOME/current/bin:$PATH"
fi
have npm || die "$(msg install.node.noNpmAtAll)"
ok "$(msg install.check.node version "$("$NODE_BIN" --version)" path "$NODE_BIN" npm "$(npm --version)")"
ok "$(tmux -V)"

found_cli=""
for cli in claude codex gemini agy; do
  have "$cli" && found_cli="$found_cli $cli"
done
if [ -n "$found_cli" ]; then
  ok "$(msg install.check.cli list "${found_cli# }")"
else
  warn "$(msg install.check.noCli)"
fi

# A re-run over an existing install: show what's there, and by default
# only update the program, asking nothing else. Options given on the
# command line mean the caller already said what to change.
KEEP_SETTINGS=0
if [ "$DEPS_ONLY" = 0 ] && [ -n "$(env_get AUTH_PASSWORD_HASH)" ] && [ "$INTERACTIVE" = 1 ] \
  && [ -z "$OPT_USERNAME$OPT_PORT$OPT_CORS$OPT_STATE_DIR$OPT_SESSION_PREFIX$OPT_COMMAND_NAME" ]; then
  step "$(msg install.rerun.title)"
  show_status
  printf '\n' 
  if confirm "$(msg install.rerun.keep)" y; then
    KEEP_SETTINGS=1
    INTERACTIVE=0
    # Keep serving it on the tailnet the way it already is.
    kept_host="$(env_get HOST)"; kept_port="$(env_get PORT)"
    ts_port="$(platform_tailscale_pick && serve_ports_for "$(local_api_url "${kept_host:-$DEFAULT_HOST}" "${kept_port:-$DEFAULT_PORT}")" | awk '{print $1}' || true)"
    if [ -n "$ts_port" ]; then TAILSCALE=1; TS_HTTPS_PORT="$ts_port"; fi
  fi
fi


if [ "$SERVICE" = 1 ] && [ "$DEPS_ONLY" = 0 ] && platform_service_available; then
  check_existing_unit
fi

# The tailnet port asked for, checked before anything is built or
# written: something else already served there (another site on 443, say)
# is reported now, not after the service has been replaced. Only when
# Tailscale is already up; a fresh one is checked again once it is.
if [ "$TAILSCALE" = 1 ] && [ "$DEPS_ONLY" = 0 ] && platform_tailscale_pick; then
  early_host="$(env_get HOST)"
  early_port="${OPT_PORT:-$(env_get PORT)}"
  is_loopback_host "${early_host:-$DEFAULT_HOST}" || early_host="$DEFAULT_HOST"
  taken="$(serve_target "$TS_HTTPS_PORT")"
  if [ -n "$taken" ] && [ "$taken" != "$(local_api_url "${early_host:-$DEFAULT_HOST}" "${early_port:-$DEFAULT_PORT}")" ]; then
    die "$(msg install.tailscale.portTaken port "$TS_HTTPS_PORT" target "$taken")"
  fi
fi

# ---- build -----------------------------------------------------------------

# A release bundle comes built: only its runtime dependencies are needed.
# A source checkout builds, which takes the dev dependencies too.
if [ "$BUILD" = 0 ]; then
  step "$(msg install.build.title)"
  note "$(msg install.build.skipped)"
elif [ "$IS_RELEASE" = 1 ]; then
  step "$(msg install.build.depsTitle)"
  run_quiet "$(msg install.build.runtimeDeps)" npm --prefix "$API_DIR" ci --omit=dev --no-audit --no-fund
else
  step "$(msg install.build.title)"
  run_quiet "$(msg install.build.deps)" npm --prefix "$API_DIR" ci --no-audit --no-fund
  run_quiet "$(msg install.build.compile)" npm --prefix "$API_DIR" run build
fi
[ -f "$API_DIR/dist/src/main.js" ] || die "$(msg install.build.missing path "$API_DIR/dist/src/main.js")"
[ -f "$API_DIR/dist/scripts/write-env.js" ] || die "$(msg install.build.missing path "$API_DIR/dist/scripts/write-env.js")"
[ -d "$API_DIR/node_modules/express" ] || die "$(msg install.build.missing path node_modules)"
if [ "$DEPS_ONLY" = 1 ]; then
  ok "$(msg install.build.depsReady)"
  rm -f "$LOG_FILE"
  exit 0
fi

# ---- settings and credentials ----------------------------------------------

step "$(msg install.settings.title)"
USERNAME="$(ask "$(msg install.settings.username)" "${OPT_USERNAME:-$(env_get AUTH_USERNAME)}")"
[ -n "$USERNAME" ] || die "$(msg install.settings.usernameNeeded)"
# .env holds values bare, and its parser reads # as a comment: `me#2`
# would come back as `me` and the login never match.
case "$USERNAME" in *'#'*) die "$(msg install.settings.usernameHash name "$USERNAME")" ;; esac
PORT="$(ask "$(msg install.settings.port)" "${OPT_PORT:-$(env_get PORT)}")"
PORT="${PORT:-$DEFAULT_PORT}"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "$(msg install.settings.badPort port "$PORT")"
# Loopback only, never asked: the API is as good as a shell on this
# machine, and the API itself refuses to start on any other address
# (config.ts isLoopbackHost). An older install may have written another
# one; it is reset here, out loud.
HOST_ADDR="$(env_get HOST)"
HOST_ADDR="${HOST_ADDR:-$DEFAULT_HOST}"
if ! is_loopback_host "$HOST_ADDR"; then
  warn "$(msg install.settings.hostReset host "$HOST_ADDR" default "$DEFAULT_HOST")"
  note "$(msg install.settings.hostHow)" >&2
  HOST_ADDR="$DEFAULT_HOST"
fi
# Not asked: almost everyone wants the defaults. Blank means them.
CORS="$(choose_cors)"
STATE_DIR="${OPT_STATE_DIR:-$(env_get HESTIA_STATE_DIR)}"
# Stored absolute: the service resolves a relative path against api/, the
# hestia command against wherever it's run, so they'd each look for
# the registry and cli-token somewhere else. A quoted "~/..." isn't
# expanded by the shell, and node never expands it.
if [ -n "$STATE_DIR" ]; then
  # shellcheck disable=SC2088 # matching a literal, unexpanded ~ is the point
  case "$STATE_DIR" in
    "~") STATE_DIR="$HOME" ;;
    "~/"*) STATE_DIR="$HOME/${STATE_DIR#"~/"}" ;;
  esac
  case "$STATE_DIR" in
    /*) ;;
    *) STATE_DIR="$PWD/$STATE_DIR" ;;
  esac
fi

# The hestia command, the health check below and tailscale serve all
# connect to HOST.
LOCAL_API_URL="$(local_api_url "$HOST_ADDR" "$PORT")"

# Where state lives and what this backend's tmux sessions are called,
# exactly as the API will resolve them, then written to .env so the service
# and the hestia command (whose environments differ, e.g. in
# XDG_CONFIG_HOME) always agree, and a later install never renames them.
SESSION_PREFIX="${OPT_SESSION_PREFIX:-$(env_get HESTIA_SESSION_PREFIX)}"
RESOLVED="$(resolved_paths "$STATE_DIR" "$SESSION_PREFIX")" || die "$(msg install.settings.pathsFailedWhy)"
STATE_DIR_EFFECTIVE="$(printf '%s\n' "$RESOLVED" | sed -n 1p)"
SESSION_PREFIX="$(printf '%s\n' "$RESOLVED" | sed -n 2p)"
[ -n "$STATE_DIR_EFFECTIVE" ] && [ -n "$SESSION_PREFIX" ] || die "$(msg install.settings.pathsFailed)"

# The password never reaches argv or the env file — only its hash does.
PASSWORD=""
if [ "$PASSWORD_STDIN" = 1 ]; then
  IFS= read -r PASSWORD || true
elif [ -n "${HESTIA_PASSWORD:-}" ]; then
  PASSWORD="$HESTIA_PASSWORD"
fi
unset HESTIA_PASSWORD
EXISTING_HASH="$(env_get AUTH_PASSWORD_HASH)"
NEW_PASSWORD=0
if [ -z "$PASSWORD" ] && [ "$INTERACTIVE" = 1 ]; then
  if [ -z "$EXISTING_HASH" ]; then
    NEW_PASSWORD=1
  else
    # Asking for the old password first would guard nothing: whoever can
    # run this can already rewrite .env. Verifying is only a convenience.
    while true; do
      read -r -p "  $(msg install.password.choice)" choice
      case "$choice" in
        "") break ;;
        r|R) NEW_PASSWORD=1; break ;;
        v|V)
          if verify_password; then
            say "$(msg install.password.right)"; break
          else
            warn "$(msg install.password.wrong)"
            if confirm "$(msg install.password.reset)" y; then NEW_PASSWORD=1; break; fi
          fi ;;
        *) ;;
      esac
    done
  fi
fi
if [ "$NEW_PASSWORD" = 1 ]; then
  read -r -s -p "  $(msg install.password.new)" PASSWORD; echo
  read -r -s -p "  $(msg install.password.again)" confirm_password; echo
  [ "$PASSWORD" = "$confirm_password" ] || die "$(msg install.password.mismatch)"
  unset confirm_password
fi
if [ -z "$PASSWORD" ] && [ -z "$EXISTING_HASH" ]; then
  die "$(msg install.password.needed)"
fi

prepare_state_dir "$STATE_DIR_EFFECTIVE"
place_env_file "$STATE_DIR_EFFECTIVE"

settings=(AUTH_USERNAME="$USERNAME" PORT="$PORT" HOST="$HOST_ADDR" CORS_ALLOWED_ORIGINS="$CORS"
  HESTIA_STATE_DIR="$STATE_DIR_EFFECTIVE" HESTIA_SESSION_PREFIX="$SESSION_PREFIX" HESTIA_ENV_VERSION="$ENV_VERSION"
  HESTIA_NODE_BIN="$NODE_BIN" HESTIA_COMMAND_NAME="$COMMAND_NAME")
if [ -n "$PASSWORD" ]; then
  printf '%s\n' "$PASSWORD" | "$NODE_BIN" "$API_DIR/dist/scripts/write-env.js" "$ENV_FILE" --password-stdin "${settings[@]}"
else
  "$NODE_BIN" "$API_DIR/dist/scripts/write-env.js" "$ENV_FILE" "${settings[@]}"
fi
PASSWORD=""
ok "$(msg install.settings.summary name "$USERNAME" address "$HOST_ADDR:$PORT")"
ok "$(msg install.settings.stateDir dir "$STATE_DIR_EFFECTIVE" prefix "$SESSION_PREFIX")"
note "$(msg install.settings.written file "$STATE_DIR_EFFECTIVE/.env" env "$ENV_FILE")"

# ---- service ---------------------------------------------------------------

wait_for_health() {
  node -e '
    const url = `${process.argv[1]}/api/health`;
    const until = Date.now() + 15000;
    (async function poll() {
      try { if ((await fetch(url)).ok) process.exit(0); } catch {}
      if (Date.now() > until) process.exit(1);
      setTimeout(poll, 500);
    })();
  ' "$LOCAL_API_URL"
}

FOREGROUND_CMD="cd $(printf '%q' "$API_DIR") && node --env-file=.env dist/src/main.js"
SERVICE_RUNNING=0
if [ "$SERVICE" = 0 ]; then
  step "$(msg install.service.title)"
  note "$(msg install.service.skipped)"
  link "$FOREGROUND_CMD"
elif ! platform_service_available; then
  step "$(msg install.service.title)"
  platform_service_unavailable_warn
  link "$FOREGROUND_CMD"
else
  step "$(msg install.service.title)"
  platform_service_install
  if wait_for_health; then
    SERVICE_RUNNING=1
    ok "$(msg install.service.started url "$LOCAL_API_URL")"
  else
    warn "$(msg install.service.noAnswer command "$(platform_service_log_command)")"
  fi
  # Still up after logout, and at boot, where the platform can do that.
  platform_keep_running
fi

# ---- command link ----------------------------------------------------------

# The hestia command runs on the same node as the service (HESTIA_NODE_BIN
# in .env, written above), not whatever `node` a shell finds first. Older
# installs kept it in a file of its own in the program folder.
rm -f "$API_DIR/.node-bin"

mkdir -p "$BIN_DIR"
# Another install's link (a second backend on this machine) is kept unless
# asked: the command follows whichever backend it was linked for.
LINK_TARGET="$API_DIR/bin/hestia"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  warn "$(msg install.link.notLink link "$LINK")"
elif [ -L "$LINK" ] && [ "$(readlink -f "$LINK")" != "$(readlink -f "$LINK_TARGET")" ] \
  && ! confirm "$(msg install.link.switch link "$LINK" target "$(readlink -f "$LINK")")" n; then
  note "$(msg install.link.kept name "$COMMAND_NAME" target "$(readlink -f "$LINK")")"
else
  ln -sfn "$LINK_TARGET" "$LINK"
  ok "$(msg install.link.made name "$COMMAND_NAME" link "$LINK")"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$(msg install.link.notOnPath dir "$BIN_DIR" line 'export PATH="$HOME/.local/bin:$PATH"')" ;;
esac

# ---- tailscale -------------------------------------------------------------

BASE_URL=""
if [ "$TAILSCALE" = 1 ]; then
  step "$(msg install.tailscale.title)"
  platform_tailscale_pick || platform_tailscale_provide
  tailscale_login
  existing="$(serve_target "$TS_HTTPS_PORT")"
  if [ -n "$existing" ] && [ "$existing" != "$LOCAL_API_URL" ]; then
    die "$(msg install.tailscale.portTaken port "$TS_HTTPS_PORT" target "$existing")"
  fi
  # tailscale serve waits, printing a URL, the first time a tailnet uses
  # serve: run it in the background, show that URL plainly when it comes,
  # and keep its own (English) output for the log.
  serve_log="$(mktemp)"
  ts serve --bg --https="$TS_HTTPS_PORT" "$LOCAL_API_URL" >"$serve_log" 2>&1 &
  serve_pid=$!
  serve_prompted=0
  [ -t 1 ] && printf '  %s%s%s' "$C_DIM" "$(msg install.tailscale.serving)" "$C_RESET"
  while kill -0 "$serve_pid" 2>/dev/null; do
    if [ "$serve_prompted" = 0 ]; then
      serve_url="$(grep -oE 'https://login\.tailscale\.com/[^[:space:]]+' "$serve_log" | head -n 1 || true)"
      if [ -n "$serve_url" ]; then
        serve_prompted=1
        [ -t 1 ] && printf '\r\033[K'
        say ""
        say "${C_BOLD}$(msg install.tailscale.allowServe)${C_RESET}"
        note "$(msg install.tailscale.allowHow)"
        link "$serve_url"
        qr "$serve_url"
        note "$(msg install.tailscale.waitingAllow)"
      fi
    fi
    sleep 0.5
  done
  [ -t 1 ] && [ "$serve_prompted" = 0 ] && printf '\r\033[K'
  cat "$serve_log" >>"$LOG_FILE"
  if wait "$serve_pid"; then
    BASE_URL="$(tailnet_url)" || warn "$(msg install.tailscale.noName)"
    [ -n "$BASE_URL" ] && ok "$(msg install.tailscale.served url "$BASE_URL")"
  else
    sed 's/^/      /' "$serve_log" >&2
    platform_tailscale_serve_failed
  fi
  rm -f "$serve_log"
else
  BASE_URL="$(served_url "$LOCAL_API_URL")" || BASE_URL=""
fi

# `hestia pair` reads the address from .env, so it can show a new QR
# code whenever another phone needs one.
if [ -n "$BASE_URL" ]; then
  "$NODE_BIN" "$API_DIR/dist/scripts/write-env.js" "$ENV_FILE" HESTIA_PUBLIC_URL="$BASE_URL" >>"$LOG_FILE" 2>&1 \
    || warn "$(msg install.tailscale.urlNotSaved env "$ENV_FILE")"
fi

# ---- done ------------------------------------------------------------------

# How to run the command from here: by name when the link is ours and on
# PATH, else by its full path.
RUN_CMD="$COMMAND_NAME"
if [ "$(readlink -f "$LINK" 2>/dev/null)" != "$(readlink -f "$LINK_TARGET")" ] || ! have "$COMMAND_NAME"; then
  RUN_CMD="$LINK_TARGET"
fi
PAIR_CMD="$RUN_CMD pair"

step "$(msg install.done.title)"
if [ -n "$BASE_URL" ] && [ "$SERVICE_RUNNING" = 1 ]; then
  ok "$(msg install.done.url url "$BASE_URL")"
  say ""
  # A fresh pairing code and its QR code, from the running API — without
  # waiting for the scan, so the rest of this summary still shows.
  if ! "$NODE_BIN" --env-file="$ENV_FILE" "$API_DIR/dist/src/cli/main.js" pair --no-wait; then
    warn "$(msg install.done.pairFailed command "$PAIR_CMD")"
  fi
  say ""
  note "$(msg install.done.localNetwork)"
elif [ -n "$BASE_URL" ]; then
  ok "$(msg install.done.url url "$BASE_URL")"
  note "$(msg install.done.pairLater command "$PAIR_CMD")"
else
  note "$(msg install.done.localOnly address "$HOST_ADDR:$PORT")"
fi

say ""
say "${C_BOLD}$(msg install.done.commands)${C_RESET}"
[ -n "$BASE_URL" ] && say "  $(msg install.done.newPhone command "${C_CYAN}$PAIR_CMD${C_RESET}")"
say "  $(msg install.done.status command "${C_CYAN}$0 --status${C_RESET}")"
[ "$SERVICE_RUNNING" = 1 ] && say "  $(msg install.done.log command "${C_CYAN}$(platform_service_follow_command)${C_RESET}")"
say "  $(msg install.done.open command "${C_CYAN}$RUN_CMD open [$(msg install.done.folder)] --claude${C_RESET}")"
if [ "$IS_RELEASE" = 1 ]; then
  say "  $(msg install.done.upgradeRelease uninstall "${C_CYAN}$0 --uninstall${C_RESET}")"
else
  say "  $(msg install.done.upgradeSource pull "${C_CYAN}git pull${C_RESET}" script "${C_CYAN}$0${C_RESET}" uninstall "${C_CYAN}$0 --uninstall${C_RESET}")"
fi
note "$(msg install.done.username name "$USERNAME")"
rm -f "$LOG_FILE"
