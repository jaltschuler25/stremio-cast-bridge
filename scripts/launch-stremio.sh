#!/usr/bin/env bash
# launch-stremio.sh
# ------------------
# CLI equivalent of the control-panel Launch button. Does the same
# three things: (1) waits for the Next.js bridge to be up, (2) wipes
# the WKWebView HTTP + ServiceWorker caches so Stremio picks up our
# shimmed HTML on relaunch, (3) launches Stremio 5 with
# --webui-url pointing at our shim.
#
# Usage:
#   ./scripts/launch-stremio.sh
#   BRIDGE_PORT=4000 ./scripts/launch-stremio.sh   # non-default port

set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-36970}"
WEBUI_URL="http://127.0.0.1:${BRIDGE_PORT}/cast-bridge/"

# Discover the v5 bundle by identifier. Accept either bundle ID
# Stremio has shipped during the v5 beta, and among multiple matches
# prefer the one whose WebKit data dir is biggest (= the app the
# user actually has addons/login in). Override with STREMIO_BUNDLE_ID.
STREMIO_BUNDLE_IDS=(com.westbridge.stremio5-mac com.stremio.stremio-shell-macos)

bundle_id_of() {
  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
    "${1}/Contents/Info.plist" 2>/dev/null
}
webkit_data_size() {
  local id="$1" dir="${HOME}/Library/WebKit/${1}/WebsiteData"
  [[ -d "${dir}" ]] || { printf '0\n'; return 0; }
  du -sk "${dir}" 2>/dev/null | awk '{print $1+0}'
}
find_stremio_bundle() {
  local candidates=() app id want c size best="" best_size=-1
  while IFS= read -r app; do
    id="$(bundle_id_of "${app}")"
    for want in "${STREMIO_BUNDLE_IDS[@]}"; do
      [[ "${id}" == "${want}" ]] && { candidates+=("${app}|${id}"); break; }
    done
  done < <(find /Applications -maxdepth 2 -name '*.app' -type d)
  [[ ${#candidates[@]} -eq 0 ]] && return 1

  if [[ -n "${STREMIO_BUNDLE_ID:-}" ]]; then
    for c in "${candidates[@]}"; do
      [[ "${c##*|}" == "${STREMIO_BUNDLE_ID}" ]] && { printf '%s\n' "${c%%|*}"; return 0; }
    done
  fi
  for c in "${candidates[@]}"; do
    size="$(webkit_data_size "${c##*|}")"
    (( size > best_size )) && { best_size="${size}"; best="${c%%|*}"; }
  done
  printf '%s\n' "${best}"
}

wait_for_port() {
  local port="$1" tries=60
  while ! nc -z 127.0.0.1 "${port}" 2>/dev/null; do
    ((tries--)) || { echo "Timed out waiting for port ${port}" >&2; return 1; }
    sleep 0.5
  done
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

BUNDLE="$(find_stremio_bundle)" || {
  echo "Stremio 5 not found in /Applications. Install the Stremio 5 beta (com.westbridge.stremio5-mac or com.stremio.stremio-shell-macos) first." >&2
  exit 1
}
BUNDLE_ID="$(bundle_id_of "${BUNDLE}")"

# Boot the bridge if it isn't already running.
if ! nc -z 127.0.0.1 "${BRIDGE_PORT}" 2>/dev/null; then
  echo "Starting cast bridge on :${BRIDGE_PORT}…"
  BRIDGE_PORT="${BRIDGE_PORT}" npm run dev -- -p "${BRIDGE_PORT}" \
    >/tmp/stremio-cast-bridge.log 2>&1 &
  echo "bridge pid=$!, logs: /tmp/stremio-cast-bridge.log"
  wait_for_port "${BRIDGE_PORT}"
fi

# Kill any existing Stremio 5 process so --webui-url isn't swallowed
# by LaunchServices' "already running" dance. Target the actual
# bundle's MacOS dir so the pattern matches BOTH the Rust shell and
# the node server.js child — if we leave the child orphaned it
# keeps port 11470 and the freshly-spawned server can't bind, which
# makes the casting device chooser spin forever on "searching…".
pkill -f "${BUNDLE}/Contents/MacOS/" 2>/dev/null || true
sleep 1
for i in $(seq 1 20); do
  if ! nc -z 127.0.0.1 11470 2>/dev/null; then break; fi
  sleep 0.25
done

# Purge HTTP + service-worker cache only — we explicitly leave
# LocalStorage + IndexedDB alone so installed addons, library and
# login survive across launches. Scoped by the actual bundle ID so
# we wipe the right WebKit namespace for this Stremio variant.
echo "Wiping WKWebView HTTP + service-worker cache (addons / login preserved)…"
WEBKIT_CACHE="${HOME}/Library/Caches/${BUNDLE_ID}/WebKit"
WEBKIT_DATA="${HOME}/Library/WebKit/${BUNDLE_ID}/WebsiteData"
rm -rf "${WEBKIT_CACHE}/NetworkCache" "${WEBKIT_CACHE}/CacheStorage"
if [[ -d "${WEBKIT_DATA}/Default" ]]; then
  find "${WEBKIT_DATA}/Default" -type d \
    \( -name CacheStorage -o -name ServiceWorkers \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
fi

echo "Launching Stremio 5 → ${WEBUI_URL}"
exec /usr/bin/open -n "${BUNDLE}" --args "--webui-url=${WEBUI_URL}"
