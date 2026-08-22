# @fieldready/web

The Next.js client for Phase 1+2's API: `/office/*` (desktop, office staff)
and `/field/*` (technician phone, offline-first), one App Router codebase
per architecture §2. Ports `fieldready-prototype.jsx`'s interaction design —
the phone flow especially — onto the real API, per CLAUDE.md's "treat its
interaction design as settled" rule: the screens, their order, and their
copy are unchanged; only mock state became real `fetch` calls, and the
visual language was restyled to the cyan/zinc technical identity from this
project's design pass (not the prototype's original slate/blue/purple).

## §6 Step 5 — Supabase-native cutover, in progress

This app is **mid-migration**, not fully cut over. Two independent auth/
data systems currently coexist on purpose, per
`08-supabase-native-migration.md` §6's own "no big-bang cutover" rule:

- **Office login** (`/login`) now calls real Supabase Auth
  (`signInWithPassword`) instead of `POST /auth/office/login`. `middleware.ts`
  accepts **either** a valid Supabase session **or** the original
  `fr_session` cookie for `/office/*` — not Supabase exclusively. A first
  version required Supabase for the whole tree and broke every
  still-Fastify-backed office page for anyone who'd only ever logged in the
  old way (caught by `test/smoke.mjs`, fixed — see the file's own comment).
- **Cut over to Supabase so far:** `/office/jobs` (the job list) and
  `/office/jobs/:id` (job detail — all three tabs: Readiness, Execução,
  After-action report) — real RLS-scoped reads of
  `job`/`client`/`v_job_readiness`/`job_checklist_item`, and every write
  (checklist toggle, dispatch, execution-step complete, test-result record,
  complete, close-out, rework-cause) now calls `supabase.rpc(...)` directly
  from the browser instead of a Fastify route. Two of those RPCs
  (`rpc_job_complete`, `rpc_closeout_set_rework_cause`) are new — see
  `apps/api/README.md`'s "Fastify→real-Postgres swap" section's sibling, the
  job-detail cutover writeup, for why `/jobs/:id/complete` needed one beyond
  the design doc's original six named candidates. **Photo upload is the one
  write on this page still Fastify-backed** (binary bytes, no Supabase
  Storage wiring yet — same "structurally can't be an RPC" reasoning as REF
  PDF generation and Veryfi OCR). Provisioning a real tenant + office login
  (no self-serve signup exists) is `apps/api/supabase/provision-tenant.mjs`.
- **Still entirely Fastify-backed:** clients, quotes, suppliers,
  technicians, and the dashboard. These depend on `fr_session` for their own
  data fetches and will 500 for a user who only has a Supabase session (no
  Fastify session at all) — this is the honest, expected state of an
  in-progress cutover, not a hidden regression. Each of these is a future
  slice, same one-page-at-a-time discipline as everything above.
- **Every RPC job detail's write actions call is already built and
  proven** (see `apps/api/README.md`'s Supabase-native section) — porting
  the pages above is wiring UI to RPCs that already exist and are already
  tested, not new backend work, with the one exception (`rpc_job_complete`)
  called out above.

`GET /manifest.json`, `sw.js`, and everything under `/field/*` are
completely untouched — technician/device auth is deliberately a separate,
later slice (design doc §2: "more novel, easier to get right in
isolation").

## Running it

Needs the API running separately — this app has no database of its own.

```bash
npm run dev:api     # terminal 1 — http://127.0.0.1:3001
npm run dev:web     # terminal 2 — http://127.0.0.1:3000
```

Demo logins, once both are up: office at `/login`
(`rex@antenas-piloto.pt` / `proof-pass-123`, the same Phase 1 fixture
`apps/api/README.md` uses); technician at `/field/login` needs a paired
device first — either through `/office/technicians` in the UI, or the same
`POST /auth/technician/pair` call `apps/api/README.md`/the proof scripts
use directly.

## How it talks to the API

Every fetch in this app — server or client — targets a same-origin
`/api/...` path. `next.config.ts`'s `rewrites()` proxies that to the real
API (`FIELDREADY_API_ORIGIN`, default `http://127.0.0.1:3001`). This is
deliberate, not incidental: it means the `fr_session` cookie is always
same-origin from the browser's point of view, so there's never a reason to
add CORS on the API side (`apps/api/src/server.ts` still has none).

**The one real App Router gotcha this app has to get right, everywhere:**
a Server Component's `fetch` does not automatically forward the browser's
cookies — `src/lib/api.ts`'s `serverApiFetch` reads the incoming request's
`fr_session` cookie via `next/headers` and attaches it by hand. Every page
that fetches server-side uses this, not the plain `apiFetch` (which is for
Client Components, where the browser sends cookies on its own).

**The other one:** `packages/core` is consumed straight from its TypeScript
source (no build step) and its internals use NodeNext-style `.js`-suffixed
relative imports, which `tsx`/`tsc` resolve back to the real `.ts` files
but webpack does not, by default. Every earlier page happened to import
only *types* from `@fieldready/core` (erased before bundling, so webpack
never needed to resolve the real module graph) — the first page to import
an actual *value* (`evalTest`, in `field/jobs/[id]/tests`) surfaced this.
Fixed in `next.config.ts` with the standard `resolve.extensionAlias`
webpack option, not by changing `packages/core` (which is correct as-is
for its other two consumers).

## Office (`/office/*`)

Clients, quotes (create → line-edit → accept → create-job), the job list,
and the job detail page's three tabs — Readiness (checklist by scope,
dispatch with the real `409` blocking-list rendered, not hidden behind a
generic error), Execução (steps, photo upload), and After-action report
(test results against the job's frozen `test_protocol_snapshot`, complete,
technician close-out display, and a separate, visually distinct
office-only `rework_cause` control — never the same form the technician
submits).

**Dashboard and Suppliers are real pages now (Phase 4 —
`07-phase4-cost-intelligence.md`), wired to real API data, not placeholders
any more.**

- **Dashboard** (`/office`, `page.tsx`) — the business-metrics card that
  used to say "coming in Phase 4" is now wired to the five real
  `GET /dashboard/*` endpoints, thin reads over `03-schema.sql`'s views;
  nothing on this page is hardcoded. Structure ported from
  `fieldready-prototype.jsx`'s `<Dashboard>`: the stat grid, the
  readiness-correlation headline insight, hours-variance-by-job-type and
  first-time-fix-trend charts (plain flexbox bars — no `recharts`
  dependency added), the price-alerts list, and recommended actions. Per
  CLAUDE.md/PRD, the numbers here are real as of this wiring, but the
  project's trust bar is on the dashboard's *conclusions* until 30+ real
  closed jobs exist — a data-volume fact, not a reason to withhold the code
  path, so small-sample sections say so plainly instead of hiding the
  (accurate) numbers.
- **Suppliers** (`/office/suppliers`) — a Server Component fetches the
  initial supplier list + catalog items; supplier selection, the price
  table, manual add-price form, and receipt upload/review/confirm are a
  client component, ported from the prototype's `<Suppliers>` (supplier
  card grid, selected-supplier detail with open-state, price table with a
  "Digitalizar recibo" action). Receipt confirmation is a genuinely
  selective UI: each parsed line can be checked/unchecked before
  `POST /receipts/:id/confirm`, and an unmatched ("sem correspondência")
  line is shown but can't be confirmed at all — matching the API's own
  refusal to write a price with no `item_id`.

## Field (`/field/*`) — the offline-first technician phone client

PIN login (device-bound, no password — architecture §7) → home (today's
assigned job) → prep (one checklist item per screen, exactly the
prototype's settled cycling interaction, not one route per item) →
prep-result → site (execution steps) → tests (per-outlet measurement,
photo capture with a manual-entry fallback that always works) → voice
(recorded note with a functional textarea fallback — voice is never
mandatory) → done.

**The prep-result "Passar por" supplier-pickup card is restored** (Phase 4 —
`07-phase4-cost-intelligence.md` §4): `prep-result/page.tsx` used to omit it
on purpose, by its own comment, because no sourcing API existed yet. Now
that `GET /jobs/:id/pickup-plan` exists, the page fetches it whenever the
job has missing materials and shows the best pickup option (same
`(items covered desc, open-now desc, total price asc)` ordering
`domain/sourcing.ts` computes server-side — the client renders, it doesn't
re-sort).

### The offline sync queue (`src/lib/offline-queue.ts`)

Architecture §4's Option B (custom queue), matching the exact wire
contract `apps/api/src/routes/sync.ts` already proves idempotent:

- `enqueueMutation()` writes to IndexedDB and returns **without ever
  awaiting a network call** — a tap on "Tenho"/an execution step/a test
  result/close-out feels instant regardless of connectivity, because it's
  a local write, not a request.
- `flushQueue()` fires on the browser `online` event and a 15s interval
  (`src/components/field/OutboxSync.tsx`, mounted once in
  `app/field/layout.tsx`). It only ever re-sends rows still marked
  `pending`; a failed or offline attempt leaves them `pending` for the
  next try rather than dropping them.
- `src/components/field/SyncStatus.tsx` — a persistent pill on every
  `/field/*` screen ("N por sincronizar" / "Sincronizado") — technician
  trust (PRD §6) depends on this being honest, not cosmetic.
- Binary uploads (photos, the voice recording — which reuses the photo
  endpoint with `phase="evidence"`, there being no dedicated audio route)
  go through a **direct multipart `fetch`**, never through the JSON
  mutation queue — `05-phase2-job-loop.md` §7's instruction, carried
  through here.
- `src/lib/bootstrap-cache.ts` caches `GET /sync/bootstrap` in IndexedDB so
  field pages can render from a cached snapshot on a cold, offline start,
  not just keep working once already loaded.
- `public/sw.js` (hand-written, no `next-pwa` dependency) + `manifest.json`
  give the `/field/*` app shell itself (routes, JS/CSS) an install-and-work-
  offline story on top of the data-layer queue above.

**Known limitation, stated plainly:** the queue's core properties
(enqueue never blocks on network; flush never re-sends synced rows; a
failed flush doesn't drop pending ones) are verified at the code level and
via `test/smoke.mjs`'s direct exercise of the exact `/api/sync/mutations`
contract through this app's proxy — real HTTP, both `applied` and
`already_applied` confirmed. What hasn't been done is a live
airplane-mode/browser-devtools-offline test; that needs a real browser
engine and a person, not something a script can honestly claim.

**A real bug this surfaced, fixed, not routed around:** live-testing the
full phone flow just now found that `POST /jobs/:id/closeout` (and the
`closeout.submit` mutation behind it) never set `job.completed_at` unless a
separate `POST /jobs/:id/complete` had been called first — which the phone
flow's settled screens (tests → voice → done, no distinct "mark complete"
tap) never do. Since `completed_at` starts Phase 3's statutory termo
deadline clock, every phone-closed job would have had that clock silently
never start. Fixed in `apps/api/src/domain/closeout.ts`:
`completed_at = coalesce(completed_at, now())`, confirmed against the real
running API before being committed.

## Proving it

```bash
npm run smoke:web       # from the repo root
```

`test/smoke.mjs` — same pattern as the API's proof scripts: spawns the real
API and the real production `next build`/`next start` output as child
processes, drives them with a cookie-jar HTTP client. Login (office and
technician), full quote → job → dispatch creation through the proxy (not
the API directly — this is what actually proves cookie forwarding works),
every `/field/*` route, the manifest/service-worker files, and the exact
sync contract `offline-queue.ts` depends on (`applied`, then
`already_applied` on replay). 23 checks, all passing as of this writing.

`npm run proof:phase1` / `npm run proof:phase2` / `npm run proof:phase3` /
`npm run proof:phase4` (the API's own exit criteria) are unaffected by
anything in this app and should stay that way — re-run them after touching
`apps/api`, not just `apps/web`.
