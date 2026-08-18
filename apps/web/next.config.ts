import type { NextConfig } from "next";

// Proxy every /api/* request from the Next.js app to the Fastify API.
// This keeps all browser fetches same-origin (so the fr_session cookie is
// sent automatically) and means we never need CORS on the API side.
// See CLAUDE.md / apps/web build task: "apps/web talks to the API via a
// Next.js rewrite proxy, NOT direct cross-origin fetches."
const API_ORIGIN = process.env.FIELDREADY_API_ORIGIN || "http://127.0.0.1:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_ORIGIN}/:path*`,
      },
    ];
  },
};

export default nextConfig;
