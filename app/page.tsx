"use client";

/**
 * Control panel home page.
 *
 * Intentionally minimal — just enough to tell the user whether
 * everything is wired up and give them a one-click path to launch
 * Stremio 5 with our cast bridge active. All of the heavy lifting
 * happens inside the injected shim.
 */
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { DeviceList } from "@/components/DeviceList";
import { LaunchButton } from "@/components/LaunchButton";
import { StatusPill } from "@/components/StatusPill";

export default function HomePage() {
  const { state, refresh } = useBridgeStatus();

  const data = state.kind === "ready" ? state.data : null;
  const serverUp = !!data?.serverReachable;
  const appFound = !!data?.stremioAppPath;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-16 text-slate-100">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Stremio 5 Cast Bridge
        </h1>
        <p className="text-sm text-slate-400">
          Re-enables the greyed-out Chromecast button in the Stremio 5 Mac
          ARM beta by intercepting the Google Cast API calls the WebView
          can't fulfil and routing them through Stremio&apos;s own streaming
          server (which already speaks Chromecast).
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Prerequisites
        </h2>
        <ul className="space-y-2 rounded-xl border border-white/5 bg-white/[.02] p-4 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span>
              Stremio streaming server on <code>localhost:11470</code>
            </span>
            <StatusPill tone={serverUp ? "ok" : "bad"}>
              {serverUp ? "Reachable" : "Not reachable"}
            </StatusPill>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>
              Stremio 5 app bundle
              {data?.stremioAppVersion ? ` (v${data.stremioAppVersion})` : ""}
            </span>
            <StatusPill tone={appFound ? "ok" : "warn"}>
              {appFound ? "Found" : "Not found"}
            </StatusPill>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>Discovered cast targets</span>
            <StatusPill tone={data?.devices.length ? "ok" : "info"}>
              {data?.devices.length ?? 0}
            </StatusPill>
          </li>
        </ul>
        {!serverUp && (
          <p className="text-xs text-amber-300">
            Start Stremio 5 once so the bundled server boots, then come
            back here — we only need it running in the background.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Devices visible to Stremio
        </h2>
        {data ? (
          <DeviceList devices={data.devices} />
        ) : (
          <div className="h-24 animate-pulse rounded-xl bg-white/[.02]" />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Launch
        </h2>
        <LaunchButton disabled={!serverUp || !appFound} onLaunched={refresh} />
        <p className="text-xs text-slate-500">
          This runs{" "}
          <code>
            Stremio.app --webui-url=http://127.0.0.1:36970/cast-bridge/
          </code>{" "}
          so the shell loads the shimmed WebUI served by this Next.js
          server.
        </p>
      </section>
    </main>
  );
}
