export * from "./auth.js";
export * from "./template.js";
export * from "./sync.js";
export * from "./catalog.js";
export * from "./client.js";
export * from "./quote.js";
export * from "./job.js";
export * from "./checklist.js";
export * from "./equipment.js";
export * from "./photo.js";
export * from "./test-result.js";
export * from "./closeout.js";
export * from "./test-protocol-eval.js";
export * from "./ref.js";
export * from "./termo.js";
// deadlines.ts deliberately NOT re-exported here: it imports "date-holidays"
// (real per-country holiday data, a real payload), and this barrel is what
// apps/web's client bundles pull in wholesale via `from "@fieldready/core"`.
// addWorkingDays is server-only logic today (F17 deadline computation,
// apps/api/src/domain/deadlines.ts) — nothing in apps/web needs it, so
// keeping it out of the barrel keeps date-holidays out of the phone bundle
// entirely rather than relying on webpack tree-shaking it away (it doesn't
// — confirmed live: /field/jobs/[id]/tests went from ~20kB to ~223kB the
// moment this file entered the barrel, purely from an unrelated import
// chain reaching it). Import it directly from its own path instead:
// `@fieldready/core/src/deadlines.js` (packages/core has no `exports` map
// restricting subpath access, and the workspace symlink makes this resolve
// exactly like any other relative import).
