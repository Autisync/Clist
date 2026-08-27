import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

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
  // packages/core is consumed straight from source (package.json "main":
  // "./src/index.ts", no build step) and its own internals use NodeNext-
  // style ".js"-suffixed relative imports (e.g. `export * from "./auth.js"`
  // in index.ts) so tsx/tsc resolve them back to the real .ts files. Webpack
  // doesn't do that mapping by default — it looks for a literal auth.js.
  // Every prior apps/web import from @fieldready/core happened to be
  // type-only (erased before bundling, so webpack never needed to resolve
  // the real module graph); evalTest (field/jobs/[id]/tests) is the first
  // *value* import, which is what surfaces this. extensionAlias is the
  // standard Next.js fix for a monorepo package using NodeNext resolution.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

// withSentryConfig — adds source-map upload at build time (needs
// SENTRY_AUTH_TOKEN, org/project below, from sentry.io -> Settings ->
// Auth Tokens) and a couple of small runtime tunneling/tree-shaking
// options. Unset SENTRY_AUTH_TOKEN doesn't fail the build — the plugin's
// own documented behavior is to skip the upload step and warn, same
// "swap in when a real credential shows up" shape as everything else in
// this file. org/project match the ones the (TTY-incompatible, see
// sentry.server.config.ts) wizard command was invoked with.
export default withSentryConfig(nextConfig, {
  org: "autisync",
  project: "fieldready",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  webpack: {
    treeshake: { removeDebugLogging: true },
  },
});
