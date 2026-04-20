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

# Discover the v5 bundle by identifier so the script keeps working
# even if the user renamed the .app directory.
find_stremio_bundle() {
  local app
  while IFS= read -r app; do
    if /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
        "${app}/Contents/Info.plist" 2>/dev/null \
        | grep -q '^com.westbridge.stremio5-mac$'; then
      printf '%s\n' "${app}"
      return 0
    fi
  done < <(find /Applications -maxdepth 2 -name '*.app' -type d)
  return 1
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
  echo "Stremio 5 not found in /Applications. Install com.westbridge.stremio5-mac first." >&2
  exit 1
}

# Boot the bridge if it isn't already running.
if ! nc -z 127.0.0.1 "${BRIDGE_PORT}" 2>/dev/null; then
  echo "Starting cast bridge on :${BRIDGE_PORT}…"
  BRIDGE_PORT="${BRIDGE_PORT}" npm run dev -- -p "${BRIDGE_PORT}" \
    >/tmp/stremio-cast-bridge.log 2>&1 &
  echo "bridge pid=$!, logs: /tmp/stremio-cast-bridge.log"
  wait_for_port "${BRIDGE_PORT}"
fi

# Kill any existing Stremio 5 window so --webui-url isn't swallowed
# by LaunchServices' "already running" dance. Also kill the Node
# server.js subprocess — if we leave it orphaned it keeps port
# 11470 and the freshly-spawned server can't bind, which makes
# the casting device chooser spin forever on "searching…".
pkill -f "Stremio 2.app/Contents/MacOS/Stremio" 2>/dev/null || true
pkill -f "Stremio 2.app/Contents/MacOS/node" 2>/dev/null || true
sleep 1
for i in $(seq 1 20); do
  if ! nc -z 127.0.0.1 11470 2>/dev/null; then break; fi
  sleep 0.25
done

# Purge HTTP + service-worker cache only — we explicitly leave
# LocalStorage + IndexedDB alone so installed addons, library and
# login survive across launches.
echo "Wiping WKWebView HTTP + service-worker cache (addons / login preserved)…"
WEBKIT_CACHE="${HOME}/Library/Caches/com.westbridge.stremio5-mac/WebKit"
WEBKIT_DATA="${HOME}/Library/WebKit/com.westbridge.stremio5-mac/WebsiteData"
rm -rf "${WEBKIT_CACHE}/NetworkCache" "${WEBKIT_CACHE}/CacheStorage"
if [[ -d "${WEBKIT_DATA}/Default" ]]; then
  find "${WEBKIT_DATA}/Default" -type d \
    \( -name CacheStorage -o -name ServiceWorkers \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
fi

echo "Launching Stremio 5 → ${WEBUI_URL}"
exec /usr/bin/open -n "${BUNDLE}" --args "--webui-url=${WEBUI_URL}"
