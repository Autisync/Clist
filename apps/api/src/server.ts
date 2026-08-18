import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { getDb } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { templateRoutes } from "./routes/templates.js";
import { syncRoutes } from "./routes/sync.js";

export async function buildServer(): Promise<FastifyInstance> {
  await getDb(); // boot/migrate before accepting requests

  const app = Fastify({ logger: process.env.LOG === "1" });

  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: err.issues });
    }
    req.log?.error?.(err);
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: "internal_error", message });
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(templateRoutes);
  await app.register(syncRoutes);

  return app;
}
