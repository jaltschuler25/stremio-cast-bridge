/**
 * Central place for values we may want to tweak without code-hunting.
 * The Stremio v5 Rust shell always launches its bundled Node server on
 * port 11470 unless explicitly overridden, so it's safe to hardcode as
 * the default while still honouring an env override for future-proofing.
 */
export const STREMIO_SERVER_URL =
  process.env.STREMIO_SERVER_URL ?? "http://127.0.0.1:11470";

/**
 * Stremio's WebUI proxy route. When asked to proxy an absolute URL it
 * returns the remote page with all relative references intact, which is
 * the easiest way to get the SPA running inside our own origin.
 *
 * IMPORTANT: the trailing slash is a literal `/`, NOT a URL-encoded
 * `%2F`. Stremio's `/proxy/d=<url>` endpoint matches only a plain `/`
 * as the boundary between the base URL and the sub-path — if we
 * encode it, requests for asset sub-paths 404. We pass the base URL
 * without its trailing slash to `encodeURIComponent` and let the
 * route handler stitch on the plain `/` itself.
 */
export const STREMIO_WEBUI_UPSTREAM = `${STREMIO_SERVER_URL}/proxy/d=${encodeURIComponent(
  "https://web.stremio.com"
)}/`;

/**
 * Path at which our Next.js app mounts the patched Stremio WebUI. We
 * launch `Stremio 2.app` with `--webui-url=<origin>{CAST_BRIDGE_MOUNT}`
 * so the Rust shell loads our shimmed version instead of the broken one.
 */
export const CAST_BRIDGE_MOUNT = "/cast-bridge";

/**
 * Default Next dev server port (`npm run dev`). Kept in sync with
 * `package.json` and the shell launchers; production uses `npm run start`
 * (default 36971) or `BRIDGE_PORT`.
 */
export const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 36970);
