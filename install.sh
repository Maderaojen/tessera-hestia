#!/bin/sh
# Hestia's one-line installer, and its upgrader: run it again to upgrade.
#
#   HESTIA_RELEASE_PUBLIC_KEY=/path/to/trusted-release-public.pem sh ./install.sh
#   HESTIA_RELEASE_PUBLIC_KEY=/path/to/trusted-release-public.pem sh ./install.sh --tailscale
#
# Obtain this installer and verify the public key independently first. See
# docs/guides/release-signing.md; bundle signatures cannot secure a modified
# bootstrap script.
#
# Downloads a release bundle of the backend (already built), checks it
# against the release's SHA256SUMS, unpacks it into
# ~/.local/share/hestia/app (keeping that install's .env), installs its
# runtime dependencies (npm ci --omit=dev, in a staging folder first, so a
# failure leaves the running install alone), then hands over to the
# bundle's own scripts/install.sh with every option given here: the
# account, the user service (systemd on Linux, launchd on macOS), Tailscale,
# pairing. See docs/guides/install.md.
#
# Settings and data stay where they are across upgrades: both live in
# ~/.config/madera/hestia (the settings in its .env, which the app folder's
# .env links to; the state: sessions, projects, notes, uploads), and the
# Node.js the installer may have downloaded is in ~/.local/share/hestia/node.
#
# Environment:
#   HESTIA_VERSION        the release to install, vX.Y.Z (default: the latest)
#   HESTIA_REPO           GitHub owner/name (default: maderaojen/tessera-hestia)
#   HESTIA_DOWNLOAD_BASE  where <version>/<file> are downloaded from
#                         (default: https://github.com/$HESTIA_REPO/releases/download;
#                         a file:// URL works too, for testing a release locally)
#   HESTIA_HOME           default: ${XDG_DATA_HOME:-~/.local/share}/hestia
#                         (the program in app/, a downloaded Node.js in node/)
#   HESTIA_RELEASE_PUBLIC_KEY  trusted local RSA public key PEM (required;
#                         default: $HESTIA_HOME/release-public.pem). Provision
#                         independently; never download it with the bundle.
#   HESTIA_NO_SETUP=1     stop once the new version is unpacked and its
#                         dependencies installed: no .env, service, link or
#                         Tailscale changes (for testing)
set -eu

# All in main, called on the last line: piped from curl, a download cut
# short then runs nothing rather than half a script.
main() {
REPO="${HESTIA_REPO:-maderaojen/tessera-hestia}"
DOWNLOAD_BASE="${HESTIA_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}"
HESTIA_HOME="${HESTIA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hestia}"
# The bundle's installer puts a Node.js it downloads under it too.
export HESTIA_HOME
APP_DIR="$HESTIA_HOME/app"
STAGING="$HESTIA_HOME/app.new"

say() { printf '  %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

for tool in curl tar bash mktemp openssl; do
  have "$tool" || die "找不到 ${tool}，請先安裝它"
done
if have sha256sum; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif have shasum; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "找不到 sha256sum 或 shasum，無法驗證下載的檔案"
fi

# A local trust root must be provisioned independently of the release host.
# No unsigned fallback: a checksum from the same origin is not authentication.
RELEASE_PUBLIC_KEY="${HESTIA_RELEASE_PUBLIC_KEY:-$HESTIA_HOME/release-public.pem}"
[ -f "$RELEASE_PUBLIC_KEY" ] || die "缺少可信任的發布公鑰：${RELEASE_PUBLIC_KEY}；請依安裝指南獨立核對並配置 HESTIA_RELEASE_PUBLIC_KEY"
openssl pkey -pubin -in "$RELEASE_PUBLIC_KEY" -noout >/dev/null 2>&1 || die "發布公鑰不是有效的 PEM"

# ---- which version ---------------------------------------------------------

VERSION="${HESTIA_VERSION:-}"
if [ -z "$VERSION" ]; then
  # github.com/<repo>/releases/latest redirects to .../releases/tag/<tag>:
  # the tag without the rate-limited API or a JSON parser.
  latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" \
    || die "無法取得最新版本（https://github.com/$REPO/releases/latest）"
  VERSION="${latest##*/}"
fi
case "$VERSION" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "版本號應該是 vX.Y.Z：$VERSION" ;;
esac
printf '%s\n' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "版本號應該是 vX.Y.Z：$VERSION"

BUNDLE="hestia-$VERSION.tar.gz"
printf '\nHestia %s\n' "$VERSION"

# ---- download and verify ---------------------------------------------------

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hestia-get.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "下載 ${BUNDLE}…"
curl -fsSL "$DOWNLOAD_BASE/$VERSION/$BUNDLE" -o "$TMP/$BUNDLE" || die "下載失敗：$DOWNLOAD_BASE/$VERSION/$BUNDLE"
curl -fsSL "$DOWNLOAD_BASE/$VERSION/SHA256SUMS" -o "$TMP/SHA256SUMS" || die "下載失敗：$DOWNLOAD_BASE/$VERSION/SHA256SUMS"

curl -fsSL "$DOWNLOAD_BASE/$VERSION/SHA256SUMS.sig" -o "$TMP/SHA256SUMS.sig" || die "下載發布簽章失敗"
openssl dgst -sha256 -verify "$RELEASE_PUBLIC_KEY" -signature "$TMP/SHA256SUMS.sig" "$TMP/SHA256SUMS" >/dev/null 2>&1 \
  || die "發布簽章驗證失敗，已放棄"
say "✓ 發布簽章驗證通過"

expected="$(awk -v f="$BUNDLE" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS 裡沒有 $BUNDLE"
[ "$(printf '%s\n' "$expected" | wc -l)" -eq 1 ] || die "SHA256SUMS 裡 $BUNDLE 出現不只一次"
actual="$(sha256 "$TMP/$BUNDLE")"
[ "$actual" = "$expected" ] || die "$BUNDLE 的 SHA-256 不符，已放棄（預期 ${expected}，實際 ${actual}）"
say "✓ SHA-256 驗證通過"

# Everything in the bundle is under hestia-<version>/, a plain file or
# folder, and never climbs out of it.
tar -tzf "$TMP/$BUNDLE" >"$TMP/list" || die "$BUNDLE 不是有效的 tar.gz"
if grep -Ev "^hestia-$VERSION/" "$TMP/list" | grep -q . \
  || grep -Eq '(^|/)\.\.(/|$)' "$TMP/list"; then
  die "$BUNDLE 裡有不在 hestia-$VERSION/ 底下的路徑，已放棄"
fi
if tar -tvzf "$TMP/$BUNDLE" | cut -c1 | grep -q '[^-d]'; then
  die "$BUNDLE 裡有連結或特殊檔案，已放棄"
fi

# ---- unpack into a staging folder ------------------------------------------

mkdir -p "$HESTIA_HOME"
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$TMP/$BUNDLE" -C "$STAGING" --strip-components=1 --no-same-owner
[ "$(cat "$STAGING/.hestia-release" 2>/dev/null)" = "$VERSION" ] || die "$BUNDLE 不是 Hestia $VERSION 的版本包"

# This install's own files, which are not part of any release. .env is
# normally a link into the state folder (scripts/install.sh places it
# there): the link is carried over, not a copy of what it points at.
# .node-bin only exists in older installs (the node path now lives in .env);
# carried over for them, and removed once the installer below has run.
for kept in .env .node-bin; do
  if [ -f "$APP_DIR/$kept" ] || [ -L "$APP_DIR/$kept" ]; then cp -P -p "$APP_DIR/$kept" "$STAGING/$kept"; fi
done

# Runtime dependencies, in the staging folder: a failure here leaves the
# current install as it was. Only --bundled-node matters for this step.
deps_opts=""
for arg in "$@"; do
  if [ "$arg" = --bundled-node ]; then deps_opts="--bundled-node"; fi
done
# shellcheck disable=SC2086 # deps_opts is one word or none
bash "$STAGING/scripts/install.sh" --deps-only $deps_opts </dev/null \
  || die "安裝相依套件失敗；原本的安裝沒有變動（新版本留在 ${STAGING}）"

# ---- switch over -----------------------------------------------------------

if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR.old"
  mv "$APP_DIR" "$APP_DIR.old"
fi
mv "$STAGING" "$APP_DIR"
rm -rf "$APP_DIR.old"
say "✓ Hestia $VERSION 已放在 $APP_DIR"

if [ "${HESTIA_NO_SETUP:-}" = 1 ]; then
  say "HESTIA_NO_SETUP=1：到此為止，沒有寫設定、沒有安裝或重啟服務。"
  exit 0
fi

# ---- the bundle's own installer ---------------------------------------------

# Piped from curl, this script's stdin is the script itself: the installer's
# questions (account, password) are asked on the terminal instead, unless
# the password is coming on stdin.
password_stdin=0
for arg in "$@"; do
  if [ "$arg" = --password-stdin ]; then password_stdin=1; fi
done
trap - EXIT INT TERM
rm -rf "$TMP"
if [ "$password_stdin" = 0 ] && [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
  exec bash "$APP_DIR/scripts/install.sh" --skip-build "$@" </dev/tty
fi
exec bash "$APP_DIR/scripts/install.sh" --skip-build "$@"
}

main "$@"
