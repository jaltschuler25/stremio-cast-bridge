#!/usr/bin/env bash
# stremio-cast.sh
# -----------------
# One-shot launcher used by the "Stremio Cast.app" bundle. Does
# everything end-to-end so a double-click on the app icon gives the
# user a fully-patched Stremio 5 window with Chromecast working:
#
#   1. Locate node (Finder-launched apps don't inherit a shell PATH).
#   2. Boot the Next.js cast bridge in production mode, detached,
#      if it isn't already listening on BRIDGE_PORT.
#   3. Wait for the bridge to be reachable.
#   4. Kill any already-running Stremio 5 instance (otherwise macOS
#      LaunchServices just reactivates it and swallows --webui-url).
#   5. Purge the WKWebView HTTP + service-worker caches so Stremio
#      picks up the shimmed HTML instead of its cached copy.
#   6. Launch Stremio 5 with --webui-url pointing at the bridge.
#
# Env overrides:
#   BRIDGE_PORT   bridge port (default: 36971)
#   BRIDGE_DIR    absolute path to stremio-cast-bridge (auto-detected)

set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-36971}"
LOG_FILE="${HOME}/Library/Logs/stremio-cast-bridge.log"
WEBUI_URL="http://127.0.0.1:${BRIDGE_PORT}/cast-bridge/"

# ---------------------------------------------------------------
# Resolve the bridge directory. When invoked from inside a .app
# bundle, BRIDGE_DIR is exported by the wrapper Info.plist caller;
# from CLI we fall back to the script's grandparent.
# ---------------------------------------------------------------
BRIDGE_DIR="${BRIDGE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "${BRIDGE_DIR}"

log() { printf '[stremio-cast %s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "${LOG_FILE}"; }

mkdir -p "$(dirname "${LOG_FILE}")"

# ---------------------------------------------------------------
# Find a usable node binary. GUI launches have a minimal PATH so
# we probe the common install locations ourselves.
# ---------------------------------------------------------------
resolve_node() {
  local candidates=(
    "$(command -v node 2>/dev/null || true)"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "${HOME}/.volta/bin/node"
    "${HOME}/.nvm/versions/node/*/bin/node"
  )
  for c in "${candidates[@]}"; do
    # glob-expand (handles the nvm entry above)
    for resolved in ${c}; do
      if [[ -x "${resolved}" ]]; then
        printf '%s\n' "${resolved}"
        return 0
      fi
    done
  done
  return 1
}

# ---------------------------------------------------------------
# Stremio 5 bundle discovery.
#
# Stremio shipped v5 under two different CFBundleIdentifiers over
# the course of the beta:
#   * com.westbridge.stremio5-mac        (early beta, v5.1.x)
#   * com.stremio.stremio-shell-macos    (current/newer beta; DMG
#     URL now lives under /stremio-shell-macos/ too)
# We accept either — but selection order matters. `find` returns
# apps in inode/creation order, so naïvely "first match wins" can
# pick a freshly-installed blank Stremio over the user's real
# profile. Instead we:
#   1. Collect ALL matching bundles.
#   2. Prefer the one that already has ~/Library/WebKit/<bundleId>/
#      WebsiteData with real content (= the Stremio the user has
#      actually used, including their installed addons, library,
#      and login).
#   3. Allow explicit override via STREMIO_BUNDLE_ID env var.
# This keeps existing users on their existing data even after a new
# Stremio build lands in /Applications under a new bundle ID.
# ---------------------------------------------------------------
STREMIO_BUNDLE_IDS=(com.westbridge.stremio5-mac com.stremio.stremio-shell-macos)

bundle_id_of() {
  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
    "${1}/Contents/Info.plist" 2>/dev/null
}

# Returns the number of bytes of stored web data for a given bundle
# ID. 0 if nothing has been stored (fresh install).
webkit_data_size() {
  local id="$1"
  local dir="${HOME}/Library/WebKit/${id}/WebsiteData"
  [[ -d "${dir}" ]] || { printf '0\n'; return 0; }
  du -sk "${dir}" 2>/dev/null | awk '{print $1+0}'
}

find_stremio_bundle() {
  # Collect all matching /Applications/*.app bundles.
  local candidates=()
  local app id
  while IFS= read -r app; do
    id="$(bundle_id_of "${app}")"
    for want in "${STREMIO_BUNDLE_IDS[@]}"; do
      if [[ "${id}" == "${want}" ]]; then
        candidates+=("${app}|${id}")
        break
      fi
    done
  done < <(find /Applications -maxdepth 2 -name '*.app' -type d)

  if [[ ${#candidates[@]} -eq 0 ]]; then
    return 1
  fi

  # Explicit override: user-pinned bundle ID (advanced escape hatch).
  if [[ -n "${STREMIO_BUNDLE_ID:-}" ]]; then
    for c in "${candidates[@]}"; do
      if [[ "${c##*|}" == "${STREMIO_BUNDLE_ID}" ]]; then
        printf '%s\n' "${c%%|*}"; return 0
      fi
    done
  fi

  # Prefer the bundle whose WebsiteData directory has the most data.
  # That's almost always the Stremio the user has actually logged
  # into and populated with addons. Freshly-installed apps have 0
  # or near-0 bytes here.
  local best="" best_size=-1 size
  for c in "${candidates[@]}"; do
    size="$(webkit_data_size "${c##*|}")"
    if (( size > best_size )); then
      best_size="${size}"
      best="${c%%|*}"
    fi
  done
  printf '%s\n' "${best}"
}

wait_for_port() {
  local port="$1" tries=80
  while ! nc -z 127.0.0.1 "${port}" 2>/dev/null; do
    ((tries--)) || { log "Timed out waiting for port ${port}"; return 1; }
    sleep 0.25
  done
}

# ---------------------------------------------------------------
# Boot the bridge in production mode if it isn't already running.
# We use `nohup` + `setsid`-style backgrounding so the process
# survives the launching shell exiting.
# ---------------------------------------------------------------
start_bridge() {
  if nc -z 127.0.0.1 "${BRIDGE_PORT}" 2>/dev/null; then
    log "bridge already listening on :${BRIDGE_PORT}"
    return 0
  fi

  local NODE_BIN
  NODE_BIN="$(resolve_node)" || {
    log "ERROR: could not find a node binary. Install Node 18+."
    osascript -e 'display alert "Stremio Cast" message "Node.js is not installed. Install Node 18+ (https://nodejs.org) and try again."' || true
    exit 1
  }
  log "using node: ${NODE_BIN}"

  # Build once on first launch. `.next/BUILD_ID` is the canonical
  # signal that a production build exists.
  if [[ ! -f "${BRIDGE_DIR}/.next/BUILD_ID" ]]; then
    log "first-run production build (this takes ~30s) …"
    PATH="$(dirname "${NODE_BIN}"):${PATH}" npm run build >>"${LOG_FILE}" 2>&1 || {
      log "build failed — see ${LOG_FILE}"
      osascript -e 'display alert "Stremio Cast" message "Failed to build the bridge. See ~/Library/Logs/stremio-cast-bridge.log"' || true
      exit 1
    }
  fi

  log "starting bridge on :${BRIDGE_PORT} (prod) …"
  PATH="$(dirname "${NODE_BIN}"):${PATH}" \
    nohup npm run start -- -p "${BRIDGE_PORT}" >>"${LOG_FILE}" 2>&1 &
  disown || true
  wait_for_port "${BRIDGE_PORT}"
  log "bridge is up"
}

# ---------------------------------------------------------------
# Main
# ---------------------------------------------------------------
BUNDLE="$(find_stremio_bundle)" || {
  log "ERROR: Stremio 5 bundle not found in /Applications (looked for com.westbridge.stremio5-mac or com.stremio.stremio-shell-macos)"
  osascript -e 'display alert "Stremio Cast" message "Stremio 5 (ARM beta) is not installed in /Applications. Download it from stremio.com."' || true
  exit 1
}
BUNDLE_ID="$(bundle_id_of "${BUNDLE}")"
log "found Stremio bundle at ${BUNDLE} (id: ${BUNDLE_ID})"

start_bridge

# ---------------------------------------------------------------
# Clean launch dance: kill the Stremio shell **and its Node.js
# server.js subprocess** before relaunching. The server is spawned
# as a child of the Rust shell, but when we pkill only the shell,
# the Node child gets re-parented to launchd and keeps holding
# port 11470 — so the newly-spawned Stremio's fresh server.js
# fails to bind, and casting silently shows "searching…" forever
# because nothing is answering /casting/ requests.
# ---------------------------------------------------------------
# Match the bundle's MacOS dir so we hit BOTH the Rust shell binary
# AND the node server.js child (whose cmdline includes this path).
pkill -f "${BUNDLE}/Contents/MacOS/" 2>/dev/null || true
sleep 1
# Wait for port 11470 to actually free up — otherwise the fresh
# server.js races against the one still shutting down.
for i in $(seq 1 20); do
  if ! nc -z 127.0.0.1 11470 2>/dev/null; then break; fi
  sleep 0.25
done

# Surgical cache wipe — we remove ONLY the HTTP cache, Cache-API
# storage, and registered Service Workers so the shim reloads fresh.
# Explicitly preserve LocalStorage + IndexedDB (under WebsiteData/
# and WebsiteData/Default/*/*/LocalStorage) because Stremio stores
# your installed addons, library, and settings there — nuking
# them would effectively factory-reset Stremio on every launch.
log "purging WKWebView HTTP + service-worker cache (preserving addons / login)"
WEBKIT_CACHE="${HOME}/Library/Caches/${BUNDLE_ID}/WebKit"
WEBKIT_DATA="${HOME}/Library/WebKit/${BUNDLE_ID}/WebsiteData"
rm -rf "${WEBKIT_CACHE}/NetworkCache" "${WEBKIT_CACHE}/CacheStorage"
# Per-origin caches under Default/<salt>/<salt>/ — glob-safe wipe.
if [[ -d "${WEBKIT_DATA}/Default" ]]; then
  find "${WEBKIT_DATA}/Default" -type d \
    \( -name CacheStorage -o -name ServiceWorkers \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
fi

log "launching Stremio → ${WEBUI_URL}"
exec /usr/bin/open -n "${BUNDLE}" --args "--webui-url=${WEBUI_URL}"
