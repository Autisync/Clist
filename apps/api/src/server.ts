import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { getDb } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { templateRoutes } from "./routes/templates.js";
import { syncRoutes } from "./routes/sync.js";
import { catalogRoutes } from "./routes/catalog.js";
import { clientRoutes } from "./routes/clients.js";
import { supplierRoutes } from "./routes/suppliers.js";
import { receiptRoutes } from "./routes/receipts.js";
import { quoteRoutes } from "./routes/quotes.js";
import { jobRoutes } from "./routes/jobs.js";
import { vanAuditRoutes } from "./routes/van-audits.js";
import { equipmentRoutes } from "./routes/equipment.js";
import { followUpActionRoutes } from "./routes/follow-up-actions.js";
import { refRoutes } from "./routes/ref.js";
import { termoRoutes } from "./routes/termo.js";
import { complianceRoutes } from "./routes/compliance.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { technicianRoutes } from "./routes/technicians.js";
import { platformAdminRoutes } from "./routes/platform-admin.js";

export async function buildServer(): Promise<FastifyInstance> {
  await getDb(); // boot/migrate before accepting requests

  // trustProxy: true — both documented hosting paths (HOSTING.md's Traefik
  // setup, render.yaml's managed load balancer) put a real reverse proxy in
  // front of this process; without this, request.ip resolves to the
  // proxy's own container/network IP for every request, which would make
  // the per-IP rate limiting below effectively rate-limit ALL real traffic
  // together as a single client. Safe specifically because neither
  // documented deployment ever exposes this process's port directly to
  // the public internet — X-Forwarded-For is always proxy-set, never
  // attacker-set, in either topology.
  const app = Fastify({ logger: process.env.LOG === "1", trustProxy: true });

  await app.register(cookie);
  await app.register(multipart);
  // Rate limiting — production-readiness gap, no brute-force/abuse
  // protection existed before this. Global default is generous (this API
  // also serves the offline sync queue replaying a whole batch of queued
  // mutations at once, apps/web/src/lib/offline-queue.ts) — the real
  // protection is the much tighter per-route override on the
  // unauthenticated login endpoints below (routes/auth.ts), the actual
  // credential-guessing targets. allowList exempts loopback so the
  // existing proof/smoke suite (many rapid requests from the same
  // 127.0.0.1, phase1-4-proof.mjs etc.) stays unaffected and deterministic
  // — real traffic from a genuine external IP is never loopback once
  // trustProxy correctly resolves it.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    allowList: (req) => req.ip === "127.0.0.1" || req.ip === "::1",
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: err.issues });
    }
    req.log?.error?.(err);
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: "internal_error", message });
  });

  // Exempt entirely, not just loosely limited — hosting healthchecks
  // (Docker's own container healthcheck, HOSTING.md) poll this every few
  // seconds; a 429 here would read as "unhealthy" to the orchestrator and
  // could trigger an unwanted restart loop.
  app.get("/health", { config: { rateLimit: false } }, async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(templateRoutes);
  await app.register(syncRoutes);
  await app.register(catalogRoutes);
  await app.register(clientRoutes);
  await app.register(supplierRoutes);
  await app.register(receiptRoutes);
  await app.register(quoteRoutes);
  await app.register(jobRoutes);
  await app.register(vanAuditRoutes);
  await app.register(equipmentRoutes);
  await app.register(followUpActionRoutes);
  await app.register(refRoutes);
  await app.register(termoRoutes);
  await app.register(complianceRoutes);
  await app.register(dashboardRoutes);
  await app.register(technicianRoutes);
  await app.register(platformAdminRoutes);

  return app;
}
