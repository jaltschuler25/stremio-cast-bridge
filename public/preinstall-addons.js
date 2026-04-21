/*
 * preinstall-addons.js
 * ---------------------
 * Injected by the Next.js cast-bridge proxy alongside cast-shim.js.
 * On the user's FIRST launch through the bridge, we surface Stremio's
 * own addon install dialog for each "default" addon below, so a
 * layperson who just downloaded Stremio Cast immediately has useful
 * stream sources (Torrentio, etc.) queued for one-tap install.
 *
 * Why we don't auto-install silently:
 *   Stremio's Core runs in a web worker and the React service context
 *   is not exposed on `window`. Reaching into the Redux-like core
 *   dispatch from outside the bundle would require fragile React
 *   fiber-tree traversal AND we'd bypass Stremio's own addon audit
 *   prompt (users should see what they're installing).
 *
 * Instead we use Stremio's OFFICIAL URL hook — identical to the
 * `window.location.href = '#/addons?addon=<manifestUrl>'` pattern
 * used by App.js when Stremio itself opens addon install dialogs
 * (e.g. from EventModal). That surfaces the canonical AddonDetails
 * modal with an INSTALL button already highlighted. One click = done.
 *
 * Idempotent: each addon is only ever queued once thanks to a
 * localStorage flag keyed by manifest URL.
 */
(function () {
    "use strict";

    // Guard against double-injection from hot reloads / SW replays.
    if (window.__stremioCastBridgePreinstall) return;
    window.__stremioCastBridgePreinstall = { version: "0.1.0" };

    /**
     * Default addon list shipped with Stremio Cast.
     *
     * IMPORTANT: Opt-in only. Existing users already have their own
     * addons in Stremio's IndexedDB; auto-navigating to an install
     * dialog on every launch is noisy and — if the user has multiple
     * Stremio installs — can make it look like their profile was
     * wiped when really we just opened a dialog on top of the page.
     *
     * Users can enable preinstall by setting a flag in localStorage
     * from Stremio's devtools (or via our control panel later):
     *
     *   localStorage.setItem('castBridge:preinstall-enabled', '1');
     *
     * and can disable again with:
     *
     *   localStorage.removeItem('castBridge:preinstall-enabled');
     */
    var DEFAULT_ADDONS = [
        {
            name: "Torrentio",
            // Torrentio — torrent stream provider. Manifest URL is
            // stable; the user can configure providers / debrid on
            // torrentio.strem.fun after install.
            transportUrl: "https://torrentio.strem.fun/manifest.json",
        },
    ];

    var ENABLE_FLAG = "castBridge:preinstall-enabled";

    var FLAG_PREFIX = "castBridge:preinstalled:";

    /**
     * Navigate to Stremio's addon install route. Using a hash change
     * (not a full location.href replacement on the non-hash part) so
     * we don't reload the SPA. The Addons route picks up the
     * `?addon=<url>` query param and opens AddonDetailsModal.
     *
     * We do this one addon at a time. If a future version of the
     * list has >1 addon, we queue them sequentially so each gets
     * its own confirm dialog.
     */
    function openInstallDialog(transportUrl) {
        var target = "#/addons?addon=" + encodeURIComponent(transportUrl);
        // Use `location.hash` assignment so Stremio's router picks it
        // up; `location.href = '#…'` would also work but some WebKits
        // treat that as a full navigation and lose state.
        try {
            window.location.hash = target.replace(/^#/, "");
        } catch (_) {
            window.location.href = target;
        }
    }

    /**
     * Wait for Stremio's SPA to be mounted before navigating. We
     * look for `#app` or `[data-reactroot]` as a readiness probe —
     * they don't exist until React's initial render, which in turn
     * can't happen until the Core worker has booted and the
     * services context is populated. This prevents us from
     * navigating into a blank shell and racing the Core init.
     */
    function whenAppReady(cb, deadlineMs) {
        var start = Date.now();
        var deadline = deadlineMs || 20000;
        (function poll() {
            var ready =
                document.querySelector("#app") ||
                document.querySelector("[data-reactroot]") ||
                document.querySelector("main") ||
                // Fallback: most Stremio pages render a nav bar quickly.
                document.querySelector('[class*="nav-bar" i]');
            if (ready) {
                // Give React one more tick to finish mounting routes
                // before we change the hash — otherwise the router
                // may not have installed its hashchange listener yet.
                setTimeout(cb, 500);
                return;
            }
            if (Date.now() - start > deadline) {
                // Give up quietly — the user can still install manually.
                return;
            }
            setTimeout(poll, 250);
        })();
    }

    /**
     * Process the queue of default addons. We only touch each once
     * thanks to the per-URL localStorage flag; a user who declines
     * the install dialog will not be re-prompted on next launch,
     * avoiding a "nag" experience.
     */
    function runPreinstall() {
        // Gate the whole flow behind an explicit opt-in so we never
        // auto-navigate an existing user's Stremio window into the
        // addons modal on launch.
        try {
            if (localStorage.getItem(ENABLE_FLAG) !== "1") return;
        } catch (_) {
            return; // no storage = don't touch anything
        }

        var pending = DEFAULT_ADDONS.filter(function (a) {
            try {
                return !localStorage.getItem(FLAG_PREFIX + a.transportUrl);
            } catch (_) {
                return true; // fail-open if localStorage is unavailable
            }
        });
        if (pending.length === 0) return;

        whenAppReady(function () {
            // Only trigger for the FIRST pending addon per launch.
            // This avoids stacking dialogs; remaining addons (if any)
            // surface on subsequent launches until the user addresses
            // each one. With a single-item DEFAULT_ADDONS list this
            // is moot, but it future-proofs the behavior.
            var next = pending[0];
            try {
                localStorage.setItem(FLAG_PREFIX + next.transportUrl, String(Date.now()));
            } catch (_) { /* private mode etc. */ }
            openInstallDialog(next.transportUrl);
        });
    }

    // Defer until document is interactive so React has a shot at
    // mounting. `DOMContentLoaded` is safe even in WKWebView.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", runPreinstall, { once: true });
    } else {
        runPreinstall();
    }
})();
