#!/bin/sh
# Hestia's one-line installer, and its upgrader: run it again to upgrade.
#
#   curl -fsSL https://github.com/maderaojen/tessera-hestia/releases/latest/download/install.sh | sh -s -- --tailscale
#
# or download it first, look at it, check the fingerprint of the public key
# below, then run it: sh ./install.sh --tailscale. What the one-line form
# trusts, and how to check it some other way: docs/guides/release-signing.md.
#
# Downloads a release bundle of the backend (already built), checks the
# release's signature (SHA256SUMS.sig, with the release public key) and the
# bundle against its SHA256SUMS, unpacks it into
# ~/.local/share/hestia/app (keeping that install's .env), installs its
# runtime dependencies (npm ci --omit=dev, in a staging folder first, so a
# failure leaves the running install alone), then hands over to the
# bundle's own scripts/install.sh with every option given here: the
# account, the user service (systemd on Linux, launchd on macOS), Tailscale,
# pairing. See docs/guides/install.md.
#
# The release public key: HESTIA_RELEASE_PUBLIC_KEY if given, otherwise
# $HESTIA_HOME/release-public.pem if there is one, otherwise the one
# written in this file (EMBEDDED_RELEASE_PUBLIC_KEY), which the first
# install then saves as $HESTIA_HOME/release-public.pem: later upgrades
# trust that file, not whatever installer they were run with.
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
#                         (the program in app/, a downloaded Node.js in node/,
#                         the release public key in release-public.pem)
#   HESTIA_RELEASE_PUBLIC_KEY  a release public key (RSA, PEM) to use instead
#                         of the saved or the embedded one
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

# The release public key (RSA 3072), SHA-256 fingerprint of its DER form:
# 63decd33da1896e188725c3264e0778b7bcaf32c2d52b3e1ff1b81dfa757084a
# (openssl pkey -pubin -in release-public.pem -outform DER | openssl dgst -sha256).
# A new key is changed here, in the same commit as the release that is
# signed with it; existing installs keep their saved key until it is
# replaced on purpose (docs/guides/release-signing.md).
EMBEDDED_RELEASE_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAys/V+dKxLM3+to5XGJvX
ZrB03XKJzBOqRI+Qb99GMewP42iWtBBbbEU/9InQWMAIRMyT/qblCQQ7T9y6qoVL
O51GGqgcGbiJ8E3xSjESLdAfsyF3jT/pc/KlxZSFMeFk2byHJGOWdACbL0k1kLPL
1X8byyRzjR7XwGQEd76MXx90cWeWJ2Qq5P19YdIFid5sIWdqvJLUzakA9Buvdquy
14he+6RNrKf2ZMD2Chz6Gush2mvhsL7z1/inOIE7wWiFRLNNvwiCwu8k2obKcYHL
UJ1M1ABmF6wSguPmMzcpc3TwzdXUnLljZSty55+qVvkAqOcy+CUD4Vfj3G+pfGw6
fhd7yXMpm24wNLpewB9Fujp4rXS6UyNOe/F+/Q5euW00ZAM8dKOC+/OWPKFiOtvG
jz676JSLlAsIr72XQK1/L+BJGdCDv7TQWuZz4nDg/ClLHua9GiBbMmU4SWFZ+JKG
sZnuyx6kq/fBzK1bnrcHtR+0KRvmQZMGd3I/Nl3F/VLhAgMBAAE=
-----END PUBLIC KEY-----'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hestia-get.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

# fingerprint PEM — SHA-256 of a public key's DER form, as in the comment above.
fingerprint() { openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 | sed 's/^.*= *//'; }

# No unsigned fallback: a checksum from the same origin is not authentication.
printf '%s\n' "$EMBEDDED_RELEASE_PUBLIC_KEY" >"$TMP/embedded-release-public.pem"
SAVED_PUBLIC_KEY="$HESTIA_HOME/release-public.pem"
SAVE_PUBLIC_KEY=0
if [ -n "${HESTIA_RELEASE_PUBLIC_KEY:-}" ]; then
  RELEASE_PUBLIC_KEY="$HESTIA_RELEASE_PUBLIC_KEY"
  [ -f "$RELEASE_PUBLIC_KEY" ] || die "找不到 HESTIA_RELEASE_PUBLIC_KEY 指定的發布公鑰：${RELEASE_PUBLIC_KEY}"
elif [ -f "$SAVED_PUBLIC_KEY" ]; then
  RELEASE_PUBLIC_KEY="$SAVED_PUBLIC_KEY"
else
  RELEASE_PUBLIC_KEY="$TMP/embedded-release-public.pem"
  SAVE_PUBLIC_KEY=1
fi
if [ "$SAVE_PUBLIC_KEY" = 1 ]; then KEY_NAME="這個安裝器內建的公鑰"; else KEY_NAME="$RELEASE_PUBLIC_KEY"; fi
openssl pkey -pubin -in "$RELEASE_PUBLIC_KEY" -noout >/dev/null 2>&1 || die "發布公鑰不是有效的 PEM：${KEY_NAME}"
if [ "$SAVE_PUBLIC_KEY" = 0 ] && [ "$(fingerprint "$RELEASE_PUBLIC_KEY")" != "$(fingerprint "$TMP/embedded-release-public.pem")" ]; then
  say "使用 ${RELEASE_PUBLIC_KEY} 的發布公鑰（和這個安裝器內建的不同）"
fi

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

say "下載 ${BUNDLE}…"
curl -fsSL "$DOWNLOAD_BASE/$VERSION/$BUNDLE" -o "$TMP/$BUNDLE" || die "下載失敗：$DOWNLOAD_BASE/$VERSION/$BUNDLE"
curl -fsSL "$DOWNLOAD_BASE/$VERSION/SHA256SUMS" -o "$TMP/SHA256SUMS" || die "下載失敗：$DOWNLOAD_BASE/$VERSION/SHA256SUMS"

curl -fsSL "$DOWNLOAD_BASE/$VERSION/SHA256SUMS.sig" -o "$TMP/SHA256SUMS.sig" || die "下載發布簽章失敗"
openssl dgst -sha256 -verify "$RELEASE_PUBLIC_KEY" -signature "$TMP/SHA256SUMS.sig" "$TMP/SHA256SUMS" >/dev/null 2>&1 \
  || die "發布簽章驗證失敗，已放棄（用的公鑰：${KEY_NAME}）"
say "✓ 發布簽章驗證通過"
# The first install keeps the key it trusted: upgrades check against it,
# whichever installer runs them. Only the owner can change the folder.
if [ "$SAVE_PUBLIC_KEY" = 1 ]; then
  mkdir -p "$HESTIA_HOME"
  chmod go-w "$HESTIA_HOME"
  cp "$RELEASE_PUBLIC_KEY" "$SAVED_PUBLIC_KEY.new"
  chmod 644 "$SAVED_PUBLIC_KEY.new"
  mv "$SAVED_PUBLIC_KEY.new" "$SAVED_PUBLIC_KEY"
  say "✓ 發布公鑰存成 ${SAVED_PUBLIC_KEY}，之後的升級以它為準"
fi

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
# current install as it was. Only the Node.js options matter for this step
# (it is the one that picks, and downloads, the node).
deps_opts=""
for arg in "$@"; do
  case "$arg" in --bundled-node|--update-node) deps_opts="$deps_opts $arg" ;; esac
done
# shellcheck disable=SC2086 # deps_opts is a few words or none
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
