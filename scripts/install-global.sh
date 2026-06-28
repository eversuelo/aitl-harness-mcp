#!/usr/bin/env bash
#
# install-global.sh — Build AITL-Harness-JS and install the `aitl` CLI globally.
#
# The package (aitl-mcp) exposes a single bin: `aitl` -> dist/src/cli.js.
# This script builds the project and runs `npm install -g .` so `aitl`
# is available on your PATH from anywhere.
#
# A global CLI has no project-local `.env`: dotenv loads `.env` relative to the
# current working dir, so `aitl` run from elsewhere falls back to zod defaults
# (localhost Mongo). The portable profile at ~/.aitl/config.json fixes this.
# Pass --seed-config to import the project's .env into that profile.
#
# Usage:
#   ./scripts/install-global.sh                # build + global install
#   ./scripts/install-global.sh --no-build     # skip build, install current dist
#   ./scripts/install-global.sh --seed-config  # also import .env -> ~/.aitl/config.json
#   ./scripts/install-global.sh --uninstall

set -euo pipefail

# Resolve project root from this script's location (scripts/..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_NAME="$(node -p "require('$ROOT_DIR/package.json').name" 2>/dev/null || echo aitl-mcp)"
BIN_NAME="aitl"

log()  { printf '\033[1;34m[install-global]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install-global]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install-global]\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites ----------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v npm  >/dev/null 2>&1 || die "npm not found on PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node >= 20 required (found $(node -v))"

# --- arg parsing ------------------------------------------------------------
DO_BUILD=1
DO_UNINSTALL=0
DO_SEED=0
for arg in "$@"; do
  case "$arg" in
    --no-build)    DO_BUILD=0 ;;
    --uninstall)   DO_UNINSTALL=1 ;;
    --seed-config) DO_SEED=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

cd "$ROOT_DIR"

# --- uninstall path ---------------------------------------------------------
if [ "$DO_UNINSTALL" -eq 1 ]; then
  log "Uninstalling $PKG_NAME globally..."
  npm uninstall -g "$PKG_NAME"
  log "Done. '$BIN_NAME' removed."
  exit 0
fi

# --- install dependencies (only if missing) ---------------------------------
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  log "node_modules missing — installing dependencies..."
  npm install
fi

# --- build ------------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  log "Building project (npm run build)..."
  npm run build
else
  log "Skipping build (--no-build)."
fi

[ -f "$ROOT_DIR/dist/src/cli.js" ] || die "dist/src/cli.js not found — run a build first"

# --- global install ---------------------------------------------------------
log "Installing $PKG_NAME globally (npm install -g .)..."
npm install -g .

# --- verify -----------------------------------------------------------------
if command -v "$BIN_NAME" >/dev/null 2>&1; then
  log "Success — '$BIN_NAME' is on your PATH at: $(command -v "$BIN_NAME")"
  "$BIN_NAME" --version 2>/dev/null || true
else
  GLOBAL_BIN="$(npm prefix -g)/bin"
  warn "'$BIN_NAME' installed but not on PATH."
  warn "Add this to your shell profile:  export PATH=\"$GLOBAL_BIN:\$PATH\""
fi

# --- seed the portable profile from .env (opt-in) ---------------------------
# Without this, a global `aitl` run outside this repo can't see `.env` and falls
# back to localhost Mongo. Importing .env into ~/.aitl/config.json fixes that.
if [ "$DO_SEED" -eq 1 ]; then
  [ -f "$ROOT_DIR/.env" ] || die "--seed-config: no .env found at $ROOT_DIR/.env"
  log "Seeding ~/.aitl/config.json from .env..."
  TMP_PROFILE="$(mktemp -t aitl-profile.XXXXXX.json)"
  trap 'rm -f "$TMP_PROFILE"' EXIT
  # Parse KEY=VALUE lines into JSON; aitl config import keeps only known keys.
  node -e '
    const fs = require("fs");
    const o = {};
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) o[m[1]] = m[2];
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(o, null, 2));
  ' "$ROOT_DIR/.env" "$TMP_PROFILE"
  "$BIN_NAME" config import "$TMP_PROFILE"
  log "Profile seeded. 'aitl' now works from any directory."
  log "Note: secrets are stored in plaintext at ~/.aitl/config.json; re-run --seed-config after editing .env."
fi
