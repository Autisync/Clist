import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);

buildServer()
  .then((app) => app.listen({ port, host: "127.0.0.1" }))
  .then(() => {
    console.log(`[api] listening on http://127.0.0.1:${port}`);
  })
  .catch((err) => {
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
