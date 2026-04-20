#!/usr/bin/env bash
# bootstrap.sh
# --------------------------------
# One-liner entry point invoked via:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/jaltschuler25/stremio-cast-bridge/main/scripts/bootstrap.sh)"
#
# Steps:
#   1) Clone (or update) the stremio-cast-bridge repo to ~/stremio-cast-bridge.
#   2) Delegate to scripts/install-stremio-and-cast.sh which downloads the
#      Stremio 5 beta DMG, installs Stremio.app, then builds Stremio Cast.app.
#
# Requires: macOS, git, Node.js 20+.

set -euo pipefail

REPO_URL="${STREMIO_CAST_REPO_URL:-https://github.com/jaltschuler25/stremio-cast-bridge.git}"
BRANCH="${STREMIO_CAST_BRANCH:-main}"
TARGET_DIR="${STREMIO_CAST_DIR:-${HOME}/stremio-cast-bridge}"

log()  { printf "\033[1;36m[cast-bridge]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[cast-bridge]\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m[cast-bridge]\033[0m %s\n" "$*" >&2; exit 1; }

# Platform + toolchain preflight so we fail fast with an actionable message
# instead of blowing up deep inside npm / bash on non-mac systems.
[[ "$(uname -s)" == "Darwin" ]] || die "This installer only supports macOS."
command -v git  >/dev/null 2>&1 || die "git is required. Install Xcode CLT: xcode-select --install"
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required. Install from https://nodejs.org or: brew install node"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  die "Node.js 20+ is required (found v$(node -v)). Upgrade via nvm or: brew upgrade node"
fi

# Clone on first run, fast-forward on subsequent runs so re-paste upgrades in place.
if [[ -d "${TARGET_DIR}/.git" ]]; then
  log "Updating existing clone at ${TARGET_DIR}"
  git -C "${TARGET_DIR}" fetch origin "${BRANCH}"
  git -C "${TARGET_DIR}" checkout "${BRANCH}"
  git -C "${TARGET_DIR}" pull --ff-only origin "${BRANCH}"
else
  log "Cloning ${REPO_URL} to ${TARGET_DIR}"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${TARGET_DIR}"
fi

# Hand off to the repo-local installer which handles DMG + bridge build.
log "Running install-stremio-and-cast.sh"
bash "${TARGET_DIR}/scripts/install-stremio-and-cast.sh"

log "Done. Launch via /Applications/Stremio Cast.app"
