#!/usr/bin/env bash
# splash-omp installer
# --------------------
# Makes omp ("Oh My Pi") self-sufficient for the local Splash model server:
# installs the auto-serve extension and (optionally) the model config.
#
#   ./scripts/install.sh             install everything (default)
#   ./scripts/install.sh --no-config install the extension only
#   ./scripts/install.sh --uninstall remove what this script installed
#
# Everything lands in omp's config dir ($OMP_AGENT_DIR, default ~/.omp/agent).
# Existing files are backed up (suffix .bak-<timestamp>) and never overwritten
# in place. The installer is idempotent: re-running it refreshes the extension
# and only adds provider blocks that are missing.
#
# What it does:
#   1. extensions/splash-m1.ts -> $AGENT_DIR/extensions/splash-m1.ts
#      (omp auto-loads every file in that directory at startup)
#   2. config/models.yml -> $AGENT_DIR/models.yml
#      missing  : copied as-is
#      present  : the splash provider blocks are appended if not already there
#   3. config/config.yml -> $AGENT_DIR/config.yml
#      missing  : copied as-is
#      present  : NOT touched (your model choices win); you are shown what the
#                 repo suggests so you can merge it by hand
#
# After installing, start omp normally. The extension probes the server,
# spawns `splash serve` if it is down, and gates the first prompt until the
# model is ready. Stop the server with:  pkill -f 'server\.server .*--port 8000'

set -euo pipefail

AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_NAME="splash-m1.ts"
TS="$(date +%Y%m%d-%H%M%S)"
WITH_CONFIG=1

case "${1:-}" in
  --no-config) WITH_CONFIG=0 ;;
  --uninstall) UNINSTALL=1 ;;
  "") ;;
  *) echo "usage: $0 [--no-config | --uninstall]" >&2; exit 2 ;;
esac

die() { echo "error: $*" >&2; exit 1; }

note() { echo "  $*"; }

backup() { # backup <path>  (no-op when the file does not exist)
  local p="$1"
  [ -e "$p" ] || return 0
  cp "$p" "$p.bak-$TS"
  note "backed up $(basename "$p") -> $(basename "$p").bak-$TS"
}

# Print one 2-space-indented provider block (name: ... up to the next
# same-level key) from a models.yml-shaped file.
provider_block() { # provider_block <file> <name>
  awk -v n="$2" '
    $0 ~ "^  " n ":[[:space:]]*$" { inblock = 1; print; next }
    inblock && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { inblock = 0 }
    inblock && /^[A-Za-z]/        { inblock = 0 }
    inblock                      { print }
  ' "$1"
}

uninstall() {
  mkdir -p "$AGENT_DIR"
  local ext="$AGENT_DIR/extensions/$EXT_NAME"
  if [ -f "$ext" ]; then
    backup "$ext"; rm "$ext"; note "removed extension: $ext"
  else
    note "extension not present: $ext"
  fi
  local f same
  for f in models.yml config.yml; do
    local dst="$AGENT_DIR/$f"
    if [ -f "$dst" ] && cmp -s "$dst" "$SRC_DIR/config/$f"; then
      backup "$dst"; rm "$dst"; note "removed $f (it matched the repo copy)"
    else
      note "leaving $f in place (differs from the repo copy)"
    fi
  done
  echo "done. Restore a backup with: cp <file>.bak-$TS <file>"
}

install_extension() {
  local ext="$AGENT_DIR/extensions/$EXT_NAME"
  mkdir -p "$AGENT_DIR/extensions"
  if [ -f "$ext" ] && cmp -s "$ext" "$SRC_DIR/extensions/$EXT_NAME"; then
    note "extension already current: $ext"
  else
    backup "$ext"
    cp "$SRC_DIR/extensions/$EXT_NAME" "$ext"
    note "installed extension -> $ext"
  fi
}

install_models() {
  local dst="$AGENT_DIR/models.yml" name block
  if [ ! -f "$dst" ]; then
    cp "$SRC_DIR/config/models.yml" "$dst"
    note "no models.yml — copied repo config -> $dst"
    return 0
  fi
  local added=0
  if awk '
    /^providers:[[:space:]]*$/ { inprov = 1; next }
    inprov && /^[A-Za-z]/  { bad = 1; exit }
    END { exit bad }
  ' "$dst"; then
    : # safe: 'providers:' is the last top-level key — append below
  else
    note "models.yml has a top-level key after 'providers:' — skipping the"
    note "auto-merge to avoid nesting providers under it. Copy the blocks from"
    note "config/models.yml by hand (your file was not modified)."
    return 0
  fi
  while IFS= read -r name; do
    name="${name#  }"; name="${name%:}"
    if grep -qE "^  ${name}:[[:space:]]*$" "$dst"; then
      continue
    fi
    backup "$dst"
    {
      echo ""
      provider_block "$SRC_DIR/config/models.yml" "$name"
    } >> "$dst"
    note "appended provider '$name' to $dst"
    added=1
  done < <(grep -E '^  [A-Za-z0-9_-]+:[[:space:]]*$' "$SRC_DIR/config/models.yml")
  [ "$added" = 1 ] || note "models.yml already has all splash providers — untouched"
}

install_config() {
  local dst="$AGENT_DIR/config.yml"
  if [ ! -f "$dst" ]; then
    cp "$SRC_DIR/config/config.yml" "$dst"
    note "no config.yml — copied repo config -> $dst"
    return 0
  fi
  backup "$dst"
  note "config.yml exists — NOT modified (your model choices win)."
  note "The repo's modelRoles, for comparison:"
  sed -n 's/^/    /; /modelRoles:/,$p' "$SRC_DIR/config/config.yml" | grep -E 'modelRoles|: splash' | sed 's/^/    /' || true
}

UNINSTALL="${UNINSTALL:-0}"
if [ "$UNINSTALL" = 1 ]; then
  uninstall
  exit 0
fi

echo "splash-omp install (agent dir: $AGENT_DIR)"
install_extension
if [ "$WITH_CONFIG" = 1 ]; then
  install_models
  install_config
fi
cat <<'EOF'

Next steps:
  1. Make sure `splash` is installed:  brew install incoai/tap/splash
  2. Start omp. The extension spawns the server if it is down; the first
     prompt waits (up to ~15 min) for the model to load.
  3. Check the server:  curl -s http://127.0.0.1:8000/ready
     Stop it with:      pkill -f 'server\.server .*--port 8000'
EOF
