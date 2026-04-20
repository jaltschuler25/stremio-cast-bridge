import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The Stremio shell loads its WebUI at `<origin>/cast-bridge/`.
   * The Stremio web app uses *relative* paths for every asset
   * (`81fdb…/scripts/main.js`), so the trailing slash is load-bearing:
   * strip it and the browser resolves those assets against `/` instead
   * of `/cast-bridge/`, bypassing our proxy. `trailingSlash: true`
   * stops Next from redirecting them away.
   */
  trailingSlash: true,
};

export default nextConfig;
