"use client";

/**
 * Polls /api/status on an interval so the control panel can show a
 * live view of the Stremio server + discovered cast devices without
 * requiring the user to refresh manually. Exposes `refresh()` so a
 * child component (e.g. the Launch button) can force an immediate
 * re-check after it does something that would change state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeStatus } from "@/lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: BridgeStatus }
  | { kind: "error"; message: string };

interface Options {
  /** Poll interval in ms. Defaults to 3000ms. */
  intervalMs?: number;
}

export function useBridgeStatus(options: Options = {}) {
  const { intervalMs = 3000 } = options;
  const [state, setState] = useState<State>({ kind: "loading" });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BridgeStatus;
      if (!mounted.current) return;
      setState({ kind: "ready", data });
    } catch (err) {
      if (!mounted.current) return;
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const iv = setInterval(refresh, intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(iv);
    };
  }, [intervalMs, refresh]);

  return { state, refresh } as const;
}
