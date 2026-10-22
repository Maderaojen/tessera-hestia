# shellcheck shell=sh
# The shell scripts' text:
# what bin/hestia and scripts/install.sh print is in
# locales/{zh-TW,en-US}/<area>.json beside this file, under a key, in the
# language the hestia command uses: HESTIA_LOCALE, else LC_ALL,
# LC_MESSAGES, LANG (C and POSIX name none), else Traditional Chinese —
# as localeFromEnv in src/i18n/index.ts. A shell can't import the
# translator, so this reads the JSON itself; scripts/check-i18n.mjs keeps
# the files one key to a line, in both languages, and the scripts free of
# text of their own.
#
# Sourced (POSIX sh, so bin/hestia can use it too) after setting
# HESTIA_I18N_DIR to this folder:
#
#   msg KEY [NAME VALUE]...   the text, {NAME} replaced by VALUE; no newline
#
# A key missing in the language's files prints the key itself.

# hestia_locale — zh-TW or en-US, from the environment.
hestia_locale() {
  for _hestia_value in "${HESTIA_LOCALE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    case "$_hestia_value" in
      '' | C | POSIX | C.*) continue ;;
      [Ee][Nn] | [Ee][Nn][-_.@]*) echo en-US ;;
      *) echo zh-TW ;;
    esac
    return 0
  done
  echo zh-TW
}

HESTIA_MSG_LOCALE="$(hestia_locale)"

# Finds "KEY": "…" (one key to a line), undoes the JSON escapes, then puts
# each {NAME} given in the environment (HESTIA_MSG_NAME) in its place —
# by index, not gsub, so a value's & and \ stay as they are.
_HESTIA_MSG_AWK='
BEGIN { prefix = "  \"" key "\": \"" }
index($0, prefix) == 1 {
  raw = substr($0, length(prefix) + 1)
  sub(/,$/, "", raw)
  sub(/"$/, "", raw)
  text = ""
  while ((i = index(raw, "\\")) > 0) {
    c = substr(raw, i + 1, 1)
    text = text substr(raw, 1, i - 1) (c == "n" ? "\n" : c == "t" ? "\t" : c)
    raw = substr(raw, i + 2)
  }
  text = text raw
  found = 1
  exit
}
END {
  if (!found) { printf "%s", key; exit }
  out = ""
  while ((p = index(text, "{")) > 0) {
    rest = substr(text, p + 1)
    q = index(rest, "}")
    name = q > 0 ? substr(rest, 1, q - 1) : ""
    if (name ~ /^[A-Za-z0-9_]+$/ && ("HESTIA_MSG_" name) in ENVIRON) {
      out = out substr(text, 1, p - 1) ENVIRON["HESTIA_MSG_" name]
      text = substr(rest, q + 1)
    } else {
      out = out substr(text, 1, p)
      text = rest
    }
  }
  printf "%s", out text
}'

msg() {
  (
    _hestia_key="$1"
    shift
    while [ $# -ge 2 ]; do
      export "HESTIA_MSG_$1=$2"
      shift 2
    done
    awk -v key="$_hestia_key" "$_HESTIA_MSG_AWK" "${HESTIA_I18N_DIR:-.}/locales/$HESTIA_MSG_LOCALE"/*.json 2>/dev/null \
      || printf '%s' "$_hestia_key"
  )
}
