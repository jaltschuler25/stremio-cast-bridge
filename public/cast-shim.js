/*
 * cast-shim.js — Stremio 5 Chromecast revival
 * -------------------------------------------
 * Injected by the Next.js proxy into the Stremio web UI served to the
 * Stremio 5 Rust shell. Its job is to convince the UI that Google Cast
 * is available (so the cast button un-greys) and then *actually* drive
 * the user's Chromecast through the casting API that Stremio's bundled
 * streaming server already exposes at http://127.0.0.1:11470/casting/.
 *
 * The design is deliberately pragmatic:
 *   - We do not speak Stremio's custom Chromecast receiver protocol.
 *     Instead we let the UI keep using its local <video> element as
 *     the source of truth, and we mirror that state to the Chromecast
 *     via the server's HTTP API. This matches the v4 UX almost
 *     perfectly — you click cast, pick a device, and the same stream
 *     jumps to your TV with the same controls still driving it.
 *   - We intercept sendMessage() chunks (which the UI tries to send to
 *     the receiver) and ignore them; the server is driving playback.
 *   - The device chooser and "currently casting" banner are our own
 *     DOM overlay, styled to feel native to Stremio 5's dark theme.
 */
(function () {
    "use strict";

    // Guard against the shim being injected twice by hot reloads etc.
    if (window.__stremioCastBridge) return;
    window.__stremioCastBridge = { version: "0.2.0" };

    // Lightweight beacon back to our bridge so we can see in the
    // Next.js server log exactly which stages the shim is reaching.
    // Helpful because the Stremio 5 WKWebView has no devtools.
    function beacon(stage, msg) {
        try {
            var u = "/api/ping?stage=" + encodeURIComponent(stage);
            if (msg) u += "&msg=" + encodeURIComponent(msg);
            fetch(u, { cache: "no-store", keepalive: true }).catch(function () {});
        } catch (_) { /* noop */ }
    }
    beacon("boot", navigator.userAgent.slice(0, 80));

    // ---------------------------------------------------------------
    // Stream URL sniffer
    //
    // Stremio plays HLS / adaptive streams through MediaSource, which
    // means `video.src` shows up as `blob:http://…` — useless for
    // Chromecast because the receiver can't fetch a blob from the
    // sender's private memory. We need the *original* manifest URL.
    //
    // Strategy: hook `window.fetch`, `XMLHttpRequest.open`, and the
    // `HTMLMediaElement.src` setter and remember whichever of those
    // most recently looked like a media URL (m3u8 / mpd / mp4 / mkv /
    // webm / mov, or anything served by the Stremio server's /stream
    // or /proxy route). At cast time we pass that URL to the
    // server-side Chromecast API.
    // ---------------------------------------------------------------

    var lastMediaUrl = null;
    // Ring buffer of the last few "interesting" URLs — used as a
    // fallback if nothing matched our media heuristic. Stremio 5 on
    // macOS may render video natively, in which case the stream URL
    // is passed through IPC (window.chrome.webview.postMessage)
    // rather than through an <video> element.
    var recentUrls = [];
    function pushRecent(u, from) {
        if (!u || typeof u !== "string") return;
        if (u.startsWith("blob:") || u.startsWith("data:")) return;
        // Filter out obvious noise: images, css, fonts, chunked JS.
        if (/\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff2?|ttf|otf|map)(\?|#|$)/i.test(u)) return;
        if (/\/(api\/ping|cast-bridge\/)/i.test(u)) return;
        recentUrls.push(from + " " + u);
        if (recentUrls.length > 15) recentUrls.shift();
    }

    // Stremio's bundled streaming server serves torrent files at paths
    // shaped like /<40-hex-infoHash>/<fileIdx>[/<encodedName>] — no
    // extension on the URL itself. This regex matches that exact
    // pattern against the local server and is the primary way we
    // recognise Stremio's "real" stream URL when no HTML <video>
    // element exists (native player mode on Stremio 5 macOS).
    var TORRENT_STREAM_RE =
        /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/[0-9a-f]{40}(?:\/\d+)?(?:\/|$|\?|#)/i;

    function looksLikeMediaUrl(u) {
        if (!u || typeof u !== "string") return false;
        if (u.startsWith("blob:") || u.startsWith("data:")) return false;
        // Explicit negatives: known Stremio API endpoints that are
        // not streams, even if they share a host with the streams.
        if (/\/(casting|stremio\/v1|settings|status|subtitles|opensubHash|images|meta(?:\/|$)|stats)/i.test(u)) {
            return false;
        }
        // Stremio bundled-server torrent stream: /<infoHash>/<fileIdx>.
        if (TORRENT_STREAM_RE.test(u)) return true;
        // Stremio server routes that carry stream bytes.
        if (/\/(hlsv2|transcode)\//i.test(u)) return true;
        // Generic media extensions.
        return /\.(m3u8|mpd|mp4|mkv|webm|mov|avi|ts)(\?|#|$)/i.test(u);
    }

    // Stremio often calls helper endpoints (opensubHash, subtitles, …)
    // that embed the real stream URL as a query param (usually
    // ?videoUrl=…). Pulling that out gives us the source of truth
    // even when the stream itself never goes through fetch/XHR.
    function extractEmbeddedStreamUrl(u) {
        if (!u || typeof u !== "string") return null;
        try {
            // Handle absolute + relative URLs safely.
            var parsed = new URL(u, location.href);
            var candidates = ["videoUrl", "videoURL", "source", "url"];
            for (var i = 0; i < candidates.length; i++) {
                var v = parsed.searchParams.get(candidates[i]);
                if (v && looksLikeMediaUrl(v)) return v;
            }
        } catch (_) { /* noop */ }
        return null;
    }

    function maybeCaptureUrl(u, from) {
        // Prefer an embedded stream URL inside a helper call.
        var embedded = extractEmbeddedStreamUrl(u);
        if (embedded) {
            if (embedded !== lastMediaUrl) {
                lastMediaUrl = embedded;
                beacon("stream-url", from + "+embed:" + embedded.slice(0, 120));
            }
            return;
        }
        if (!looksLikeMediaUrl(u)) return;
        if (u === lastMediaUrl) return;
        lastMediaUrl = u;
        if (!maybeCaptureUrl._throttled || Date.now() - maybeCaptureUrl._throttled > 3000) {
            maybeCaptureUrl._throttled = Date.now();
            beacon("stream-url", from + ":" + u.slice(0, 120));
        }
    }

    // fetch()
    var origFetch = window.fetch && window.fetch.bind(window);
    if (origFetch) {
        window.fetch = function (input, init) {
            try {
                var u = typeof input === "string" ? input : (input && input.url) || "";
                maybeCaptureUrl(u, "fetch");
                pushRecent(u, "fetch");
            } catch (_) { /* noop */ }
            return origFetch(input, init);
        };
    }

    // XMLHttpRequest.open()
    var origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        try {
            maybeCaptureUrl(url, "xhr");
            pushRecent(url, "xhr");
        } catch (_) { /* noop */ }
        return origXhrOpen.apply(this, arguments);
    };

    // -------------------------------------------------------------
    // IMPORTANT: we previously wrapped
    //   - `window.chrome.webview.postMessage` (to peek at Shell IPC)
    //   - `HTMLMediaElement.prototype.src`    (to catch direct MP4s)
    // Both were removed because they introduced regressions in
    // Stremio 5's native mpv player — pause / seek / volume commands
    // ride through the very same postMessage channel, and even the
    // tiny JSON-serialise overhead inside our wrapper was enough to
    // drop or reorder those commands.
    //
    // The `/opensubHash?videoUrl=…` request that Stremio makes for
    // every new stream is already enough to resolve the source URL
    // via the fetch hook above, so the extra wraps were pure
    // liability with no real benefit.
    // -------------------------------------------------------------

    // ---------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------

    // The Stremio streaming server is always reachable at this origin
    // from inside the shell; our shim lives on the same origin as the
    // proxy (this Next.js origin) but calls the server directly to avoid
    // proxy round-trips for every poll.
    var SERVER = "http://127.0.0.1:11470";
    var DEVICE_POLL_MS = 4000; // how often we refresh the device list
    var STATUS_POLL_MS = 1000; // how often we sync remote player state

    // ---------------------------------------------------------------
    // Tiny event emitter (we avoid pulling in deps)
    // ---------------------------------------------------------------

    function Emitter() {
        this._listeners = Object.create(null);
    }
    Emitter.prototype.on = function (type, cb) {
        (this._listeners[type] = this._listeners[type] || []).push(cb);
    };
    Emitter.prototype.off = function (type, cb) {
        var list = this._listeners[type];
        if (!list) return;
        var i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
    };
    Emitter.prototype.emit = function (type, payload) {
        var list = (this._listeners[type] || []).slice();
        for (var i = 0; i < list.length; i++) {
            try { list[i](payload); } catch (err) { console.error("[cast-shim] listener", err); }
        }
    };

    // ---------------------------------------------------------------
    // Fake Google Cast SDK
    // ---------------------------------------------------------------
    //
    // We only implement the small surface that Stremio's
    // ChromecastTransport actually calls (see
    // src/services/Chromecast/ChromecastTransport.js in stremio-web):
    //
    //   cast.framework.CastContext.getInstance()
    //     .addEventListener(type, cb)
    //     .setOptions(opts)
    //     .getCastState()
    //     .getSessionState()
    //     .getCurrentSession()
    //     .requestSession()         -> Promise
    //     .endCurrentSession(stopCasting)
    //
    //   session.addMessageListener(ns, cb)
    //   session.addEventListener(type, cb)
    //   session.sendMessage(ns, payload)
    //   session.getCastDevice()
    //
    // Everything else can be missing without breaking the UI.

    var CastState = {
        NO_DEVICES_AVAILABLE: "NO_DEVICES_AVAILABLE",
        NOT_CONNECTED: "NOT_CONNECTED",
        CONNECTING: "CONNECTING",
        CONNECTED: "CONNECTED",
    };
    var SessionState = {
        NO_SESSION: "NO_SESSION",
        SESSION_STARTING: "SESSION_STARTING",
        SESSION_STARTED: "SESSION_STARTED",
        SESSION_START_FAILED: "SESSION_START_FAILED",
        SESSION_ENDING: "SESSION_ENDING",
        SESSION_ENDED: "SESSION_ENDED",
        SESSION_RESUMED: "SESSION_RESUMED",
    };
    var CastContextEventType = {
        CAST_STATE_CHANGED: "caststatechanged",
        SESSION_STATE_CHANGED: "sessionstatechanged",
    };
    var CastSessionEvent = {
        APPLICATION_STATUS_CHANGED: "applicationstatuschanged",
        APPLICATION_METADATA_CHANGED: "applicationmetadatachanged",
        ACTIVE_INPUT_STATE_CHANGED: "activeinputstatechanged",
        VOLUME_CHANGED: "volumechanged",
        MEDIA_SESSION: "mediasession",
    };

    // ---------------------------------------------------------------
    // Fake CastSession — held alive while we're casting to a device.
    // It proxies user-land send/listen calls but never actually talks
    // to a real Cast receiver; playback is driven server-side.
    // ---------------------------------------------------------------
    function FakeCastSession(device) {
        var emitter = new Emitter();
        var messageListeners = Object.create(null);
        this._device = device;
        this._emitter = emitter;

        this.getCastDevice = function () {
            return {
                friendlyName: device.name,
                deviceId: device.id,
                modelName: device.type,
                ipAddress: device.host,
            };
        };
        this.addMessageListener = function (ns, cb) {
            (messageListeners[ns] = messageListeners[ns] || []).push(cb);
        };
        this.removeMessageListener = function (ns, cb) {
            var list = messageListeners[ns];
            if (!list) return;
            var i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
        this.addEventListener = function (type, cb) { emitter.on(type, cb); };
        this.removeEventListener = function (type, cb) { emitter.off(type, cb); };
        this.sendMessage = function () {
            // The UI sends chunked JSON over the urn:x-cast:com.stremio
            // namespace to drive its custom receiver. We're driving the
            // cast over the server-side API instead, so we can quietly
            // resolve every call — the UI never checks the response.
            return Promise.resolve();
        };
        this.endSession = function () { /* handled by CastContext */ };
    }

    // ---------------------------------------------------------------
    // Fake CastContext — singleton driving the "am I casting?" state.
    // ---------------------------------------------------------------
    function FakeCastContext() {
        var self = this;
        var listeners = new Emitter();
        var currentSession = null;
        var castState = CastState.NOT_CONNECTED; // we always have at least one device in theory
        var sessionState = SessionState.NO_SESSION;
        var options = {};

        // --- internal helpers ----------------------------------------
        function setCastState(next) {
            if (castState === next) return;
            castState = next;
            listeners.emit(CastContextEventType.CAST_STATE_CHANGED, { castState: next });
        }
        function setSessionState(next, session) {
            sessionState = next;
            listeners.emit(CastContextEventType.SESSION_STATE_CHANGED, {
                sessionState: next,
                session: session || null,
            });
        }

        // --- public API ----------------------------------------------
        this.addEventListener = function (type, cb) { listeners.on(type, cb); };
        this.removeEventListener = function (type, cb) { listeners.off(type, cb); };
        this.getCastState = function () { return castState; };
        this.getSessionState = function () { return sessionState; };
        this.getCurrentSession = function () { return currentSession; };
        this.setOptions = function (opts) { options = opts || {}; };

        /**
         * Called by the UI when the user clicks the cast button.
         * Returns a Promise that resolves to the chosen session state.
         */
        this.requestSession = function () {
            beacon("request-session");
            if (currentSession) {
                // If we're already casting, clicking the button again
                // should show a "stop casting" prompt — same as Cast SDK.
                return openActiveSessionChooser(self, currentSession);
            }
            return openDeviceChooser().then(function (device) {
                if (!device) { beacon("session-cancelled"); return SessionState.SESSION_START_FAILED; }
                setCastState(CastState.CONNECTING);
                setSessionState(SessionState.SESSION_STARTING);
                return startCasting(device).then(function (session) {
                    currentSession = session;
                    setCastState(CastState.CONNECTED);
                    setSessionState(SessionState.SESSION_STARTED, session);
                    beacon("session-start", device.name || device.id);
                    return SessionState.SESSION_STARTED;
                }).catch(function (err) {
                    console.error("[cast-shim] startCasting failed", err);
                    setCastState(CastState.NOT_CONNECTED);
                    setSessionState(SessionState.SESSION_START_FAILED);
                    toast("Failed to cast: " + (err && err.message ? err.message : err));
                    beacon("error", "start:" + (err && err.message ? err.message : err));
                    throw err;
                });
            });
        };

        this.endCurrentSession = function (stopCasting) {
            if (!currentSession) return;
            var dev = currentSession._device;
            setSessionState(SessionState.SESSION_ENDING, currentSession);
            stopCasting && stopRemote(dev.id).catch(function (e) {
                console.warn("[cast-shim] stop failed", e);
            });
            teardownMirror();
            currentSession = null;
            setSessionState(SessionState.SESSION_ENDED);
            setCastState(CastState.NOT_CONNECTED);
            removeBanner();
            beacon("session-end");
        };
    }

    var _ctx = null;
    function getContext() { return _ctx || (_ctx = new FakeCastContext()); }

    // Expose the fake SDK globals exactly where the Cast framework
    // would have put them. Stremio's transport references `cast.*`
    // as a global, so this is non-negotiable.
    window.cast = window.cast || {};
    window.cast.framework = {
        CastContext: { getInstance: getContext },
        CastState: CastState,
        SessionState: SessionState,
        CastContextEventType: CastContextEventType,
        CastSession: CastSessionEvent,
    };
    // `chrome.cast` is sometimes sniffed for existence; give it a stub.
    window.chrome = window.chrome || {};
    window.chrome.cast = window.chrome.cast || { isAvailable: true };

    // Wake up Stremio's Chromecast service. ChromecastTransport.js does
    //   window.__onGCastApiAvailable = function(available) { ... }
    // and waits for the real Cast SDK to call it. We call it ourselves
    // once the main bundle has had a chance to register that handler.
    function kickCastAvailable() {
        if (typeof window.__onGCastApiAvailable === "function") {
            try { window.__onGCastApiAvailable(true); beacon("cast-kick"); } catch (e) {
                console.warn("[cast-shim] onGCastApiAvailable threw", e);
                beacon("error", "cast-kick:" + e.message);
            }
            return true;
        }
        return false;
    }
    // Try immediately; if the UI hasn't booted yet, retry until it has.
    if (!kickCastAvailable()) {
        var attempts = 0;
        var iv = setInterval(function () {
            attempts++;
            if (kickCastAvailable() || attempts > 120 /* ~60s */) {
                clearInterval(iv);
            }
        }, 500);
    }

    // =================================================================
    // Server-side Chromecast driver
    // =================================================================

    function listDevices() {
        return fetch(SERVER + "/casting/", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : []; })
            .catch(function () { return []; });
    }

    function sendCmd(devID, params) {
        var qs = new URLSearchParams();
        for (var k in params) {
            if (params[k] === undefined || params[k] === null) continue;
            qs.set(k, String(params[k]));
        }
        return fetch(
            SERVER + "/casting/" + encodeURIComponent(devID) + "/player?" + qs.toString(),
            { cache: "no-store" }
        ).then(function (r) { return r.ok ? r.json() : null; });
    }

    function getStatus(devID) {
        return fetch(
            SERVER + "/casting/" + encodeURIComponent(devID) + "/player",
            { cache: "no-store" }
        ).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }

    function stopRemote(devID) {
        return sendCmd(devID, { stop: 1 });
    }

    /**
     * Walk the whole document tree, including shadow roots and
     * same-origin iframes, to collect every <video> element.
     * Stremio 5 renders its player inside a React tree that may use
     * shadow DOM, which is why a plain querySelectorAll misses it.
     */
    function collectVideosDeep(root, out) {
        if (!root) return;
        out = out || [];
        try {
            var direct = root.querySelectorAll ? root.querySelectorAll("video") : [];
            for (var i = 0; i < direct.length; i++) out.push(direct[i]);
            // Every element might have a shadow root.
            var all = root.querySelectorAll ? root.querySelectorAll("*") : [];
            for (var j = 0; j < all.length; j++) {
                var el = all[j];
                if (el.shadowRoot) collectVideosDeep(el.shadowRoot, out);
                if (el.tagName === "IFRAME") {
                    try {
                        var doc = el.contentDocument;
                        if (doc) collectVideosDeep(doc, out);
                    } catch (_) { /* cross-origin, skip */ }
                }
            }
        } catch (_) { /* noop */ }
        return out;
    }

    /**
     * Find the <video> currently driving playback. We don't require
     * a truthy `.src` any more because HLS streams use MediaSource,
     * which leaves `.src` empty (or set to a `blob:` URL). Pick the
     * most-likely candidate in priority order: playing -> scrubbed
     * -> attached to the DOM with any media state at all.
     */
    function findActiveVideo() {
        var videos = collectVideosDeep(document, []);
        for (var i = 0; i < videos.length; i++) {
            if (!videos[i].paused) return videos[i];
        }
        for (var j = 0; j < videos.length; j++) {
            if (videos[j].currentTime > 0 || videos[j].duration > 0) return videos[j];
        }
        return videos[0] || null;
    }

    /**
     * Pick the best URL to hand the Stremio server for casting. The
     * sniffer records any media-ish URL the app has fetched; if that
     * exists it's always the right answer. Falls back to
     * `video.currentSrc` / `video.src`, which covers the
     * direct-MP4-stream case where no manifest was needed.
     */
    /**
     * Decode Stremio's player route hash back to the underlying
     * stream descriptor. Stremio encodes the stream as:
     *
     *   /#/player/<urlsafe-base64 of zlib(deflate-stored)(JSON)>
     *
     * where the JSON contains `{ infoHash, fileIdx, announce, … }`
     * for torrent streams. The deflate block is always "stored"
     * (uncompressed), so after base64 decode the raw JSON sits
     * verbatim past a small zlib/deflate header — we just scan for
     * the first `{` byte and parse from there. No zlib library
     * needed, which keeps the shim tiny and free of external deps.
     */
    function decodeStremioPlayerHash(hash) {
        if (!hash) return null;
        try {
            // The path segment is %-encoded in the URL so undo that first.
            var raw = decodeURIComponent(hash);
            // Convert URL-safe base64 -> standard base64 + padding.
            raw = raw.replace(/-/g, "+").replace(/_/g, "/");
            while (raw.length % 4) raw += "=";
            var bin = atob(raw);
            var brace = bin.indexOf("{");
            if (brace < 0) return null;
            return JSON.parse(bin.slice(brace));
        } catch (_) { return null; }
    }

    /**
     * Look at the current `location.hash` and, if it points at a
     * /player/ route, try to build the torrent stream URL directly
     * from the infoHash + fileIdx embedded in the route. This gives
     * us a reliable URL *immediately* on cast click, even before
     * Stremio has made any of the helper fetches we were sniffing.
     */
    function streamUrlFromRoute() {
        var hash = location.hash || "";
        var m = hash.match(/#\/player\/([^?#/]+)/);
        if (!m) return null;
        var obj = decodeStremioPlayerHash(m[1]);
        if (!obj || !obj.infoHash) return null;
        var idx = (obj.fileIdx != null) ? obj.fileIdx : 0;
        // This matches how Stremio's bundled server exposes its
        // torrent streams (see server.js — /<infoHash>/<fileIdx>).
        return "http://127.0.0.1:11470/" +
            String(obj.infoHash).toLowerCase() + "/" + idx;
    }

    function resolveStreamUrl(video) {
        // 1) The route hash is the fastest + most reliable source.
        var fromRoute = streamUrlFromRoute();
        if (fromRoute) return fromRoute;
        // 2) Previously sniffed URL from fetch / opensubHash.
        if (lastMediaUrl) return lastMediaUrl;
        // 3) HTML5 video element, if any (rare on Stremio 5).
        var s = (video && (video.currentSrc || video.src)) || "";
        if (s && !s.startsWith("blob:") && !s.startsWith("data:")) return s;
        // 4) Last-ditch: replay the ring buffer.
        for (var i = recentUrls.length - 1; i >= 0; i--) {
            var parts = recentUrls[i].split(" ");
            var u = parts.slice(1).join(" ");
            var embedded = extractEmbeddedStreamUrl(u);
            if (embedded) return embedded;
            if (looksLikeMediaUrl(u)) return u;
        }
        return null;
    }

    /**
     * Start casting the currently playing stream to the picked device
     * and wire up two-way sync between the local player and the TV.
     */
    function startCasting(device) {
        var video = findActiveVideo();
        var source = resolveStreamUrl(video);

        // Diagnostic dump — this makes the server log instantly
        // useful when someone reports "cast didn't start".
        var allVideos = collectVideosDeep(document, []);
        beacon(
            "cast-attempt",
            JSON.stringify({
                dev: device.name || device.id,
                path: (location.pathname + location.hash).slice(0, 60),
                videoCount: allVideos.length,
                sniffed: (lastMediaUrl || "").slice(0, 100),
                recent: recentUrls.slice(-8).map(function (s) {
                    return s.slice(0, 120);
                }),
            }).slice(0, 900)
        );

        if (!source) {
            return Promise.reject(new Error(
                "Couldn't find a stream URL yet. Try hitting play, wait a second for the stream to start, then click cast again."
            ));
        }
        var timeMs = Math.max(0, Math.floor((video && video.currentTime) || 0) * 1000);

        // Pause the local player — the TV takes over from here.
        try { video && video.pause(); } catch (_) { /* noop */ }

        return sendCmd(device.id, { source: source, time: timeMs })
            .then(function () {
                showBanner(device);
                if (video) setupMirror(device, video);
                return new FakeCastSession(device);
            });
    }

    // =================================================================
    // Local <video> <-> remote mirror
    //
    // While a cast session is live we keep the *local* video element
    // in sync with the remote player. This means all of Stremio's
    // existing UI — play/pause button, seek bar, volume slider,
    // subtitle menus — Just Works, because they all drive the local
    // <video>, and we forward every change to the TV.
    // =================================================================

    var _mirror = null;
    function setupMirror(device, video) {
        teardownMirror();

        var localHandlers = {
            play: function () { sendCmd(device.id, { paused: 0 }); },
            pause: function () { sendCmd(device.id, { paused: 1 }); },
            // `seeked` fires after the user scrubs. We use a throttle
            // to avoid spamming on long drags.
            seeked: throttle(function () {
                sendCmd(device.id, { time: Math.floor(video.currentTime * 1000) });
            }, 400),
            volumechange: throttle(function () {
                var vol = video.muted ? 0 : Math.round((video.volume || 0) * 100);
                sendCmd(device.id, { volume: vol });
            }, 300),
        };
        Object.keys(localHandlers).forEach(function (ev) {
            video.addEventListener(ev, localHandlers[ev]);
        });

        // Poll remote status so the UI's timeline/play state follows
        // the TV if something else (another remote, TV buttons…)
        // changes it.
        var pollIv = setInterval(function () {
            getStatus(device.id).then(function (st) {
                if (!st || !_mirror) return;
                // Only overwrite the local time if drift > 1.5s, to
                // avoid constant UI jitter from normal playback.
                if (typeof st.time === "number" && video.duration) {
                    var localMs = video.currentTime * 1000;
                    if (Math.abs(localMs - st.time) > 1500) {
                        _mirror.suppressSeekOnce = true;
                        video.currentTime = st.time / 1000;
                    }
                }
                if (typeof st.paused === "boolean") {
                    if (st.paused && !video.paused) video.pause();
                    else if (!st.paused && video.paused) {
                        var p = video.play();
                        if (p && p.catch) p.catch(function () { /* ignored */ });
                    }
                }
            });
        }, STATUS_POLL_MS);

        _mirror = {
            device: device,
            video: video,
            localHandlers: localHandlers,
            pollIv: pollIv,
            suppressSeekOnce: false,
        };
    }

    function teardownMirror() {
        if (!_mirror) return;
        try {
            var v = _mirror.video;
            var h = _mirror.localHandlers;
            Object.keys(h).forEach(function (ev) { v.removeEventListener(ev, h[ev]); });
        } catch (_) { /* noop */ }
        clearInterval(_mirror.pollIv);
        _mirror = null;
    }

    function throttle(fn, wait) {
        var t = 0, last = null, ctx = null;
        return function () {
            var now = Date.now();
            last = arguments; ctx = this;
            if (now - t >= wait) {
                t = now;
                fn.apply(ctx, last);
            } else if (!last._scheduled) {
                last._scheduled = true;
                setTimeout(function () { t = Date.now(); fn.apply(ctx, last); }, wait - (now - t));
            }
        };
    }

    // =================================================================
    // UI overlays — device chooser & "casting to..." banner
    // =================================================================

    var STYLE_ID = "cast-shim-styles";
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement("style");
        s.id = STYLE_ID;
        s.textContent = [
            ".cbshim-backdrop{position:fixed;inset:0;background:rgba(6,6,12,.72);z-index:2147483646;display:flex;align-items:center;justify-content:center;font-family:inherit;backdrop-filter:blur(6px);}",
            ".cbshim-modal{background:#1a1a24;color:#fff;min-width:320px;max-width:420px;width:90%;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.55);overflow:hidden;border:1px solid rgba(255,255,255,.06);}",
            ".cbshim-header{padding:16px 20px 12px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;letter-spacing:.01em;}",
            ".cbshim-sub{padding:0 20px 12px;font-size:12px;color:#9ba2b8;}",
            ".cbshim-list{max-height:320px;overflow-y:auto;padding:4px 8px 8px;}",
            ".cbshim-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;cursor:pointer;user-select:none;}",
            ".cbshim-item:hover{background:rgba(255,255,255,.06);}",
            ".cbshim-item .dot{width:8px;height:8px;border-radius:50%;background:#7c5cff;flex:0 0 auto;}",
            ".cbshim-item .meta{flex:1;min-width:0;}",
            ".cbshim-item .name{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
            ".cbshim-item .host{font-size:11px;color:#7a8099;}",
            ".cbshim-empty{padding:24px 20px;color:#8a92a8;font-size:13px;text-align:center;}",
            ".cbshim-actions{display:flex;gap:8px;padding:12px 16px 16px;justify-content:flex-end;}",
            ".cbshim-btn{padding:8px 14px;border-radius:8px;border:0;background:rgba(255,255,255,.08);color:#fff;font-size:13px;cursor:pointer;}",
            ".cbshim-btn:hover{background:rgba(255,255,255,.14);}",
            ".cbshim-btn.primary{background:#7c5cff;}",
            ".cbshim-btn.primary:hover{background:#8a6dff;}",
            ".cbshim-btn.danger{background:#ff4d6d;}",
            ".cbshim-banner{position:fixed;bottom:20px;right:20px;z-index:2147483645;background:#1a1a24;color:#fff;border:1px solid rgba(255,255,255,.08);padding:14px 16px;border-radius:14px;display:flex;flex-direction:column;gap:12px;font-size:12px;box-shadow:0 12px 30px rgba(0,0,0,.4);min-width:440px;max-width:520px;}",
            ".cbshim-banner .pulse{width:8px;height:8px;border-radius:50%;background:#7c5cff;box-shadow:0 0 0 0 rgba(124,92,255,.6);animation:cbpulse 1.6s infinite;flex:0 0 auto;}",
            ".cbshim-row{display:flex;align-items:center;gap:12px;}",
            ".cbshim-target{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
            ".cbshim-iconbtn{background:rgba(255,255,255,.08);border:0;color:#fff;width:36px;height:36px;border-radius:50%;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;}",
            ".cbshim-iconbtn:hover{background:rgba(255,255,255,.16);}",
            ".cbshim-iconbtn.primary{background:#7c5cff;}",
            ".cbshim-iconbtn.primary:hover{background:#8a6dff;}",
            ".cbshim-time{font-size:11px;color:#9ba2b8;min-width:46px;text-align:center;font-variant-numeric:tabular-nums;}",
            // Larger hit area — 22px tall wrapper (invisible padding) with a
            // 10px visible track, so the slider is easy to grab without
            // making the panel itself feel oversized.
            ".cbshim-range{-webkit-appearance:none;appearance:none;flex:1;height:22px;background:transparent;outline:none;cursor:pointer;padding:0;margin:0;}",
            ".cbshim-range::-webkit-slider-runnable-track{height:10px;background:rgba(255,255,255,.14);border-radius:5px;}",
            ".cbshim-range::-moz-range-track{height:10px;background:rgba(255,255,255,.14);border-radius:5px;}",
            ".cbshim-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:20px;background:#7c5cff;border-radius:50%;cursor:pointer;border:2px solid #1a1a24;margin-top:-5px;box-shadow:0 2px 6px rgba(0,0,0,.4);}",
            ".cbshim-range::-webkit-slider-thumb:hover{background:#8a6dff;transform:scale(1.08);}",
            ".cbshim-range::-moz-range-thumb{width:20px;height:20px;background:#7c5cff;border-radius:50%;cursor:pointer;border:2px solid #1a1a24;box-shadow:0 2px 6px rgba(0,0,0,.4);}",
            ".cbshim-range.vol{height:18px;}",
            ".cbshim-range.vol::-webkit-slider-runnable-track{height:6px;}",
            ".cbshim-range.vol::-moz-range-track{height:6px;}",
            ".cbshim-range.vol::-webkit-slider-thumb{width:14px;height:14px;margin-top:-4px;}",
            ".cbshim-range.vol::-moz-range-thumb{width:14px;height:14px;}",
            ".cbshim-vol-ico{font-size:14px;opacity:.75;flex:0 0 auto;}",
            "@keyframes cbpulse{0%{box-shadow:0 0 0 0 rgba(124,92,255,.6);}70%{box-shadow:0 0 0 10px rgba(124,92,255,0);}100%{box-shadow:0 0 0 0 rgba(124,92,255,0);}}",
            ".cbshim-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#2a2a36;color:#fff;padding:10px 16px;border-radius:8px;z-index:2147483647;font-size:13px;box-shadow:0 8px 20px rgba(0,0,0,.4);}",
        ].join("\n");
        document.head.appendChild(s);
    }

    function openDeviceChooser() {
        ensureStyles();
        return new Promise(function (resolve) {
            var backdrop = document.createElement("div");
            backdrop.className = "cbshim-backdrop";
            var modal = document.createElement("div");
            modal.className = "cbshim-modal";
            modal.innerHTML =
                '<div class="cbshim-header">Cast to a device</div>' +
                '<div class="cbshim-sub">Discovered on your local network</div>' +
                '<div class="cbshim-list" data-list><div class="cbshim-empty">Searching…</div></div>' +
                '<div class="cbshim-actions"><button class="cbshim-btn" data-cancel>Cancel</button></div>';
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);

            var listEl = modal.querySelector("[data-list]");
            var cancelBtn = modal.querySelector("[data-cancel]");
            var pollHandle = null;
            var done = false;

            function close(result) {
                if (done) return;
                done = true;
                if (pollHandle) clearInterval(pollHandle);
                backdrop.remove();
                resolve(result);
            }

            cancelBtn.addEventListener("click", function () { close(null); });
            backdrop.addEventListener("click", function (e) {
                if (e.target === backdrop) close(null);
            });

            function render(devices) {
                if (!devices.length) {
                    listEl.innerHTML = '<div class="cbshim-empty">No devices found.<br/>Make sure your Chromecast is on the same Wi-Fi and that macOS has granted Stremio Local Network permission.</div>';
                    return;
                }
                listEl.innerHTML = "";
                devices.forEach(function (d) {
                    var row = document.createElement("div");
                    row.className = "cbshim-item";
                    row.innerHTML =
                        '<div class="dot"></div>' +
                        '<div class="meta"><div class="name"></div><div class="host"></div></div>';
                    row.querySelector(".name").textContent = d.name || d.id;
                    row.querySelector(".host").textContent =
                        (d.type || "device") + " — " + (d.host || d.location || "");
                    row.addEventListener("click", function () { close(d); });
                    listEl.appendChild(row);
                });
            }

            function refresh() {
                listDevices().then(function (devs) {
                    // Filter out DLNA TVs you can't cast video to if you want;
                    // for now expose everything the server sees so the user
                    // can still pick smart TVs via DLNA.
                    render(devs || []);
                });
            }
            refresh();
            pollHandle = setInterval(refresh, DEVICE_POLL_MS);
        });
    }

    function openActiveSessionChooser(ctx, session) {
        ensureStyles();
        return new Promise(function (resolve) {
            var backdrop = document.createElement("div");
            backdrop.className = "cbshim-backdrop";
            var modal = document.createElement("div");
            modal.className = "cbshim-modal";
            var name = (session._device && session._device.name) || "your device";
            modal.innerHTML =
                '<div class="cbshim-header">Casting to ' + escapeHtml(name) + '</div>' +
                '<div class="cbshim-sub">Local playback is paused while casting.</div>' +
                '<div class="cbshim-actions">' +
                '<button class="cbshim-btn" data-close>Keep casting</button>' +
                '<button class="cbshim-btn danger" data-stop>Stop casting</button>' +
                '</div>';
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);

            function cleanup() { backdrop.remove(); }
            modal.querySelector("[data-close]").addEventListener("click", function () {
                cleanup(); resolve(SessionState.SESSION_STARTED);
            });
            modal.querySelector("[data-stop]").addEventListener("click", function () {
                ctx.endCurrentSession(true);
                cleanup();
                resolve(SessionState.SESSION_ENDED);
            });
            backdrop.addEventListener("click", function (e) {
                if (e.target === backdrop) { cleanup(); resolve(SessionState.SESSION_STARTED); }
            });
        });
    }

    // =================================================================
    // Active cast control panel
    //
    // Stremio 5's own UI drives the *local* mpv player, which is idle
    // while we're casting. That means its pause/seek/volume buttons
    // have nothing to talk to. So we render our own control panel
    // pinned to the corner that speaks directly to the cast device via
    // the Stremio server's /casting API. State is kept in sync by
    // polling the remote player status on a short interval.
    // =================================================================

    var _banner = null;

    // Format milliseconds as a short time string like "1:23" or "1:02:03".
    function formatMs(ms) {
        if (!isFinite(ms) || ms < 0) ms = 0;
        var total = Math.floor(ms / 1000);
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        var pad = function (n) { return (n < 10 ? "0" : "") + n; };
        return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
    }

    function showBanner(device) {
        ensureStyles();
        removeBanner();
        var el = document.createElement("div");
        el.className = "cbshim-banner";
        el.innerHTML =
            '<div class="cbshim-row">' +
              '<span class="pulse"></span>' +
              '<span class="cbshim-target">Casting to <strong></strong></span>' +
              '<button class="cbshim-btn danger" data-stop style="padding:4px 10px;font-size:11px;">Stop</button>' +
            '</div>' +
            '<div class="cbshim-row">' +
              '<button class="cbshim-iconbtn primary" data-playpause title="Play/Pause">&#9658;</button>' +
              '<span class="cbshim-time" data-cur>0:00</span>' +
              '<input type="range" class="cbshim-range" min="0" max="1000" step="1" value="0" data-seek>' +
              '<span class="cbshim-time" data-dur>--:--</span>' +
            '</div>' +
            '<div class="cbshim-row">' +
              '<span class="cbshim-vol-ico" data-volicon>&#128266;</span>' +
              '<input type="range" class="cbshim-range vol" min="0" max="100" step="1" value="80" data-vol>' +
            '</div>';
        el.querySelector("strong").textContent = device.name || device.id;

        var stopBtn = el.querySelector("[data-stop]");
        var playBtn = el.querySelector("[data-playpause]");
        var seekEl = el.querySelector("[data-seek]");
        var curEl = el.querySelector("[data-cur]");
        var durEl = el.querySelector("[data-dur]");
        var volEl = el.querySelector("[data-vol]");
        var volIcon = el.querySelector("[data-volicon]");

        // Local UI state, kept in sync with the remote player by polling.
        // `userSeeking` / `userVolume` gate poll updates so the slider
        // doesn't fight the user while they're dragging it.
        var ui = {
            paused: true,
            duration: 0,
            time: 0,
            volume: 80,
            userSeeking: false,
            userVolume: false,
        };

        function setPlayIcon(paused) {
            // &#9658; = play triangle, &#10074;&#10074; = pause bars
            playBtn.innerHTML = paused ? "&#9658;" : "&#10074;&#10074;";
        }
        setPlayIcon(true);

        stopBtn.addEventListener("click", function () {
            getContext().endCurrentSession(true);
        });

        playBtn.addEventListener("click", function () {
            var nextPaused = !ui.paused;
            ui.paused = nextPaused;
            setPlayIcon(nextPaused);
            sendCmd(device.id, { paused: nextPaused ? 1 : 0 }).catch(function () {});
        });

        seekEl.addEventListener("input", function () {
            ui.userSeeking = true;
            if (ui.duration > 0) {
                var ratio = (+seekEl.value) / 1000;
                curEl.textContent = formatMs(ratio * ui.duration);
            }
        });
        seekEl.addEventListener("change", function () {
            if (ui.duration > 0) {
                var ratio = (+seekEl.value) / 1000;
                var targetMs = Math.floor(ratio * ui.duration);
                sendCmd(device.id, { time: targetMs }).catch(function () {});
                ui.time = targetMs;
            }
            // Brief grace window so a status poll doesn't snap the slider
            // back to the pre-seek position while the TV catches up.
            setTimeout(function () { ui.userSeeking = false; }, 1500);
        });

        volEl.addEventListener("input", function () { ui.userVolume = true; });
        volEl.addEventListener("change", function () {
            // UI slider is 0-100 for intuitive feel, but Stremio's
            // /casting API takes a float 0..1 (matches what it reports
            // back in getStatus), so we divide on the way out.
            var vol = +volEl.value;
            ui.volume = vol;
            sendCmd(device.id, { volume: vol / 100 }).catch(function () {});
            setTimeout(function () { ui.userVolume = false; }, 800);
        });

        // Remote status poll — drives the slider, time readout, and
        // play/pause icon so external controls (TV remote, etc.) stay
        // reflected in our UI.
        //
        // Payload shape (observed on Chromecast):
        //   { time: <ms>, length: <ms>, paused: bool, volume: 0..1, ... }
        // Note: `length` (not `duration`) is the total runtime, and
        // volume is a float 0..1 — easy to get wrong from Cast SDK
        // conventions where volume is often 0..100.
        function applyStatus(st) {
            if (!st || !_banner || _banner !== el) return;
            var dur = (typeof st.length === "number" && st.length > 0)
                ? st.length
                : (typeof st.duration === "number" ? st.duration : 0);
            if (dur > 0) {
                ui.duration = dur;
                durEl.textContent = formatMs(dur);
            }
            if (typeof st.time === "number" && !ui.userSeeking) {
                ui.time = st.time;
                curEl.textContent = formatMs(st.time);
                if (ui.duration > 0) {
                    var pos = Math.max(0, Math.min(1000,
                        Math.floor((st.time / ui.duration) * 1000)));
                    seekEl.value = String(pos);
                }
            }
            if (typeof st.paused === "boolean") {
                ui.paused = st.paused;
                setPlayIcon(st.paused);
            }
            if (typeof st.volume === "number" && !ui.userVolume) {
                var vol100 = st.volume <= 1
                    ? Math.round(st.volume * 100)
                    : Math.round(st.volume);
                ui.volume = vol100;
                volEl.value = String(vol100);
                volIcon.innerHTML = vol100 === 0
                    ? "&#128263;"
                    : vol100 < 40 ? "&#128264;" : "&#128266;";
            }
        }
        // Kick off an immediate fetch so the panel shows real numbers
        // on the very first frame instead of placeholder dashes.
        getStatus(device.id).then(applyStatus).catch(function () {});
        var pollIv = setInterval(function () {
            getStatus(device.id).then(applyStatus).catch(function () {});
        }, STATUS_POLL_MS);
        el.__pollIv = pollIv;

        document.body.appendChild(el);
        _banner = el;
    }
    function removeBanner() {
        if (_banner) {
            if (_banner.__pollIv) clearInterval(_banner.__pollIv);
            _banner.remove();
            _banner = null;
        }
    }

    function toast(msg) {
        ensureStyles();
        var el = document.createElement("div");
        el.className = "cbshim-toast";
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 4000);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
        });
    }

    console.log("[cast-shim] ready, version", window.__stremioCastBridge.version);
})();
