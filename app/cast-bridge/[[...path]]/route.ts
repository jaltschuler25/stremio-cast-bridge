/**
 * Cast-bridge HTTP proxy.
 *
 * When the Stremio v5 Rust shell is launched with
 *     --webui-url=http://127.0.0.1:<port>/cast-bridge/
 * every HTTP request it makes lands here. We forward it unchanged to
 * Stremio's own built-in WebUI proxy (`/proxy/d=https://web.stremio.com/`
 * on port 11470) so that the full SPA continues to work exactly as it
 * does today — *except* that we rewrite the root HTML document on the
 * fly to:
 *   1. Strip the Google Cast sender SDK <script> (it never finishes
 *      initialising inside WKWebView/WebView2 and is what keeps the
 *      cast button greyed out).
 *   2. Inject our own `cast-shim.js` right before `</body>` so it runs
 *      *after* Stremio's Chromecast service has set up
 *      `window.__onGCastApiAvailable`, letting us fake a working Cast
 *      API that actually drives the real Chromecast through the
 *      Stremio server's `/casting/` HTTP API.
 *
 * All non-HTML responses (CSS, JS bundles, images, XHR, manifest…)
 * stream through untouched so nothing else regresses.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STREMIO_WEBUI_UPSTREAM } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Load cast-shim.js from disk on every HTML request so edits to the
 * shim are reflected without restarting Next.js. Cached in-module
 * after first load but invalidated if the file's mtime changes.
 *
 * We inline the shim instead of referencing it as an external
 * `<script src>` because we repeatedly observed WKWebView in the
 * Stremio 5 shell silently skip the fetch for our externally-linked
 * shim, even when placed at the top of `<head>`, after `</title>`,
 * or right before `</body>`. Inlining removes any ambiguity — the
 * shim is part of the same byte stream as the document, so it runs
 * the moment the parser reaches the tag.
 */
let shimCache: { mtimeMs: number; body: string } | null = null;
async function loadShim(): Promise<string> {
  const p = join(process.cwd(), "public", "cast-shim.js");
  // `stat` would be another syscall — since the file is small, just
  // re-read it every time in dev. Next in prod caches the module
  // scope so this pays off; we also keep a tiny memo to avoid
  // rereading for concurrent requests.
  try {
    const { statSync } = await import("node:fs");
    const s = statSync(p);
    if (shimCache && shimCache.mtimeMs === s.mtimeMs) return shimCache.body;
    const body = await readFile(p, "utf8");
    shimCache = { mtimeMs: s.mtimeMs, body };
    return body;
  } catch (err) {
    console.error("[cast-bridge] failed to read cast-shim.js", err);
    return "/* cast-shim.js failed to load */";
  }
}

/**
 * The Stremio web app ships an aggressive Workbox service worker that
 * cache-firsts every asset and, crucially, once installed will serve
 * a *cached* copy of the root HTML document on every subsequent
 * navigation — which would mean our injected shim tag only lives for
 * one page load before being replaced by a cached copy that predates
 * this bridge. That also explains why a second Stremio launch may
 * fetch only the HTML + SW and nothing else (SW-controlled loads all
 * come from Cache Storage with no network hit we can see).
 *
 * We defuse this by serving our own replacement service-worker.js
 * that immediately claims clients, clears every cache, and
 * unregisters itself. Net effect: everything goes through our proxy
 * on every request, exactly what we want during development.
 */
const NULL_SERVICE_WORKER = `// cast-bridge neutralised service worker
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
// Explicitly do nothing for fetches so the browser goes to network.
self.addEventListener('fetch', () => {});
`;

// Paths we want to hijack before they reach the upstream proxy. The
// value is the string body we'll return with content-type JS.
const HIJACK: Record<string, string> = {
  "service-worker.js": NULL_SERVICE_WORKER,
};

// Tags/scripts we actively want to remove from the upstream HTML before
// we hand it to the WebView. Kept as an array so it's easy to extend.
const STRIP_PATTERNS: RegExp[] = [
  // Google Cast sender — its only job was to call
  //   window.__onGCastApiAvailable(true|false)
  // Our shim calls it with `true` itself, so removing this script
  // prevents it from racing ours and flipping the flag back to false.
  /<script[^>]*cast_sender\.js[^>]*><\/script>/gi,
];

/**
 * Build the inline shim tag. We wrap the script body in a guarded
 * IIFE and a data attribute so we can easily identify it in dev
 * tools. The body is read from disk at request time by `loadShim`.
 */
function buildShimTag(body: string): string {
  // Escape `</script>` occurrences so the HTML parser doesn't bail
  // out of the script context early. Unlikely in our own code, but a
  // free safety net.
  const safe = body.replace(/<\/script/gi, "<\\/script");
  return `<script data-cast-bridge="1">${safe}</script>`;
}

function buildUpstreamUrl(path: string[] | undefined, search: string): string {
  // `path` is undefined on the index route (/cast-bridge/) and an
  // array for any nested request (/cast-bridge/foo/bar).
  const suffix = (path ?? []).map(encodeURIComponent).join("/");
  const base = `${STREMIO_WEBUI_UPSTREAM}${suffix}`;
  return search ? `${base}${search}` : base;
}

function isHtmlResponse(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("text/html");
}

function injectShim(html: string, shimTag: string): string {
  let patched = html;
  for (const re of STRIP_PATTERNS) {
    patched = patched.replace(re, "");
  }
  // Inject right after `</title>` — after `<meta charset>` (so the
  // encoding is locked in) but before Stremio's own `<script src>`
  // tags (so our fake Cast API is visible when `main.js` executes).
  if (/<\/title>/i.test(patched)) {
    return patched.replace(/<\/title>/i, (m) => `${m}${shimTag}`);
  }
  if (/<head[^>]*>/i.test(patched)) {
    return patched.replace(/<head[^>]*>/i, (m) => `${m}${shimTag}`);
  }
  if (patched.includes("</body>")) {
    return patched.replace("</body>", `${shimTag}</body>`);
  }
  return shimTag + patched;
}

/**
 * Build a fetch Request targeted at Stremio's own proxy, preserving
 * method + headers + body so websockets and POSTs still work.
 */
async function buildUpstreamRequest(
  req: NextRequest,
  upstreamUrl: string
): Promise<Request> {
  // Strip hop-by-hop / host-specific headers — passing them upstream
  // confuses Node's HTTP client and breaks keep-alive for no gain.
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("accept-encoding"); // let fetch pick & auto-decompress

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = await req.arrayBuffer();
  }
  return new Request(upstreamUrl, init);
}

async function handle(
  req: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const { path } = await context.params;

  // Intercept a handful of paths (currently just the SW) before we
  // even touch the upstream — see HIJACK for why.
  const last = path?.[path.length - 1];
  if (last && HIJACK[last]) {
    return new Response(HIJACK[last], {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        // SW-specific header — instructs the browser to always re-check
        // the worker script, so a stale registration can't linger.
        "service-worker-allowed": "/",
      },
    });
  }

  const upstreamUrl = buildUpstreamUrl(path, req.nextUrl.search);
  const upstreamReq = await buildUpstreamRequest(req, upstreamUrl);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamReq);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Stremio streaming server is not reachable",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Start Stremio 5 first so its bundled server on port 11470 is up.",
      },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get("content-type");

  // Fast path: non-HTML responses stream straight through. We clone
  // headers but drop a couple that Next fills in for us.
  if (!isHtmlResponse(contentType)) {
    const passthroughHeaders = new Headers(upstream.headers);
    passthroughHeaders.delete("content-encoding"); // already decoded by fetch
    passthroughHeaders.delete("content-length"); // Next will recompute
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: passthroughHeaders,
    });
  }

  // Slow path: pull HTML into memory so we can rewrite it.
  const rawHtml = await upstream.text();
  const shimBody = await loadShim();
  const patched = injectShim(rawHtml, buildShimTag(shimBody));

  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  // Kill every hint WKWebView might use to decide "this is unchanged
  // since last time" — we rewrite the body on each request, so any
  // validator from the upstream (cloudflare) is flat-out wrong for us.
  headers.delete("etag");
  headers.delete("last-modified");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");

  return new Response(patched, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
export const OPTIONS = handle;
export const HEAD = handle;
