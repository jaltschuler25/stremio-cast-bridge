/**
 * POST /api/launch
 *
 * Launches Stremio 5 with `--webui-url=http://localhost:<port>/cast-bridge/`
 * so the shell loads our shimmed copy of the web UI instead of the
 * broken vanilla one. We fork/detach the process so killing Next.js
 * doesn't also kill Stremio.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CAST_BRIDGE_MOUNT } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build the public origin (scheme + host + port) this Next.js server
 * is reachable at, using the Next request's internal URL — not the
 * Host header — so it keeps working regardless of proxies. We force
 * `127.0.0.1` instead of the request hostname because the Stremio
 * shell's WebView and our Next server both live on the same box and
 * any other value would fail if the user used a LAN IP in the browser.
 */
function originFromRequest(req: NextRequest): string {
  const port = req.nextUrl.port || "36970";
  return `http://127.0.0.1:${port}`;
}

/**
 * Stremio has shipped the v5 macOS shell under two different bundle
 * identifiers over the life of the beta — older builds use
 * `com.westbridge.stremio5-mac`, while the current Stremio-signed
 * DMG (`dl.strem.io/stremio-shell-macos/…`) uses
 * `com.stremio.stremio-shell-macos`. We accept either so the cast
 * bridge keeps working across upgrades.
 */
const STREMIO_BUNDLE_IDS = [
  "com.westbridge.stremio5-mac",
  "com.stremio.stremio-shell-macos",
] as const;

async function resolveStremioBundle(): Promise<{
  bundlePath: string;
  binary: string;
  bundleId: string;
} | null> {
  try {
    const entries = await readdir("/Applications");
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const plistPath = join("/Applications", entry, "Contents", "Info.plist");
      let plist = "";
      try {
        plist = await readFile(plistPath, "utf8");
      } catch {
        continue;
      }
      const matchedId = STREMIO_BUNDLE_IDS.find((id) => plist.includes(id));
      if (!matchedId) continue;
      const exeMatch = plist.match(
        /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/
      );
      const exeName = exeMatch ? exeMatch[1] : "Stremio";
      const bundlePath = join("/Applications", entry);
      return {
        bundlePath,
        binary: join(bundlePath, "Contents", "MacOS", exeName),
        bundleId: matchedId,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Nuke the caches that otherwise let WKWebView serve a pre-bridge
 * version of the Stremio HTML (and the SW that shipped with it) on
 * relaunch. We do this BEFORE spawning the shell so the first load
 * is guaranteed to come from our proxy.
 *
 * Critically scoped: we only touch HTTP cache, Cache-API storage,
 * and registered Service Workers. LocalStorage + IndexedDB are left
 * alone because Stremio stores installed addons, library, and user
 * settings there — wiping them would factory-reset Stremio each
 * launch, which is what broke "addons don't persist" before.
 */
async function wipeWebViewCache(bundleId: string): Promise<void> {
  const home = homedir();
  // WebKit namespaces its on-disk caches by the host app's bundle
  // identifier, so we scope the wipe to whichever Stremio variant
  // we actually found (see STREMIO_BUNDLE_IDS above).
  const cacheRoot = join(home, `Library/Caches/${bundleId}/WebKit`);
  const dataRoot = join(home, `Library/WebKit/${bundleId}/WebsiteData`);

  // Safe to wipe outright.
  const topLevelTargets = [
    join(cacheRoot, "NetworkCache"),
    join(cacheRoot, "CacheStorage"),
  ];

  // Per-origin caches live at WebsiteData/Default/<salt>/<salt>/(
  // CacheStorage | ServiceWorkers). Glob two levels deep and wipe
  // only those two subfolders; LocalStorage stays untouched.
  const perOriginTargets: string[] = [];
  const defaultDir = join(dataRoot, "Default");
  try {
    const stat1 = await stat(defaultDir);
    if (stat1.isDirectory()) {
      for (const l1 of await readdir(defaultDir)) {
        const l1Path = join(defaultDir, l1);
        try {
          for (const l2 of await readdir(l1Path)) {
            const l2Path = join(l1Path, l2);
            perOriginTargets.push(
              join(l2Path, "CacheStorage"),
              join(l2Path, "ServiceWorkers")
            );
          }
        } catch {
          // not a dir, skip
        }
      }
    }
  } catch {
    // no Default dir yet — first launch. fine.
  }

  await Promise.all(
    [...topLevelTargets, ...perOriginTargets].map((p) =>
      rm(p, { recursive: true, force: true }).catch(() => {})
    )
  );
}

/**
 * macOS LaunchServices will *activate* the existing Stremio instance
 * if it's already running, silently swallowing any --args we passed.
 * Kill it first so our `open -n` spawns a brand-new process bound to
 * our --webui-url.
 *
 * We pkill by the bundle's absolute MacOS path so the pattern matches
 * BOTH the Rust shell binary AND its node `server.js` child (whose
 * cmdline also contains the app path). Leaving the child alive would
 * orphan it, keep port 11470 bound, and cause the freshly-spawned
 * server.js to silently fail to start — manifests as the cast chooser
 * spinning forever on "searching…".
 */
async function killExistingShell(bundlePath: string): Promise<void> {
  const macosDir = join(bundlePath, "Contents", "MacOS");
  await new Promise<void>((resolve) => {
    const p = spawn("pkill", ["-f", macosDir], { stdio: "ignore" });
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
  // Poll :11470 until it's actually free (up to ~5s) before letting
  // the caller spawn a new Stremio. Without this, the new server.js
  // can race against the dying one and refuse to bind.
  for (let i = 0; i < 20; i++) {
    const inUse = await new Promise<boolean>((resolve) => {
      const s = spawn("nc", ["-z", "127.0.0.1", "11470"], { stdio: "ignore" });
      s.on("close", (code) => resolve(code === 0));
      s.on("error", () => resolve(false));
    });
    if (!inUse) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const found = await resolveStremioBundle();
  if (!found) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Could not find the Stremio 5 app. Install it into /Applications first.",
      },
      { status: 404 }
    );
  }

  await killExistingShell(found.bundlePath);
  await wipeWebViewCache(found.bundleId);

  // Resolve the bridge's own public URL from the inbound request so
  // this keeps working even when Next fell back to a non-default
  // port (e.g. 36972 because something else grabbed the default first).
  const origin = originFromRequest(req);
  const webuiUrl = `${origin}${CAST_BRIDGE_MOUNT}/`;

  // Use `open -n` (new-instance) so macOS LaunchServices doesn't
  // just foreground an existing Stremio window with the default URL.
  const child = spawn(
    "/usr/bin/open",
    ["-n", found.bundlePath, "--args", `--webui-url=${webuiUrl}`],
    { detached: true, stdio: "ignore" }
  );
  child.unref();

  return NextResponse.json({
    ok: true,
    pid: child.pid,
    binary: found.binary,
    bundlePath: found.bundlePath,
    webuiUrl,
  });
}
