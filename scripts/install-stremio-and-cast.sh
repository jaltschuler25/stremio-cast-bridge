#!/usr/bin/env bash
# install-stremio-and-cast.sh
# --------------------------------
# One-shot setup for macOS:
#   1) Download Stremio 5 beta from Stremio's CDN (same builds as stremio.com/downloads).
#   2) Copy Stremio.app into /Applications.
#   3) npm install + build + install Stremio Cast.app (cast bridge).
#
# Requirements: macOS, Node.js 20+ (install from https://nodejs.org or `brew install node`).
#
# Optional env:
#   STREMIO_VERSION   e.g. v5.1.19 (default below — bump when Stremio ships a newer beta)
#   SKIP_STREMIO=1    only install / refresh the cast bridge (skip DMG download)
#   STREMIO_DMG_URL   full URL override (skips version/arch URL building)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Keep in sync with current beta on https://www.stremio.com/downloads (macOS current beta).
DEFAULT_STREMIO_VERSION="v5.1.19"

STREMIO_VERSION="${STREMIO_VERSION:-$DEFAULT_STREMIO_VERSION}"

log() { printf '\033[1;36m[stremio+cast]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[stremio+cast]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[stremio+cast]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This script is for macOS only."
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  arm64)  DMG_NAME="Stremio_arm64.dmg" ;;
  x86_64) DMG_NAME="Stremio_x64.dmg" ;;
  *) die "Unsupported architecture: ${ARCH} (need arm64 or x86_64)" ;;
esac

if [[ -n "${STREMIO_DMG_URL:-}" ]]; then
  DMG_URL="${STREMIO_DMG_URL}"
else
  DMG_URL="https://dl.strem.io/stremio-shell-macos/${STREMIO_VERSION}/${DMG_NAME}"
fi

need_node() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.volta/bin/node"; do
    if [[ -x "${c}" ]]; then return 0; fi
  done
  return 1
}

install_stremio_beta() {
  log "Downloading Stremio 5 beta (${STREMIO_VERSION}, ${ARCH})…"
  log "URL: ${DMG_URL}"

  local tmpdmg head_code
  tmpdmg="$(mktemp -t stremio-beta.XXXXXX).dmg"
  if ! curl -fL --progress-bar -o "${tmpdmg}" "${DMG_URL}"; then
    rm -f "${tmpdmg}"
    die "Download failed (curl -f). Check STREMIO_VERSION or set STREMIO_DMG_URL to a valid DMG from Stremio."
  fi

  MNT="$(mktemp -d /tmp/stremio-dmg.XXXXXX)"
  cleanup() {
    hdiutil detach "${MNT}" -quiet 2>/dev/null || true
    rm -f "${tmpdmg}"
  }
  trap cleanup EXIT

  hdiutil attach -nobrowse -mountpoint "${MNT}" "${tmpdmg}"

  if [[ ! -d "${MNT}/Stremio.app" ]]; then
    die "DMG did not contain Stremio.app (unexpected layout). Open the DMG manually and report to the maintainer."
  fi

  log "Installing Stremio.app → /Applications …"
  rm -rf "/Applications/Stremio.app"
  ditto "${MNT}/Stremio.app" "/Applications/Stremio.app"

  hdiutil detach "${MNT}" -quiet
  trap - EXIT
  rm -f "${tmpdmg}"
  log "Stremio 5 beta installed to /Applications/Stremio.app"
}

install_cast_bridge() {
  log "Installing Stremio Cast bridge (Next.js + Stremio Cast.app)…"
  cd "${BRIDGE_DIR}"
  if ! need_node; then
    die "Node.js not found. Install Node 20+ from https://nodejs.org or: brew install node"
  fi
  # Use PATH that includes Homebrew for non-interactive GUI later
  export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
  command -v node && node -v
  npm install
  npm run build
  bash "${BRIDGE_DIR}/scripts/install-app.sh"
  log "Cast bridge installed. Use: open -a \"Stremio Cast\" (or from /Applications)."
}

main() {
  log "Bridge source: ${BRIDGE_DIR}"
  if [[ "${SKIP_STREMIO:-0}" == "1" ]]; then
    warn "SKIP_STREMIO=1 — skipping Stremio DMG; only installing cast bridge."
  else
    install_stremio_beta
  fi
  install_cast_bridge
  log "Done."
  log "Next: launch Stremio 5 with casting via **Stremio Cast** in /Applications (not the plain Stremio icon alone)."
}

main "$@"
