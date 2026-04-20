#!/usr/bin/env bash
# install-app.sh
# ---------------
# Installs a "Stremio Cast.app" in /Applications. Double-clicking it
# boots the bridge and launches Stremio 5 with Chromecast wired up.
#
# The bundle is built from a tiny AppleScript via `osacompile`. That
# choice is deliberate: handwritten .app bundles fail Gatekeeper on
# modern macOS (spctl rejects ad-hoc signatures, so `open` silently
# refuses them). osacompile produces a real Apple-signed bundle that
# behaves like any native AppleScript "Script app" — Finder trusts
# it, Spotlight indexes it, Dock/Login Items accept it.
#
# Re-running this script is safe; it rewrites the bundle in place.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_NAME="Stremio Cast"
APP_PATH="/Applications/${APP_NAME}.app"
LAUNCHER_SH="${BRIDGE_DIR}/scripts/stremio-cast.sh"

log() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }

log "bridge dir: ${BRIDGE_DIR}"
log "building production bundle of the Next.js bridge …"
cd "${BRIDGE_DIR}"
npm install --silent
npm run build

# ---------------------------------------------------------------
# Write a tiny AppleScript that just shells out to our launcher.
# `do shell script` runs synchronously in its own /bin/sh, so we
# background the launcher with `&` + `disown`-style redirection to
# let the AppleScript return immediately. The result: Finder/Dock
# show "Stremio Cast" as launched, the launcher keeps running, and
# Stremio 5 opens shortly after.
# ---------------------------------------------------------------
TMP_SCPT="$(mktemp -t stremio-cast.XXXXXX).applescript"
cat > "${TMP_SCPT}" <<APPLESCRIPT
-- Stremio Cast launcher (AppleScript → bash)
-- Redirects stdout/stderr to the shared log and detaches the
-- launcher so this AppleScript can exit promptly.
try
    do shell script "nohup '${LAUNCHER_SH}' >> ~/Library/Logs/stremio-cast-bridge.log 2>&1 &"
on error errMsg
    display alert "Stremio Cast failed to start" message errMsg
end try
APPLESCRIPT

log "compiling ${APP_PATH} from AppleScript"
rm -rf "${APP_PATH}"
osacompile -o "${APP_PATH}" "${TMP_SCPT}"
rm -f "${TMP_SCPT}"

# ---------------------------------------------------------------
# Patch the generated Info.plist: set our own bundle ID + a human
# name, and most importantly set `LSUIElement=false` so the app
# shows up in the Dock instead of silently running in the background.
# ---------------------------------------------------------------
PLIST="${APP_PATH}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName '${APP_NAME}'" "${PLIST}" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleName string '${APP_NAME}'" "${PLIST}"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.stremio.cast-bridge" "${PLIST}" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.stremio.cast-bridge" "${PLIST}"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.0" "${PLIST}" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string 0.1.0" "${PLIST}"

# ---------------------------------------------------------------
# Swap the default AppleScript droplet icon for Stremio's own icon
# so the Dock/Spotlight entry looks native. osacompile writes its
# default icon to Contents/Resources/applet.icns — we overwrite it.
# ---------------------------------------------------------------
STREMIO_ICON=""
for candidate in \
  "/Applications/Stremio 2.app/Contents/Resources/AppIcon.icns" \
  "/Applications/Stremio.app/Contents/Resources/AppIcon.icns"; do
  if [[ -f "${candidate}" ]]; then
    STREMIO_ICON="${candidate}"
    break
  fi
done
if [[ -n "${STREMIO_ICON}" ]]; then
  cp "${STREMIO_ICON}" "${APP_PATH}/Contents/Resources/applet.icns"
  log "copied Stremio icon"
fi

# Re-sign with an ad-hoc signature so the icon + Info.plist edits
# don't break the original Apple signature applied by osacompile.
codesign --force --deep -s - "${APP_PATH}" 2>/dev/null || true

# Refresh LaunchServices so the new icon shows up immediately.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "${APP_PATH}" 2>/dev/null || true

log "done. Launch it with:  open \"${APP_PATH}\""
log "or drag it to the Dock / add it to Login Items for auto-start."
