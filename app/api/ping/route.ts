/**
 * GET /api/ping
 *
 * Telemetry heartbeat used by the injected shim so we can see
 * (via the Next.js server log) exactly when the shim booted and
 * which lifecycle milestones it reached. Purely diagnostic —
 * nothing consumes the response body.
 *
 * Query params the shim includes:
 *   stage   — one of `boot`, `cast-kick`, `request-session`,
 *             `session-start`, `session-end`, `error`
 *   msg     — optional free-form message
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const stage = req.nextUrl.searchParams.get("stage") ?? "unknown";
  const msg = req.nextUrl.searchParams.get("msg") ?? "";
  console.log(`[shim] ${stage}${msg ? " — " + msg : ""}`);
  return NextResponse.json({ ok: true });
}
