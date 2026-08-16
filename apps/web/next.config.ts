import type { NextConfig } from "next";

// The desktop app serves this bundle and /api from one loopback origin, so a
// plain static export is all that is needed: no proxy, and no dev server.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
