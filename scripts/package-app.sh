#!/usr/bin/env bash
# package-app.sh
# -----------------
# Produces a zero-dependency, redistributable macOS artifact:
#
#   dist/Stremio Cast.app      -- self-contained .app bundle
#   dist/StremioCast-<ver>.dmg -- drag-to-/Applications installer
#
# The .app bundle embeds:
#   * a portable Node runtime (downloaded from nodejs.org, per arch)
#   * Next.js `standalone` build output (server.js + minimal node_modules)
#   * public/ and .next/static/ assets
#   * the launcher shell script (clone of scripts/stremio-cast.sh,
#     adapted to use the embedded Node)
#
# End user only needs a Mac running Stremio 5 beta — no git, no npm,
# no Node install. They drag the .app into /Applications from the DMG.
#
# Env overrides:
#   APP_VERSION  — version string baked into Info.plist + DMG filename
#   NODE_VERSION — portable Node runtime version (default below)
#   ARCH         — override detected arch: "arm64" or "x64"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${BRIDGE_DIR}/dist"
APP_NAME="Stremio Cast"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
APP_VERSION="${APP_VERSION:-0.1.0}"
NODE_VERSION="${NODE_VERSION:-v20.18.1}"

# Arch detection so the same script produces the right artifact on
# both Apple Silicon CI runners and x64 dev machines.
case "${ARCH:-$(uname -m)}" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64|x64)    NODE_ARCH="x64" ;;
  *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

log() { printf '\033[1;36m[package]\033[0m %s\n' "$*"; }

log "bridge dir      : ${BRIDGE_DIR}"
log "version         : ${APP_VERSION}"
log "node runtime    : ${NODE_VERSION} (${NODE_ARCH})"

# ---------------------------------------------------------------
# 1. Build the Next.js standalone bundle. `output: 'standalone'`
#    in next.config.ts makes Next emit .next/standalone/server.js
#    plus a pruned node_modules tree with ONLY the runtime deps.
#    This is what we actually ship — no devDeps, no sources.
# ---------------------------------------------------------------
cd "${BRIDGE_DIR}"
log "installing deps (npm install) …"
# `npm install` (not `npm ci`) so the build doesn't fail if the
# package-lock.json was regenerated in a PR. Output is left visible
# so CI logs explain any install failures directly.
npm install

log "running next build …"
npm run build

STANDALONE_DIR="${BRIDGE_DIR}/.next/standalone"
if [[ ! -f "${STANDALONE_DIR}/server.js" ]]; then
  echo "Next standalone build missing — check next.config.ts has output: 'standalone'" >&2
  exit 1
fi

# ---------------------------------------------------------------
# 2. Lay out the .app bundle. Structure follows the macOS "bundle
#    app" convention exactly so Finder, Dock, and spctl treat it
#    as a first-class application:
#
#      Stremio Cast.app/
#        Contents/
#          Info.plist
#          MacOS/stremio-cast      <- executable launcher shell script
#          Resources/
#            AppIcon.icns
#            bin/node              <- embedded Node runtime
#            bridge/                <- Next standalone output
#              server.js
#              .next/
#              public/
#              node_modules/
# ---------------------------------------------------------------
log "resetting ${APP_PATH}"
rm -rf "${APP_PATH}"
mkdir -p "${APP_PATH}/Contents/MacOS"
mkdir -p "${APP_PATH}/Contents/Resources/bin"
mkdir -p "${APP_PATH}/Contents/Resources/bridge"

# Copy the Next standalone output. `cp -R` preserves the pruned
# node_modules tree Next produced.
log "copying standalone server → Resources/bridge"
cp -R "${STANDALONE_DIR}/." "${APP_PATH}/Contents/Resources/bridge/"

# Next's standalone output *doesn't* include the public/ and
# .next/static directories — we have to copy those separately or
# the UI 404s on every asset request.
cp -R "${BRIDGE_DIR}/public"      "${APP_PATH}/Contents/Resources/bridge/public"
mkdir -p "${APP_PATH}/Contents/Resources/bridge/.next"
cp -R "${BRIDGE_DIR}/.next/static" "${APP_PATH}/Contents/Resources/bridge/.next/static"

# ---------------------------------------------------------------
# 3. Download portable Node runtime and strip it down to the single
#    `node` binary we actually need. Nodejs.org publishes signed
#    universal tarballs — no codesigning dance required for the
#    binary itself when we run it from inside a signed .app.
# ---------------------------------------------------------------
NODE_DIST="node-${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIST}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

log "downloading ${NODE_URL}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
curl -fsSL "${NODE_URL}" -o "${TMP_DIR}/${NODE_TARBALL}"
tar -xzf "${TMP_DIR}/${NODE_TARBALL}" -C "${TMP_DIR}"
cp "${TMP_DIR}/${NODE_DIST}/bin/node" "${APP_PATH}/Contents/Resources/bin/node"
chmod +x "${APP_PATH}/Contents/Resources/bin/node"

# ---------------------------------------------------------------
# 4. Write the launcher. This is the binary LaunchServices
#    executes when the user double-clicks the .app. It boots the
#    embedded Node + standalone server, waits for the port, then
#    launches Stremio 5 with --webui-url pointed at us.
#
#    All paths are computed relative to the script's own location
#    so the bundle is fully relocatable (works from /Applications,
#    ~/Downloads, /Volumes, wherever).
# ---------------------------------------------------------------
LAUNCHER="${APP_PATH}/Contents/MacOS/stremio-cast"
cat > "${LAUNCHER}" <<'LAUNCHER_EOF'
#!/bin/bash
# Stremio Cast.app launcher — fully self-contained.
# Boots an embedded Next.js server using the bundled Node runtime,
# then launches Stremio 5 with --webui-url pointing at it.
set -euo pipefail

# Resolve paths relative to this script so the bundle is relocatable.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ROOT="$(cd "${SELF_DIR}/.." && pwd)"
RES_DIR="${BUNDLE_ROOT}/Resources"
NODE_BIN="${RES_DIR}/bin/node"
BRIDGE_DIR="${RES_DIR}/bridge"
BRIDGE_PORT="${BRIDGE_PORT:-36971}"
LOG_FILE="${HOME}/Library/Logs/stremio-cast-bridge.log"
WEBUI_URL="http://127.0.0.1:${BRIDGE_PORT}/cast-bridge/"

mkdir -p "$(dirname "${LOG_FILE}")"
log() { printf '[stremio-cast %s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "${LOG_FILE}"; }

# ---- Stremio 5 bundle discovery (by CFBundleIdentifier) ----------
# Stremio has shipped v5 under two bundle IDs; we prefer whichever
# app already owns populated WebKit data so we never switch a user
# onto a blank profile. See scripts/stremio-cast.sh for full notes.
STREMIO_BUNDLE_IDS=(com.westbridge.stremio5-mac com.stremio.stremio-shell-macos)

bundle_id_of() {
  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
    "${1}/Contents/Info.plist" 2>/dev/null
}

webkit_data_size() {
  local id="$1"
  local dir="${HOME}/Library/WebKit/${id}/WebsiteData"
  [[ -d "${dir}" ]] || { printf '0\n'; return 0; }
  du -sk "${dir}" 2>/dev/null | awk '{print $1+0}'
}

find_stremio_bundle() {
  local candidates=() app id want c size best="" best_size=-1
  while IFS= read -r app; do
    id="$(bundle_id_of "${app}")"
    for want in "${STREMIO_BUNDLE_IDS[@]}"; do
      if [[ "${id}" == "${want}" ]]; then
        candidates+=("${app}|${id}")
        break
      fi
    done
  done < <(find /Applications -maxdepth 2 -name '*.app' -type d)
  [[ ${#candidates[@]} -eq 0 ]] && return 1

  if [[ -n "${STREMIO_BUNDLE_ID:-}" ]]; then
    for c in "${candidates[@]}"; do
      if [[ "${c##*|}" == "${STREMIO_BUNDLE_ID}" ]]; then
        printf '%s\n' "${c%%|*}"; return 0
      fi
    done
  fi

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

BUNDLE="$(find_stremio_bundle)" || {
  log "ERROR: Stremio 5 not found in /Applications (looked for com.westbridge.stremio5-mac or com.stremio.stremio-shell-macos)"
  osascript -e 'display alert "Stremio Cast" message "Stremio 5 (ARM beta) is not installed in /Applications. Download it from stremio.com and try again."' || true
  exit 1
}
BUNDLE_ID="$(bundle_id_of "${BUNDLE}")"
log "found Stremio: ${BUNDLE} (id: ${BUNDLE_ID})"

# ---- Boot embedded bridge if not already listening --------------
if ! nc -z 127.0.0.1 "${BRIDGE_PORT}" 2>/dev/null; then
  log "starting bridge on :${BRIDGE_PORT} via embedded Node"
  cd "${BRIDGE_DIR}"
  # Next standalone reads PORT/HOSTNAME env vars. Force loopback-only.
  HOSTNAME=127.0.0.1 PORT="${BRIDGE_PORT}" \
    nohup "${NODE_BIN}" "${BRIDGE_DIR}/server.js" >>"${LOG_FILE}" 2>&1 &
  disown || true
  wait_for_port "${BRIDGE_PORT}"
  log "bridge up"
else
  log "bridge already listening on :${BRIDGE_PORT}"
fi

# ---- Kill existing Stremio + its Node child (see stremio-cast.sh) -
# Match by the bundle's MacOS dir so both the Rust shell and the
# node server.js child are terminated before we relaunch.
pkill -f "${BUNDLE}/Contents/MacOS/" 2>/dev/null || true
sleep 1
for i in $(seq 1 20); do
  if ! nc -z 127.0.0.1 11470 2>/dev/null; then break; fi
  sleep 0.25
done

# ---- Surgical WKWebView cache wipe (preserves addons + login) ---
# Uses the actual bundle ID we discovered so both the old
# (westbridge) and new (stremio-shell-macos) builds are handled.
log "purging WKWebView HTTP + service-worker cache"
WEBKIT_CACHE="${HOME}/Library/Caches/${BUNDLE_ID}/WebKit"
WEBKIT_DATA="${HOME}/Library/WebKit/${BUNDLE_ID}/WebsiteData"
rm -rf "${WEBKIT_CACHE}/NetworkCache" "${WEBKIT_CACHE}/CacheStorage"
if [[ -d "${WEBKIT_DATA}/Default" ]]; then
  find "${WEBKIT_DATA}/Default" -type d \
    \( -name CacheStorage -o -name ServiceWorkers \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
fi

log "launching Stremio → ${WEBUI_URL}"
exec /usr/bin/open -n "${BUNDLE}" --args "--webui-url=${WEBUI_URL}"
LAUNCHER_EOF
chmod +x "${LAUNCHER}"

# ---------------------------------------------------------------
# 5. Info.plist — standard bundle metadata. LSUIElement=false so
#    the app shows up in the Dock when running; LSMinimumSystemVersion
#    follows Stremio 5's own floor.
# ---------------------------------------------------------------
cat > "${APP_PATH}/Contents/Info.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.stremio.cast-bridge</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundleExecutable</key><string>stremio-cast</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST_EOF

# ---------------------------------------------------------------
# 6. Icon. Reuse Stremio's own icon if Stremio is installed on the
#    build machine; otherwise fall back to a generic icon so the
#    bundle always has one (Finder shows the default app icon
#    instead of the plain executable icon).
# ---------------------------------------------------------------
ICON_SRC=""
for candidate in \
  "/Applications/Stremio.app/Contents/Resources/AppIcon.icns" \
  "/Applications/Stremio 2.app/Contents/Resources/AppIcon.icns" \
  "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns"; do
  if [[ -f "${candidate}" ]]; then ICON_SRC="${candidate}"; break; fi
done
if [[ -n "${ICON_SRC}" ]]; then
  cp "${ICON_SRC}" "${APP_PATH}/Contents/Resources/AppIcon.icns"
  log "icon: ${ICON_SRC}"
fi

# ---------------------------------------------------------------
# 7. Ad-hoc codesign. Not Developer ID notarized (that needs $99/yr
#    Apple account) — users get a Gatekeeper warning on first open
#    and right-click → Open. Good enough for v0.x distribution.
# ---------------------------------------------------------------
log "ad-hoc codesigning bundle"
codesign --force --deep --sign - "${APP_PATH}"

# ---------------------------------------------------------------
# 8. Build the DMG. hdiutil is built into macOS so no extra deps.
#    Layout: one folder containing the .app and a symlink to
#    /Applications so the user drags into it. Standard macOS UX.
# ---------------------------------------------------------------
DMG_STAGING="${TMP_DIR}/dmg-stage"
mkdir -p "${DMG_STAGING}"
cp -R "${APP_PATH}" "${DMG_STAGING}/"
ln -s /Applications "${DMG_STAGING}/Applications"

DMG_PATH="${DIST_DIR}/StremioCast-${APP_VERSION}-${NODE_ARCH}.dmg"
rm -f "${DMG_PATH}"
log "building ${DMG_PATH}"
hdiutil create \
  -volname "Stremio Cast ${APP_VERSION}" \
  -srcfolder "${DMG_STAGING}" \
  -ov -format ULFO \
  "${DMG_PATH}" >/dev/null

log "✓ .app at ${APP_PATH}"
log "✓ DMG  at ${DMG_PATH}"
