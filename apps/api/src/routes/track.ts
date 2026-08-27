// Client-facing portal — the one half of this feature that genuinely
// needs a Fastify route: photo BYTES, same "binary data can't go through
// a plain RPC" reasoning as photo upload/receipt images/REF PDFs
// elsewhere in this app. The job status + photo METADATA lookup itself
// (fn_track_job, rpc.sql) is a plain Supabase RPC apps/web calls directly
// — no route needed for that half at all.
//
// Deliberately NOT registered behind requireAuth (server.ts) — a client
// viewing this link has no Supabase session, no login, by design. The
// token itself (job.client_access_token, an unguessable random uuid) is
// the entire access-control mechanism: every query below checks it
// explicitly, the same discipline fn_track_job's own rpc.sql comment
// documents for the metadata half of this same feature.
//
// withPublicSchema is required here, not withTenant — there is no tenant
// context to resolve at all for an anonymous caller (req.auth doesn't
// exist on this route), so this always reads public.* directly via the
// trusted connection, matching every other real-data fix this session
// already made to this class of route.

import type { FastifyInstance } from "fastify";
import { withPublicSchema } from "../db.js";
import { objectStore } from "../object-store.js";

// A bare UUID regex check before ever binding into a `uuid`-typed SQL
// parameter — without this, a non-uuid path segment (a stray bot request,
// a fat-fingered link) would reach Postgres and come back as a raw type-
// cast error (500), not the clean 404 a not-found/malformed token should
// be.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous but bounded — a real client viewing their own job's photo
// gallery might load a handful of images in quick succession; this just
// keeps an anonymous, token-gated route from being a wide-open scraping
// target for anyone who somehow acquires a token.
const TRACK_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

// Sniffed from magic bytes, not stored anywhere — job_photo has no
// mimetype column (a real, pre-existing gap this feature's own
// investigation surfaced: there was no photo-viewing code path anywhere
// in this app before this file, so nothing ever needed one). PNG/JPEG
// cover every format this app's own upload flows actually produce
// (camera captures and the test fixtures' own PNGs); anything else
// degrades to a generic binary type rather than guessing wrong.
function sniffContentType(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

export async function trackRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string; photoId: string } }>(
    "/track/:token/photos/:photoId",
    TRACK_RATE_LIMIT,
    async (req, reply) => {
      const { token, photoId } = req.params;
      if (!UUID_RE.test(token) || !UUID_RE.test(photoId)) {
        return reply.code(404).send({ error: "not_found" });
      }

      const row = await withPublicSchema((db) =>
        db.query<{ file: string }>(
          `select jp.file
           from job_photo jp
           join job j on j.id = jp.job_id
           where j.client_access_token = $1 and jp.id = $2;`,
          [token, photoId]
        )
      );
      if (row.rows.length === 0) return reply.code(404).send({ error: "not_found" });

      let buffer: Buffer;
      try {
        buffer = await objectStore.get(row.rows[0].file);
      } catch (err) {
        req.log?.warn?.({ err }, "track: photo row exists but its object-store file is missing");
        return reply.code(404).send({ error: "not_found" });
      }

      reply.header("content-type", sniffContentType(buffer));
      // A capability URL is exactly the kind of thing that must never be
      // cached by a shared/intermediate cache keyed only on the path —
      // no-store is the correct, conservative choice for anything gated
      // by a token instead of a real auth header.
      reply.header("cache-control", "private, no-store");
      return reply.send(buffer);
    }
  );
}
