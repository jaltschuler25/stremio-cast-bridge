/**
 * Thin wrappers around the already-working HTTP casting API baked into
 * Stremio's bundled streaming server. These are used by our Next.js
 * route handlers — the client-side shim talks to the server directly
 * because it needs to bypass CORS and wants the shortest network path.
 */
import { STREMIO_SERVER_URL } from "./constants";
import type { CastingDevice, CastPlayerStatus } from "./types";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Stremio server ${res.status} @ ${url}`);
  }
  return (await res.json()) as T;
}

export async function isServerReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${STREMIO_SERVER_URL}/settings`, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok || res.status === 307;
  } catch {
    return false;
  }
}

export async function listDevices(): Promise<CastingDevice[]> {
  return fetchJson<CastingDevice[]>(`${STREMIO_SERVER_URL}/casting/`);
}

export async function getPlayerStatus(
  devID: string
): Promise<CastPlayerStatus> {
  return fetchJson<CastPlayerStatus>(
    `${STREMIO_SERVER_URL}/casting/${encodeURIComponent(devID)}/player`
  );
}

/**
 * The Stremio server accepts player commands as query params on the
 * `/casting/:devID/player` endpoint (see Player.prototype.middleware).
 * Passing `source` starts playback, `paused=0|1` toggles, `time=<ms>`
 * seeks, `stop=1` stops, `volume=<0-100>` sets volume.
 */
export async function sendPlayerCommand(
  devID: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<CastPlayerStatus> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const url = `${STREMIO_SERVER_URL}/casting/${encodeURIComponent(
    devID
  )}/player?${qs.toString()}`;
  return fetchJson<CastPlayerStatus>(url, { method: "GET" });
}
