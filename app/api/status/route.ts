/**
 * GET /api/status
 *
 * One-shot health check consumed by the control panel.
 * - confirms the Stremio streaming server is reachable on :11470
 * - lists discovered cast targets so the user can sanity-check that
 *   their TV is visible *before* they launch the patched Stremio
 * - locates the installed Stremio 5 app bundle so the launcher knows
 *   exactly which binary to exec
 */
import { NextResponse } from "next/server";
import { readFile, readdir, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { STREMIO_SERVER_URL } from "@/lib/constants";
import { isServerReachable, listDevices } from "@/lib/stremio-server";
import type { BridgeStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Walk /Applications looking for a bundle whose Info.plist identifier
 * matches either of the two Stremio 5 Mac bundle IDs shipped during
 * the beta — older builds use `com.westbridge.stremio5-mac`, newer
 * Stremio-signed builds use `com.stremio.stremio-shell-macos`.
 *
 * When both are installed, prefer the one whose WebKit data dir is
 * largest (= the Stremio the user has actually populated with addons
 * and login). Mirrors the same logic in /api/launch's
 * resolveStremioBundle() so the status panel always reports the same
 * app the launcher would open.
 */
const STREMIO_BUNDLE_IDS = [
  "com.westbridge.stremio5-mac",
  "com.stremio.stremio-shell-macos",
] as const;

async function webkitDataSize(bundleId: string): Promise<number> {
  const dir = join(
    homedir(),
    "Library",
    "WebKit",
    bundleId,
    "WebsiteData"
  );
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(p);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(p, name);
      try {
        const s = await fsStat(full);
        if (s.isDirectory()) await walk(full);
        else total += s.size;
      } catch {
        /* ignore */
      }
    }
  };
  await walk(dir);
  return total;
}

async function findStremio5App(): Promise<{
  path: string;
  version: string | null;
} | null> {
  type Match = { path: string; version: string | null; bundleId: string };
  const matches: Match[] = [];
  try {
    const entries = await readdir("/Applications");
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const plistPath = join("/Applications", entry, "Contents", "Info.plist");
      let plist: string;
      try {
        plist = await readFile(plistPath, "utf8");
      } catch {
        continue;
      }
      const matchedId = STREMIO_BUNDLE_IDS.find((id) => plist.includes(id));
      if (!matchedId) continue;
      const versionMatch = plist.match(
        /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
      );
      matches.push({
        path: join("/Applications", entry),
        version: versionMatch ? versionMatch[1] : null,
        bundleId: matchedId,
      });
    }
  } catch {
    /* ignore — directory might not exist in tests */
  }
  if (matches.length === 0) return null;

  const pinned = process.env.STREMIO_BUNDLE_ID;
  if (pinned) {
    const hit = matches.find((m) => m.bundleId === pinned);
    if (hit) return { path: hit.path, version: hit.version };
  }

  const sized = await Promise.all(
    matches.map(async (m) => ({ m, size: await webkitDataSize(m.bundleId) }))
  );
  sized.sort((a, b) => b.size - a.size);
  return { path: sized[0].m.path, version: sized[0].m.version };
}

export async function GET(): Promise<Response> {
  const reachable = await isServerReachable();
  const devices = reachable ? await listDevices().catch(() => []) : [];
  const app = await findStremio5App();

  const body: BridgeStatus = {
    serverReachable: reachable,
    serverUrl: STREMIO_SERVER_URL,
    devices,
    stremioAppPath: app?.path ?? null,
    stremioAppVersion: app?.version ?? null,
  };
  return NextResponse.json(body);
}
