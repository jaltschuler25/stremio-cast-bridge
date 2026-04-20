#!/usr/bin/env bash
# uninstall-app.sh — removes the "Stremio Cast.app" bundle and any
# running bridge processes. Does NOT touch the stremio-cast-bridge
# source tree, so re-installing is a single `install-app.sh` away.
set -euo pipefail

APP_PATH="/Applications/Stremio Cast.app"
BRIDGE_PORT="${BRIDGE_PORT:-36971}"

log() { printf '\033[1;36m[uninstall]\033[0m %s\n' "$*"; }

log "stopping bridge on :${BRIDGE_PORT} (if running)"
PIDS="$(lsof -ti tcp:${BRIDGE_PORT} 2>/dev/null || true)"
[[ -n "${PIDS}" ]] && kill ${PIDS} 2>/dev/null || true

log "removing ${APP_PATH}"
rm -rf "${APP_PATH}"

log "done."
