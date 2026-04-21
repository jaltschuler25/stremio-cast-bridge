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
import { readFile, readdir } from "node:fs/promises";
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
 * Returns the path + version string or null.
 */
const STREMIO_BUNDLE_IDS = [
  "com.westbridge.stremio5-mac",
  "com.stremio.stremio-shell-macos",
] as const;

async function findStremio5App(): Promise<{
  path: string;
  version: string | null;
} | null> {
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
      if (!STREMIO_BUNDLE_IDS.some((id) => plist.includes(id))) continue;
      const versionMatch = plist.match(
        /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
      );
      return {
        path: join("/Applications", entry),
        version: versionMatch ? versionMatch[1] : null,
      };
    }
  } catch {
    /* ignore — directory might not exist in tests */
  }
  return null;
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
