// Object storage — 05-phase2-job-loop.md §7: "Photos need object storage;
// Phase 1's own pattern for 'no real infra available in this sandbox'
// (PGlite standing in for Postgres, apps/api/README.md) applies again here"
// — define a small ObjectStore interface with a local-filesystem
// implementation under RUNTIME_DIR/objects for dev/proof, swapped for real
// S3/R2 (architecture §2) at deploy time by changing this file only, same
// as db.ts already does for the database itself.
//
// Honest substitution, noted the same way db.ts notes PGlite standing in
// for a real Postgres server: there is no real object storage (S3/R2) in
// this dev environment, so put() returns the key itself, not a real URL —
// callers (job_photo.file, equipment.calibration_cert_file, ...) store that
// key and resolve it back through get() when they need the bytes. A real
// deployment swaps this file for an S3/R2-backed implementation whose
// put() returns a real object URL; nothing that calls ObjectStore needs to
// change.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR } from "./runtime-dir.js";

export interface ObjectStore {
  put(key: string, buffer: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const OBJECTS_DIR = path.join(RUNTIME_DIR, "objects");

class LocalFilesystemObjectStore implements ObjectStore {
  private keyPath(key: string): string {
    // Keys are server-generated uuids (routes/jobs.ts) — no path traversal
    // surface from client input, but guard against a stray separator
    // anyway rather than trusting that invariant silently.
    const safeKey = key.replace(/[/\\]/g, "_");
    return path.join(OBJECTS_DIR, safeKey);
  }

  async put(key: string, buffer: Buffer): Promise<string> {
    await mkdir(OBJECTS_DIR, { recursive: true });
    await writeFile(this.keyPath(key), buffer);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.keyPath(key));
  }
}

export const objectStore: ObjectStore = new LocalFilesystemObjectStore();
