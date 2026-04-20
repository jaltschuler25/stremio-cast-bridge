# Stremio 5 Cast Bridge

Re-enables the greyed-out Chromecast button in the **Stremio 5 macOS (ARM) beta** for a single user on a single home network.

## Why this exists

Stremio 5 ships a new Rust-based shell that hosts the web UI inside WKWebView. The web UI's cast logic ([`ChromecastTransport`](https://github.com/Stremio/stremio-web/blob/development/src/services/Chromecast/ChromecastTransport.js)) depends on Google's Cast Web Sender SDK, which is Chromium-only — it silently no-ops inside WKWebView. In the v4 shell (Qt/Chromium) the SDK worked, so the button lit up. In v5 it stays disabled forever, and [the Stremio team has left the feature unimplemented](https://github.com/Stremio/stremio-bugs/issues/1316).

The interesting part: Stremio 5's **bundled streaming server still ships the full server-side Chromecast client** (MDNS discovery, CastV2 protocol, transcoding). You can confirm it yourself:

```bash
curl http://localhost:11470/casting/
# -> [{"facility":"MDNS","name":"Family Room TV","type":"chromecast","host":"192.168.1.159",...}]
```

So all we need is a skinny UI-side shim that:

1. **Fakes the Google Cast SDK** so the web UI thinks casting is available (`cast.framework.CastContext`, enums, `requestSession()`, …).
2. **Intercepts `requestSession()`** to show a device picker populated from the server's `/casting/` endpoint.
3. **Routes playback commands** (play / pause / seek / volume / stop) to `http://localhost:11470/casting/<devID>/player` — the HTTP API that `ChromecastClient` already exposes.
4. Keeps the native Stremio 5 player UI in sync by mirroring the local `<video>` element's state to the TV.

We deliver the shim by running a tiny Next.js server that proxies `web.stremio.com` and injects `cast-shim.js` into the HTML, then launching Stremio 5 with `--webui-url=http://127.0.0.1:<port>/cast-bridge/` (dev default port **36970**, production **36971** — see `package.json`).

Nothing inside the `Stremio.app` bundle is modified.

## For Stremio maintainers

**Goal for upstream:** fix the **greyed-out / unusable Chromecast cast button** in the Stremio 5 desktop shell (`WKWebView` / similar) by routing cast actions through the **bundled streaming server** when the Google Cast Sender SDK never initialises. Same root cause as [stremio-bugs#1316](https://github.com/Stremio/stremio-bugs/issues/1316).

This repository is an **unofficial** reference implementation (not affiliated with Stremio). It proves the cast button can work because the server already exposes [`/casting/`](https://github.com/Stremio/stremio-bugs/issues/1316); the gap is **WebView + Cast SDK**, not the server.

**Upstream fork (in-tree `stremio-web` change):** see **`../stremio-web-upstream`** branch `feature/wkwebview-bundled-server-casting` and [`FORK_AND_PR.md`](https://github.com/jaltschuler25/stremio-web/blob/feature/wkwebview-bundled-server-casting/FORK_AND_PR.md) on the fork for PR title/description text that **explicitly frames the cast-button fix**.

**What to reuse upstream (no Next.js required for end users)**

| Integration point | Idea |
| --- | --- |
| **`stremio-web`** | Feature-detect missing `window.chrome.cast` / Cast framework and branch `ChromecastTransport` to drive **`http://127.0.0.1:11470/casting/`** (device list + `…/player?…` commands) instead of the Google SDK—**so the cast button enables and casting works**. `public/cast-shim.js` here is a behavioral sketch of the surface area to implement. |
| **v5 shell** | Inject a small script before loading the remote WebUI (or set a query flag) so the web app knows to use the server-backed cast path on WKWebView/WebView2. |
| **Avoid** | Shipping this whole Next.js proxy to users — it exists so we can **strip `cast_sender.js`**, neutralize the aggressive service worker, and inject the shim without forking `web.stremio.com` for every edit. |

**Security note for reviewers:** `next dev` / `next start` are configured to bind **`127.0.0.1` only** so the bridge is not advertised on the LAN. Endpoints such as `POST /api/launch` are still powerful on the host and must stay loopback-local if you ever adapt similar tooling.

**License:** [MIT](LICENSE) — reuse or rewrite in the official tree as needed.

**Upstream worktree:** a port of the shim into `stremio-web` (same **cast-button fix**) lives in `../stremio-web-upstream` on branch `feature/wkwebview-bundled-server-casting` — see `FORK_AND_PR.md` there for PR wording and fork/PR steps to `Stremio/stremio-web`.

## Prerequisites

- macOS with **Stremio 5 ARM beta** installed (`com.westbridge.stremio5-mac`, v5.1.x).
- Node.js ≥ 20.
- The bridge HTTP server binds to **127.0.0.1** only (see `npm run dev` / `npm run start` in `package.json`).
- The Chromecast and your Mac on the same Wi-Fi (obviously).
- macOS **Local Network** permission granted to Stremio (prompted on first launch of the bundle — needed for MDNS discovery).

## Setup

### Recommended: install as a Mac app (one-click launch)

This builds the bridge in production mode and drops a native
`Stremio Cast.app` bundle into `/Applications`. Opening that app (or
pinning it to the Dock) does everything for you — boots the bridge,
clears caches, launches Stremio with the `--webui-url` flag wired up.

```bash
cd stremio-cast-bridge
npm install
npm run install:app        # builds + creates /Applications/Stremio Cast.app
open "/Applications/Stremio Cast.app"
```

From then on, **always launch Stremio via "Stremio Cast"** instead of
the regular Stremio icon. Drag it into the Dock or add it to
**System Settings → General → Login Items** for auto-start.

To remove everything: `npm run uninstall:app`.

The generated app’s bundle identifier is `com.stremio.cast-bridge` for
local installs only; this project is **not** published by Stremio.

Logs live at `~/Library/Logs/stremio-cast-bridge.log` (watch with
`tail -f ~/Library/Logs/stremio-cast-bridge.log`).

### Dev mode (for editing the shim / panel)

```bash
cd stremio-cast-bridge
npm install
npm run dev                # bridge on http://localhost:36970
```

Then either:

- Open the printed URL in a browser, confirm the status pills are green, and hit **Launch Stremio 5 with Casting**, or
- Run `./scripts/launch-stremio.sh` which does the same thing headlessly (it starts the bridge if it isn't already up, clears caches, and launches Stremio with the right flag).

Both paths also **kill any existing Stremio 5 instance** and **wipe WKWebView's HTTP + Service Worker caches** before relaunching. This is required because macOS LaunchServices would otherwise just reactivate the existing Stremio window, silently discarding our `--webui-url` flag; and because WebKit's cache/SW would otherwise keep serving the original (broken-cast) HTML from before the bridge existed. Only the HTTP cache is wiped — logins, library and addons are stored in LocalStorage/IndexedDB which we leave untouched.

## How it works (in 90 seconds)

```
┌──────────────────────────┐        ┌────────────────────────────┐
│  Stremio 5 Rust shell    │        │  Stremio streaming server  │
│  (WKWebView, no Cast SDK)│        │  :11470 (Node, server.js)  │
└────────────┬─────────────┘        └────────────┬───────────────┘
             │  --webui-url=…/cast-bridge/       │
             ▼                                   │
┌──────────────────────────┐      GET /casting/  │
│  Next.js bridge (:36970) │ ────────────────────┤
│                          │                     │
│  /cast-bridge/*  ────────┼── proxy w/ strip &  │   MDNS / SSDP
│                  inject  │   inject cast-shim  │   ──────► 📺
│  /public/cast-shim.js ◀──┼── runs in WebView   │
└──────────────────────────┘                     │
                                                 │
          shim sends /casting/:id/player?source=…│
          ─────────────────────────────────────▶ │
```

- `app/cast-bridge/[[...path]]/route.ts` is a catch-all proxy in front of Stremio's own `/proxy/` route. On the HTML response it strips the `cast_sender.js` script tag (which would otherwise call `__onGCastApiAvailable(false)`) and injects the shim (inlined from `cast-shim.js`) after `</title>`.
- `public/cast-shim.js` defines `window.cast.framework` with just the surface Stremio's [`ChromecastTransport`](https://github.com/Stremio/stremio-web/blob/development/src/services/Chromecast/ChromecastTransport.js) uses. It then calls `window.__onGCastApiAvailable(true)` to wake the service up so the cast button un-greys.
- When the UI calls `requestSession()` the shim shows its own device picker fed from `GET /casting/`, calls `GET /casting/:devID/player?source=<video.src>&time=<ms>` to start the cast, pauses the local `<video>`, and then mirrors both directions so every control in Stremio's existing player (play/pause/seek/volume) keeps working.

## Files of interest

| File | Role |
| --- | --- |
| `app/cast-bridge/[[...path]]/route.ts` | Injecting HTTP proxy |
| `public/cast-shim.js` | The actual cast revival (runs inside the Stremio WebView) |
| `app/api/status/route.ts` | Health check consumed by the control panel |
| `app/api/launch/route.ts` | Spawns Stremio 5 with `--webui-url` |
| `lib/stremio-server.ts` | Thin typed wrapper around `/casting/` |
| `scripts/launch-stremio.sh` | CLI alternative to the control panel |

## Troubleshooting

The shim sends a tiny beacon back to the bridge at every lifecycle milestone, logged to the Next.js console:

```
[shim] boot — Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 …
[shim] cast-kick
[shim] request-session
[shim] session-start
```

- **Cast button still greyed out.** If `[shim] boot` doesn't appear, the WebView isn't loading our patched HTML — which almost always means the WKWebView network/SW cache is serving a stale copy from a pre-bridge run. Both the control panel's Launch button and `scripts/launch-stremio.sh` already wipe those caches for you; if you're launching Stremio some other way, clear them manually:
  ```bash
  pkill -f "Stremio 2.app"
  rm -rf ~/Library/Caches/com.westbridge.stremio5-mac/WebKit/NetworkCache
  rm -rf ~/Library/Caches/com.westbridge.stremio5-mac/WebKit/CacheStorage
  rm -rf ~/Library/WebKit/com.westbridge.stremio5-mac/WebsiteData/Default
  ```
  Your login, library and addons live in `LocalStorage`/`IndexedDB`, which we leave alone.
- **`[shim] boot` but no `[shim] cast-kick`.** Stremio's Chromecast service is running but hasn't registered its `window.__onGCastApiAvailable` handler yet. The shim retries for 60 s — if the kick never arrives, check that you're on the v5.1.19 build (Stremio 2.app, identifier `com.westbridge.stremio5-mac`). Earlier v5 betas didn't ship the ChromecastTransport at all.
- **Picker opens but "No devices found".** Hit `curl http://localhost:11470/casting/` directly. If that's also empty, the problem is mDNS permission / network, not the bridge. macOS Sonoma+ requires explicit Local Network permission for the Stremio process on first launch — toggle it in System Settings → Privacy & Security → Local Network.
- **Cast starts but TV plays then stalls.** Some streams (HLS, torrents) require the server's transcode endpoint. The shim forwards the raw `<video>.src` to `/casting/:id/player?source=`; Stremio's server-side `ChromecastClient` handles the transcode negotiation from there. If a specific stream format won't play, the same stream won't play from v4 either — it's a codec support issue on your Chromecast, not the bridge.

## Limitations

- macOS only (launcher locates the bundle by identifier). The shim itself is platform-agnostic and would work on the Windows/Linux v5 shell with a matching launcher.
- We don't implement Stremio's private `urn:x-cast:com.stremio` receiver protocol — any `sendMessage()` the UI tries to issue to its custom receiver is dropped, because the server-side `ChromecastClient` uses a different receiver (`APP_ID 74B9F456`) with a completely different wire format. Everything the user actually sees (play, pause, seek, volume, subtitles via server params) still works because those are driven through `GET /casting/:id/player?…`.
