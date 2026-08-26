import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
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

  const app = Fastify({ logger: process.env.LOG === "1" });

  await app.register(cookie);
  await app.register(multipart);

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
