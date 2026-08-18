# FieldReady — Phase 4 design: cost intelligence

v1.0 · Read after `06-phase3-compliance.md`. Scope per `CLAUDE.md`/`forms-and-procedures-spec.md`
§5: **F01 site survey → F20 receipt capture → F21 pickup runs → supplier price history →
the dashboard.** Deliberately last, per PRD §5/`CLAUDE.md`: the dashboard's numbers don't
mean anything until 30+ real closed jobs exist. That gate is on *trusting the output*, not
on writing the code — the CRUD, ingestion, and view-reading endpoints below have no
dependency on job volume and can be built and tested with a handful of fixtures, same as
every other phase.

*Exit criterion:* the five `/dashboard/*` endpoints return figures computed from live
data (via the views `03-schema.sql` §13 already ships) rather than anything hardcoded,
and the sourcing/pickup-plan logic reproduces the prototype's cheapest-open-supplier-first
ordering exactly — a regression check against the one piece of this phase that already has
a settled interaction design.

---

## 1. What's already built and needs no new logic

`v_job_readiness`, `v_first_time_fix_rate`, `v_hours_variance` (schema §13) are real,
verified views today (the three `v_*` view checks in `verify-schema.mjs`). Three of the five dashboard
endpoints in API spec §8 are therefore a `select * from v_...` behind `withTenant` and
nothing else:

```
GET /dashboard/first-time-fix-rate?months=6      → v_first_time_fix_rate, filtered
GET /dashboard/hours-variance?by=job_type         → v_hours_variance
GET /dashboard/readiness-correlation              → v_job_readiness joined to job_closeout.first_time_fix,
                                                      bucketed — the prototype's headline chart
```

Consistent with API spec §8's own principle ("if a number needs to change, it changes in
`03-schema.sql`, not in two places") the bucketing for `readiness-correlation` belongs in
a fourth view (`v_readiness_correlation`), not in route-handler JS — keep the dashboard
layer a pure pass-through, no exceptions for the one chart that happens to need a
`case`/`group by` instead of a plain `select`.

## 2. Price alerts — the one new view

`GET /dashboard/price-alerts` doesn't have a backing view yet.
`fieldready-prototype.jsx`'s `priceAlerts` (line 455) is the reference logic: any
`supplier_price` row where `price > prev_price * 1.03`, joined to the cheapest
alternative supplier for the same `item_id`. Port this to `v_price_alerts`:

```sql
create view v_price_alerts as
select sp.tenant_id, sp.item_id, sp.supplier_id, sp.price, sp.prev_price,
       round(100.0 * (sp.price - sp.prev_price) / nullif(sp.prev_price, 0), 1) as delta_pct
from supplier_price sp
where sp.prev_price is not null and sp.price > sp.prev_price * 1.03;
```

`GET /dashboard/price-alerts` joins this to `GET /catalog-items/:id/sourcing`'s
already-speced ranking (§4 below) to attach the cheaper alternative, same as the
prototype does client-side today.

`GET /dashboard/recommended-actions` is explicitly speced as "generated from the above,
same logic as the prototype's static list, now computed" (API spec §8) — this one
legitimately has application-layer logic (turning "TDT reparação is +N% over budget" into
a sentence), but the *numbers* it reads all come from the views above; keep the sentence
templates in code and the arithmetic in SQL, same split as everywhere else in this
system.

## 3. Google Places — the honest substitution

`POST /suppliers/:id/refresh-places` needs a live Google Places API call, which (like
Postgres and S3 in earlier phases) likely isn't available in whatever sandbox this gets
built in. Same pattern as `db.ts`'s PGlite substitution and Phase 2's local-filesystem
`ObjectStore`: define a `PlacesProvider` interface (`refresh(place_id) ->
{address, hours, phone}`) with a fixture-backed implementation for dev/proof (returning
the prototype's own `SUPPLIERS` data, which is already realistic Lisbon-area addresses)
and a real Google Places implementation swapped in at deploy time. Document the
substitution in `apps/api/README.md`'s stack table when it's built, same honesty as the
existing two entries there.

## 4. Sourcing and pickup runs (F21)

`GET /catalog-items/:id/sourcing` ports `fieldready-prototype.jsx`'s `sourcingOptions`
(line 269) directly: all `supplier_price` rows for the item, joined to `supplier`, sorted
by price ascending, with `openState`-equivalent logic (line 255) computed server-side
against `supplier.hours` — this needs the current time and the supplier's `hours` jsonb,
no new schema. Because this is one of the few pieces of business logic the prototype
already implements in working, reviewed JS, **port the algorithm, don't redesign it** —
copy `sourcingOptions`'s sort key (price only, ascending) faithfully; the pickup-*plan*
logic (`pickupPlan`, line 718 — coverage count first, then open-now, then total price) is
a second, separate ranking used only when multiple items are missing and one supplier run
should be chosen, and the two must not be conflated.

`GET /jobs/:id/pickup-plan` — server-side version of `pickupPlan`: for a job's missing
mandatory `job_checklist_item` rows, group sourcing options by supplier, sort by
(items covered desc, currently-open desc, total price asc) — the exact tuple the
prototype sorts on. This is what backs the phone's "faltam N" screen's "passar por"
recommendation (`fieldready-prototype.jsx`'s `prepresult` screen) — that screen's
interaction design is settled, so the ranking it displays must match this endpoint
exactly, not an approximation of it.

## 5. Receipt OCR (F20) — an evaluation task wearing an engineering interface

Architecture §6 is explicit: *"test against ~20 real Rexel/Sonepar/Casa das Antenas
receipts before committing to a vendor."* That test is empirical and hasn't happened —
this document does not pick Veryfi vs. Mindee vs. Google Document AI, the same way
`06-phase3-compliance.md` doesn't invent Tabela 6.1's numbers. What ships now is the
shape that makes the eventual choice a swap, not a rewrite:

```ts
interface ReceiptOcrProvider {
  parse(imageBuffer: Buffer): Promise<{
    supplier_guess?: string;
    doc_number?: string;
    receipt_date?: string;
    lines: { description: string; qty: number; unit_price: number }[];
  }>;
}
```

`POST /receipts` stores the image (via the `ObjectStore` from Phase 2) and enqueues a
call to whichever `ReceiptOcrProvider` is configured, writing the raw vendor response into
`receipt.ocr_raw` (already jsonb, schema §5, kept "for audit" per its own comment) and
parsed lines into `receipt_line`. `POST /receipts/:id/confirm` is the human-in-the-loop
step that actually writes `supplier_price` — API spec §3 is explicit this is
non-negotiable ("OCR output is never written to `supplier_price` directly"); nothing in
this phase changes that.

Before committing to a real provider: run the planned ~20-receipt test, record accuracy
per vendor against Portuguese thermal-receipt formatting specifically (the architecture
doc's own caveat — this is exactly the input that separates marketing claims from real
accuracy), and only then implement the real `ReceiptOcrProvider`. Until that happens, a
manual-entry-only path (`POST /suppliers/:id/prices`, already speced, no OCR involved)
is a complete substitute — nothing in the job loop depends on OCR working.

## 6. Site survey (F01)

A `checklist`-kind template like F03/F04, triggered pre-quote (spec §3.1). No new
mechanism — same template-resolution and response shape as any other checklist. The one
design decision worth naming: F01 responses are reference material an office user reads
while building a quote (`05-phase2-job-loop.md` §3 already notes this), not an
auto-population source for v1. Wiring survey fields directly into quote-line generation
is a real future improvement, explicitly deferred rather than half-built here.

## 7. Exit criterion — `phase4-proof.mjs`

1. Seed a handful of suppliers/prices/receipts (fixtures, not 30 real jobs — that bar is
   for trusting the *dashboard's conclusions*, not for the code path existing).
2. `POST /receipts` against a fixture image with a stub `ReceiptOcrProvider` returning
   known lines; confirm `receipt_line` rows appear with `item_id = null` for an
   unmatched line (the "sem correspondência" case the prototype's receipt-review modal
   already handles); `POST /receipts/:id/confirm` a subset → confirm exactly those become
   real `supplier_price` rows, unconfirmed lines don't.
3. `GET /catalog-items/:id/sourcing` on an item with three supplier prices → confirm
   ascending-price order, independent of which supplier is currently open (that's the
   pickup-plan's job, not sourcing's).
4. Create a job with two missing mandatory materials covered by different supplier
   subsets → `GET /jobs/:id/pickup-plan` → confirm the (coverage, open-now, price) sort
   matches a hand-computed expectation, not just "returns something."
5. `GET /dashboard/*` on seeded data → confirm every number matches an independent SQL
   query against the same fixtures (i.e., the endpoint is truly reading the view, not a
   cached or approximated figure).

Not in this phase's scope: choosing and integrating a real OCR vendor (§5) and real
Google Places credentials (§3) — both are explicitly deferred to a real-world evaluation
step this document can't shortcut.
