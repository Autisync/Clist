# FieldReady — Supabase-native migration design

v1.0 · Not started. This is a design document, reviewed before any implementation, per
the same discipline `05`/`06`/`07-phase-N.md` used before their phases were built —
except this one gets a stop for explicit sign-off before code, because it replaces the
thing every one of those four phases' isolation guarantees rests on, not adds a
capability alongside them.

**Scope, stated plainly:** the browser (both `/office/*` and `/field/*`) starts talking
to Postgres directly via Supabase's client SDK and the `anon` key, authenticated by
Supabase Auth, with row-level security as the *only* access control for data reads and
writes. Fastify shrinks to whatever genuinely cannot run as a Postgres function or in
the browser: Playwright PDF rendering, Veryfi's signed OCR calls, and (a judgment call
made explicit in §4) two pieces of multi-table business logic ported to `plpgsql` RPCs
rather than either.

This is not a reskin of the existing architecture. It is a different trust model:
today, the *only* thing that can ever read or write tenant data is Fastify, running as
a role nothing external can reach, deciding what's allowed in TypeScript before SQL ever
runs. After this migration, the browser itself is a first-class Postgres client, and
`03-schema.sql`'s RLS policies are the entire security boundary — not "backed up by"
RLS the way they are today (`02-ARCHITECTURE.md` §3: *"RLS is what's relied on if
[application-layer filtering] is ever forgotten"* — that sentence describes RLS as a
safety net under app-layer checks; after this migration there is no app layer to forget
anything in, for most tables).

---

## 1. Why this is harder than "point db.ts somewhere else"

`apps/api/src/db.ts`'s own comment already anticipated *a* Postgres swap — real Fly
Postgres/Neon instead of PGlite, same connection setup, same everything else. That
swap is still available and would have been a one-file change. This migration is a
different thing entirely: it moves *who is allowed to run a query at all* from "a
trusted backend that already decided" to "whatever the database itself can verify from
a JWT." Two consequences that don't have a mechanical answer:

1. **Every RLS policy changes shape.** Today: `tenant_id = current_setting('app.current_tenant_id')::uuid` — one value, set once per transaction by code that already authenticated the caller. After: the policy itself has to derive tenant + role from `auth.uid()`, for two structurally different identities (office `app_user` rows vs. paired `technician_device` rows) that don't currently share an identity column at all.
2. **Every multi-step, multi-table write loses its transaction boundary unless it's ported to a function.** Today, `domain/dispatch-gate.ts`, `domain/job-creation.ts`, `domain/closeout.ts` etc. run as one Postgres transaction inside a Fastify request. A browser calling `supabase.from(...).update(...)` three times in a row for what used to be one transaction is three separate statements — a crash or lost connection between them leaves partial state a trusted-backend design never had to consider.

Everything below is either solving one of those two problems for real, or naming the
places where the honest answer is "this one piece has to stay a server call."

## 2. Identity — the technician-PIN problem, resolved concretely

Supabase Auth has no "4-digit PIN bound to one paired device" primitive. Two real
options were considered:

- **Custom JWT minting** (Fastify signs its own JWT with Supabase's project JWT secret,
  client uses it directly with the Supabase SDK). Rejected: reintroduces exactly the
  server-in-the-loop-at-login dependency this migration is meant to remove, for no
  real gain over the option below, and means hand-managing token refresh instead of
  letting Supabase's client SDK do it.
- **Each paired device is its own Supabase Auth user.** Chosen. Concretely:

```
technician_device.auth_user_id  uuid references auth.users(id)   -- new column
```

Pairing flow, revised: office calls a **small, unavoidably server-side** endpoint
(`POST /devices/pair` stays in Fastify — this is the one place a server call remains
for auth, because creating a Supabase Auth user requires the `service_role` key, which
can never reach the browser). That endpoint:

1. Calls Supabase Auth's Admin API (`supabase.auth.admin.createUser`) with a synthetic
   identity — `email: "<technician_device.id>@device.fieldready.internal"`,
   `password: <the 4-digit PIN>`, `email_confirm: true` (no real email is ever sent).
2. Inserts the `technician_device` row with `auth_user_id` set to the new user's id.

From then on, the device signs in **directly against Supabase**, no Fastify
involvement: `supabase.auth.signInWithPassword({ email: syntheticEmail, password: pin })`.
The phone UI still only ever shows a 4-digit keypad — the synthetic email is an
implementation detail the technician never sees, stored alongside `deviceId` the same
way `apps/web`'s existing `fr_device_id` localStorage value is today.

**Real friction to resolve before this works:** Supabase's default password policy
(Auth settings → Password requirements) very likely rejects a bare 4-digit string as too
short. Two ways to reconcile a genuinely 4-digit technician UX with that: (a) lower the
project's minimum password length (defensible — this "password" is a second factor
bound to one device row, not a standalone credential, exactly as the current
`technician_device` comment already frames it), or (b) keep the UI at 4 digits but
derive a longer actual secret client-side (`pin + deviceId`, or similar) before calling
Supabase, so the entered PIN never has to satisfy Supabase's policy directly. **(a) is
recommended** — simpler, no derived-secret logic to get subtly wrong, and the security
property (an attacker needs the specific paired device, not just any browser, since the
synthetic email itself isn't discoverable/guessable at scale) doesn't meaningfully
change either way.

**Revocation, the sharper edge:** today, `POST /auth/technician/revoke/:device_id` sets
`revoked_at` and every subsequent request is rejected because Fastify checks it on
every call. A Supabase Auth session token, once issued, stays valid until it expires on
its own — RLS does not automatically know a device was revoked. Two things are both
required, not either/or:

1. Revoking a device also calls `supabase.auth.admin.signOut(auth_user_id, 'global')`
   (invalidates that user's current refresh tokens) — closes the common case.
2. **Every technician-scoped RLS policy explicitly re-checks `revoked_at is null`** as
   part of its condition (§3 below), not just at sign-in — closes the case where a
   short-lived access token issued before revocation is still technically unexpired.
   This is the one place this migration should be *more* paranoid than the system it's
   replacing, not equally so — the current design gets this for free (every request
   re-authenticates through Fastify); the new one has to earn it explicitly.

Office users: simpler, no synthetic identity needed. `app_user.id` becomes a Supabase
Auth user directly (an `auth_user_id` column, or — cleaner — migrate `app_user.id`
itself to equal the Supabase-issued `auth.users.id` for office rows, since there's no
competing identity to reconcile the way devices have). `password_hash` (bcrypt) is
retired; Supabase Auth owns the credential. Existing office users need a real migration
step (§6) — Supabase Auth's Admin API can create a user with a *known* password, but
not import an existing bcrypt hash directly, so this is a "reset on cutover" moment,
not a silent one.

## 3. RLS — every policy, twice as complex, and it has to stay provably correct

`03-schema.sql` §12's loop currently RLS-covers 22 tables plus `template`/
`template_version` (handled separately, §12's own comment explains why — system-layer
rows need to stay visible cross-tenant). All 24 need a new policy shape. The generic
loop's single `USING`/`WITH CHECK` clause today:

```sql
using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
```

becomes something that resolves tenant_id through one of two identity paths depending
on who's asking. Concretely, a helper function (not repeated inline 24 times):

```sql
create or replace function fn_current_tenant_id() returns uuid
language sql stable security definer as $$
  select coalesce(
    (select tenant_id from app_user where id = auth.uid()),
    (select au.tenant_id
       from technician_device td
       join app_user au on au.id = td.user_id
      where td.auth_user_id = auth.uid()
        and td.revoked_at is null)   -- the revocation re-check from §2, enforced here,
                                       -- not trusted to have happened somewhere upstream
  );
$$;
```

Every policy becomes `using (tenant_id = fn_current_tenant_id())`, same shape as today's
loop, one function to get right instead of 24 inline expressions to get right
identically — deliberately structured so a mistake has one place to hide, not 24.
`security definer` is required (the function needs to read `app_user`/`technician_device`
regardless of the RLS on those tables themselves, or it couldn't resolve identity in the
first place) — this is the one place in the whole schema where a function intentionally
runs with elevated rights, and it should be the *only* one; anything else needing
elevated access is a design smell worth stopping on.

**This needs the exact same proof rigor `verify-schema.mjs` already applies, run again
from scratch against every table** — the two-tenant cross-visibility check, the
fail-safe-with-no-context check (now: no `auth.uid()`, i.e. an anon/unauthenticated
request — must return zero rows, not error out in a way that leaks whether a row
exists), and specifically a **revoked-device-with-a-still-valid-token** check that
doesn't exist in the current suite at all, because the current design doesn't need it.
Do not consider this migration proven on "the existing 14 checks still pass" — several
of those checks are checking mechanisms (`current_setting`) that won't exist anymore;
they need to be *rewritten*, not carried over, and a rewritten check that quietly stops
testing what it used to test is worse than an honest gap.

## 4. What moves to RPC functions, what stays a server call, and why each one

Ported to `plpgsql` functions (`supabase.rpc(...)` from the client) — chosen over
either "reimplement as multiple client-side calls" (loses the transaction boundary,
§1) or "leave as a Fastify route" (defeats the point of this migration for the
highest-traffic paths):

- **The five sync mutation types** (`checklist_item.update`, `execution_step.complete`,
  `test_result.record`, `closeout.submit`, `van_audit.record`) — one RPC function each,
  each doing the *exact* `applied_mutation` lookup-then-apply-then-insert sequence
  `apps/api/src/routes/sync.ts`'s `applyMutation` already implements (read it before
  writing any of these — the pattern must transfer literally, not be reinvented), as one
  atomic function body. This is what makes the SIGKILL-mid-sync idempotency guarantee,
  proven three times already this session (Phase 1, Phase 2, and Phase 2's proof
  extended to a real domain mutation), still hold: the guarantee was always "one
  Postgres transaction, keyed on a client-generated id" — that property is fully
  preserved by an RPC function, and fully broken by three sequential `.update()` calls
  from the browser.
- **`dispatch_job(job_id)`** (today's `domain/dispatch-gate.ts`) — the four-condition
  check plus the status flip needs to happen atomically or a client could observe (or
  worse, act on) a job that passed the gate a moment ago but no longer would. A `plpgsql`
  function returning the same `{ok, blocking}` shape the current route does.
- **`create_job_from_quote(quote_id)`** (today's `domain/job-creation.ts`) — the
  checklist-snapshot resolution genuinely benefits from staying one atomic operation
  (template resolution + row materialization + quote-line merge as one transaction, same
  reasoning `architecture §5`'s "resolved once" rule already gives); reimplementing this
  as a sequence of client `INSERT`s risks a half-created job on any interruption.

Stays a Fastify route, not moved, not ported to a function — because it structurally
can't be either:

- **REF PDF generation** — needs a real headless-browser process (Playwright). Neither
  Postgres nor a browser tab can run one.
- **Receipt OCR (Veryfi)** — `CLIENT_SECRET`-based HMAC request signing (per this
  session's earlier research) must never be computable from something the browser holds.
  A small Fastify endpoint remains the only thing that ever sees Veryfi credentials,
  same reasoning that already put `receiptOcrProvider` behind a server-only interface
  in Phase 4.
- **F17 statutory deadlines** (`date-holidays`, a Node package) — recommend
  *replacing* the npm dependency with a `pt_holiday(date, name, kind)` table, populated
  once (a migration/seed step, regenerable yearly) rather than kept as a server call at
  all. A pure-SQL `add_working_days(from_date, days)` function against that table then
  needs nothing server-side — this is a case where the migration makes something
  *better*, not just relocated: `date-holidays`' npm dependency goes away entirely, and
  the barrel-export bundle-leak bug this session already found once (Phase 3,
  `packages/core/src/index.ts`) becomes structurally impossible for this specific
  dependency, because there's no JS holiday library left to accidentally bundle.

## 5. What packages/core's Zod schemas are for, after this

Today they validate Fastify request bodies server-side (and are erased/unused
client-side except for types). After this migration, they become what
`02-ARCHITECTURE.md` §2 always said they'd be — *"the same schemas validate API input
and run client-side on the phone before a sync attempt"* — genuinely true now, since the
client is the thing making the write. Client-side `.parse()` before every
`supabase.rpc(...)`/`.insert()`/`.update()` call becomes the first validation layer (RLS
+ any `check` constraints in `03-schema.sql` remain the actual enforced boundary; the
Zod layer is UX — fail fast with a real error message before a round trip, not a second
security control). No schema file needs new server-only imports for this — `date-holidays`
leaving the barrel (§4) actually removes the one thing that made a barrel-wide client
import risky.

## 6. Rollout — incremental, each slice independently proven, no big-bang cutover

Given how much rides on §3 staying correct, this should not be one large change landing
at once. Proposed sequence, each step provable on its own before the next starts:

1. **Stand up a real Supabase project's schema in parallel**, not replacing the current
   dev setup: `03-schema.sql` (plus the new `fn_current_tenant_id`, the RPC functions
   from §4, `auth_user_id` columns) applied against it directly, independent of PGlite.
   Prove it with a **new** verify script (not editing `verify-schema.mjs` in place until
   this is trusted — a parallel `verify-schema-supabase.mjs` that re-derives every check
   §3 calls for) before anything in `apps/web` points at it.
2. **Office auth first** — the smallest slice with the clearest success signal (can a
   real office user log in via Supabase Auth and see only their tenant's data through
   RLS alone, no Fastify route in the path). Technician/device auth is deliberately
   second, not parallel, because it's the more novel design (§2) and easier to get right
   in isolation.
3. **One read path, one write path**, chosen for how well they exercise RLS + an RPC
   function together (e.g., job list read + `checklist_item.update` write) — proven with
   a real client-side test before extending to the rest of the surface.
4. **Everything else**, table by table / route by route, each slice keeping its own
   proof rather than one giant proof script at the very end standing in for 20+
   independent claims.
5. **Cutover**: `apps/web` stops calling `/api/...` for whatever's been migrated in each
   slice; Fastify's role shrinks to exactly §4's "stays server-side" list plus whatever
   hasn't been migrated yet. The existing `proof:phase1-4` scripts stay meaningful only
   for whatever's still Fastify-fronted at each point in the rollout — expect them to
   shrink in scope over time, not to keep passing unchanged throughout.

Explicitly not proposed: migrating everything in one pass and running one big proof at
the end. The whole point of RLS-as-sole-boundary is that a mistake is silent until
someone hits it — the incremental sequence above is what makes each mistake small and
attributable to one slice instead of large and undiagnosable across the whole surface.

## 7. Credentials — where they live, stated once so it isn't ambiguous later

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — safe to ship to the
  browser (that's what `anon` means), but still sourced from a local `.env`
  (`apps/web/.env.local`, already gitignored per this repo's existing `.gitignore`
  pattern — `.env`/`.env.*` ignored, `.env.example` tracked with variable *names* only),
  never hardcoded into a committed file.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, Fastify's device-pairing endpoint (§2)
  only. Never in any file that ships to the browser, never in `packages/core` (which
  `apps/web` bundles), never logged.
- Veryfi's four credentials (`CLIENT_ID`, `CLIENT_SECRET`, `USERNAME`, `API_KEY`) —
  server-only, `apps/api`'s env only, same treatment.
- None of the above go in this document, a commit message, or a code comment with real
  values — only variable *names*, matching how `apps/api/README.md`'s existing env-var
  documentation already works.

## 8. Open question genuinely worth your call, not mine

`app_user.id` for office users: migrate it to literally equal `auth.uid()` (cleanest —
one identity, no join needed in `fn_current_tenant_id` for the office half), or keep
`app_user.id` as its own uuid with a new `auth_user_id` column (more churn-resistant if
`app_user` ever needs to exist independent of having a login, e.g. an office user
invited but not yet activated). Recommend the first (equal ids) for simplicity given
every current office user already requires a working login to exist at all — but this
is a real fork worth confirming before §6 step 2 starts, since reversing it later means
touching every foreign key that references `app_user.id` today.
