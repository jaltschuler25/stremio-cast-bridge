/**
 * Renders the currently-discovered cast targets. The user doesn't
 * *interact* with devices here — that happens inside Stremio via the
 * shim — but seeing the list before launching is a good sanity check
 * that MDNS/SSDP discovery is working.
 */
import type { CastingDevice } from "@/lib/types";

interface Props {
  devices: CastingDevice[];
}

export function DeviceList({ devices }: Props) {
  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-white/[.02] p-6 text-sm text-slate-400">
        No cast targets found yet. Make sure your Chromecast / smart TV is on
        the same Wi-Fi and that macOS has granted Stremio Local Network
        permission on first launch.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5 bg-white/[.02]">
      {devices.map((device) => (
        <li
          key={device.id}
          className="flex items-center gap-4 px-4 py-3 text-sm"
        >
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
            {iconFor(device.type)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-slate-100">
              {device.name}
            </div>
            <div className="truncate text-xs text-slate-500">
              {device.type} · {device.host || device.location} ·{" "}
              {device.facility}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function iconFor(type: string): string {
  switch (type) {
    case "chromecast":
      return "📺";
    case "tv":
      return "📡";
    default:
      return "🔈";
  }
}
