import type { NextConfig } from "next";

// Static export for Vercel. Cross-origin isolation (COOP/COEP) is required for
// Pyodide WASM threads; on a static host these ship as response headers via
// vercel.json (see vercel.json). next.config headers() only apply to the dev
// server, so we set them here too so `next dev` is also cross-origin isolated.
const coi = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
];

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: coi }];
  },
};

export default nextConfig;
