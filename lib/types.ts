/**
 * Shape of a device entry as returned by the Stremio server's
 * `GET /casting/` endpoint. Kept permissive because extra fields may
 * appear in future server builds and we do not want to break the UI.
 */
export interface CastingDevice {
  id: string;
  name: string;
  host: string;
  location: string;
  type: "chromecast" | "tv" | "external" | string;
  icon: string;
  facility: "MDNS" | "SSDP" | "External" | string;
  playerUIRoles?: string[];
  usePlayerUI?: boolean;
  onlyHtml5Formats?: boolean;
}

/**
 * Simplified status snapshot used by the control panel and the shim.
 * All fields are optional because the server may respond mid-load.
 */
export interface CastPlayerStatus {
  time?: number;
  length?: number;
  paused?: boolean;
  volume?: number;
  source?: string | null;
  subtitlesSrc?: string | null;
  audioTrack?: string | null;
}

/**
 * Our bridge's overall health report — the UI uses this to tell the
 * user whether everything is wired up correctly before they launch.
 */
export interface BridgeStatus {
  serverReachable: boolean;
  serverUrl: string;
  devices: CastingDevice[];
  stremioAppPath?: string | null;
  stremioAppVersion?: string | null;
}
