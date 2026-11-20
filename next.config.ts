import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Baseline hardening only. A full Content-Security-Policy is deferred until the
// shell and auth flows exist (see docs/10-SECURITY.md and ADR-013).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Pin the workspace root so stray lockfiles in parent directories are ignored.
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
