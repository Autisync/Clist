import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
// 127.0.0.1 is correct for every local use this app has today (dev, every
// proof/smoke script — all same-machine callers) but is NOT reachable from
// outside a container: confirmed empirically building and running the real
// Docker image (apps/api/Dockerfile) — the server booted and passed its own
// /health check from inside the container, yet was completely unreachable
// through Docker's published port from the host, exactly what binding to
// the loopback interface instead of all interfaces does. HOST lets a real
// deployment override this (the Dockerfile sets HOST=0.0.0.0) without
// changing anything about local dev's default.
const host = process.env.HOST ?? "127.0.0.1";

buildServer()
  .then((app) => app.listen({ port, host }))
  .then(() => {
    console.log(`[api] listening on http://${host}:${port}`);
  })
  .catch((err) => {
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
