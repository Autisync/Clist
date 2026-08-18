// Shared by db.ts and fixtures.ts — split into its own module so those two
// don't import each other (db.ts -> fixtures.ts for seeding, fixtures.ts ->
// here for the path, not back to db.ts) and create a circular import.

import path from "node:path";
import os from "node:os";

// Runtime (database + generated fixture-id) files live outside the repo
// folder on purpose: this repo is a host-machine mounted folder in the dev
// sandbox this was built in, and that mount doesn't reliably support
// unlinking PGlite's on-disk files (confirmed empirically — cleanup/rm
// operations threw EPERM against it). Any real OS temp dir behaves
// normally. Override with FIELDREADY_RUNTIME_DIR if you want it elsewhere
// (the proof script uses this to point at a dedicated, disposable dir).
export const RUNTIME_DIR = process.env.FIELDREADY_RUNTIME_DIR
  ?? path.join(os.tmpdir(), "fieldready-dev");
