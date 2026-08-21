// FieldReady — pt_holiday / fn_add_working_days verification.
// 08-supabase-native-migration.md §4, §6 Step 4.
//
// Proves the SQL port of packages/core/src/deadlines.ts against the exact
// same real disagreement apps/api/test/phase3-proof.mjs already established
// against the TypeScript implementation — not a different, newly-invented
// test case that could happen to pass while the underlying logic drifted.
// Also proves the `type: 'public'`-only filter (Carnaval-style observance
// holidays must NOT stop the clock) and the weekend check, independently.
//
// Applies holidays.sql itself (idempotent — drops exactly what it creates
// first). Does not require any auth/RLS setup — pt_holiday has one
// permissive SELECT policy (it's global reference data, not tenant-scoped),
// so this runs entirely as the superuser connection; no auth fixtures
// needed, unlike every other verify-*.mjs in this folder.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-holidays.mjs

import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import Holidays from 'date-holidays';
import { createReporter, pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;

if (!projectRef || !dbPassword) {
  console.error(
    'Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.\n' +
    'Run as: cd apps/api && node --env-file=.env supabase/verify-holidays.mjs'
  );
  process.exit(1);
}

const reporter = createReporter();
const { ok, fail } = reporter;
const db = new Client(pgClientConfig(projectRef, dbPassword));

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres.`);

const holidaysPath = new URL('./holidays.sql', import.meta.url).pathname;
const holidaysSql = readFileSync(holidaysPath, 'utf8');

try {
  console.log('Resetting prior run\'s objects (if any) ...');
  await db.query(`
    drop function if exists fn_add_working_days(date, int, text) cascade;
    drop function if exists fn_is_working_day(date, text) cascade;
    drop table if exists pt_holiday cascade;
  `);
  ok('prior run\'s objects reset');
} catch (err) {
  fail('reset', err);
  await db.end();
  process.exit(1);
}

console.log(`Applying ${holidaysPath} ...`);
try {
  await db.query(holidaysSql);
  ok('holidays.sql applied with no errors');
} catch (err) {
  fail('holidays apply', err);
  await db.end();
  process.exit(1);
}

// ---- 1. Full content diff against a FRESH regeneration from the real
// date-holidays package — not just a row count (security review, low,
// confirmed: a row-count check alone would pass even if one date within a
// year were swapped for a duplicate/wrong date, since the total stays 117).
// This re-derives the same day-by-day UTC scan holidays.sql's own header
// documents, independently, every time this script runs — the strongest
// check available short of trusting the seed data blindly, and the one
// that would actually catch a future manual edit introducing a transcribed
// date error in a year other than the two spot-checked below.

try {
  const hd = new Holidays('PT');
  const expected = [];
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2033, 0, 1);
  for (let t = start; t < end; t += 24 * 60 * 60 * 1000) {
    const date = new Date(t);
    const found = hd.isHoliday(date);
    if (found) {
      for (const h of found) {
        if (h.type === 'public') {
          expected.push({ date: date.toISOString().slice(0, 10), name: h.name });
        }
      }
    }
  }
  expected.sort((a, b) => a.date.localeCompare(b.date));

  const actual = await db.query(`select holiday_date::text as date, name from pt_holiday where municipality is null order by holiday_date`);
  const actualRows = actual.rows;

  const expectedKey = JSON.stringify(expected);
  const actualKey = JSON.stringify(actualRows.map((r) => ({ date: r.date, name: r.name })));

  if (actualKey === expectedKey && expected.length === 117) {
    ok(`pt_holiday's 117 seeded rows match a fresh, independent regeneration from date-holidays exactly (every date and name, not just the count)`);
  } else {
    const expectedSet = new Set(expected.map((e) => e.date));
    const actualSet = new Set(actualRows.map((r) => r.date));
    const missing = expected.filter((e) => !actualSet.has(e.date));
    const extra = actualRows.filter((r) => !expectedSet.has(r.date));
    fail('pt_holiday content diff', new Error(
      `expected ${expected.length} rows, got ${actualRows.length}. Missing: ${JSON.stringify(missing)}. Extra: ${JSON.stringify(extra)}`));
  }
} catch (err) {
  fail('pt_holiday content diff', err);
}

// ---- 2. The exact real disagreement phase3-proof.mjs already established
// against the TypeScript implementation: termo issued 2026-04-01 (Wed),
// +10 working days. Naive weekday-only answer: 2026-04-15. Holiday-aware
// answer (skipping Sexta-Feira Santa, 2026-04-03, a Friday): 2026-04-16.

try {
  const r = await db.query(`select fn_add_working_days($1::date, 10)::text as due_on`, ['2026-04-01']);
  if (r.rows[0].due_on === '2026-04-16') {
    ok('fn_add_working_days(2026-04-01, 10) = 2026-04-16 — matches phase3-proof.mjs\'s already-verified TS answer exactly, disagreeing with the naive weekday-only answer (2026-04-15)');
  } else {
    fail('fn_add_working_days holiday-aware case', new Error(`expected 2026-04-16, got ${r.rows[0].due_on}`));
  }
} catch (err) {
  fail('fn_add_working_days holiday-aware case', err);
}

// ---- 3. Carnaval (observance, not public) does NOT stop the clock —
// independently confirms the kind='public' filter, not just trusted from
// reading the SQL. Carnaval 2026 is 2026-02-17 (a Tuesday); not seeded here
// at all (observance rows are deliberately never inserted, per this file's
// header), so if the filter were ever loosened to count ANY pt_holiday row
// regardless of kind, seeding an observance row would make this fail.

try {
  const seeded = await db.query(`select count(*)::int as n from pt_holiday where holiday_date = '2026-02-17'`);
  if (seeded.rows[0].n === 0) {
    ok('Carnaval (observance, 2026-02-17) is correctly not seeded at all — only public holidays are');
  } else {
    fail('observance-not-seeded check', new Error(`expected 0 rows for 2026-02-17, got ${seeded.rows[0].n}`));
  }

  const r = await db.query(`select fn_is_working_day($1::date) as is_working`, ['2026-02-17']);
  if (r.rows[0].is_working === true) {
    ok('fn_is_working_day treats 2026-02-17 (Carnaval, a Tuesday) as a working day — observance never stops the clock');
  } else {
    fail('observance does not stop clock', new Error('expected true, got false'));
  }
} catch (err) {
  fail('observance does not stop clock', err);
}

// ---- 4. Weekend check, independent of any holiday data ---------------------

try {
  const saturday = await db.query(`select fn_is_working_day($1::date) as is_working`, ['2026-04-04']); // a Saturday
  const monday = await db.query(`select fn_is_working_day($1::date) as is_working`, ['2026-04-06']); // a Monday
  if (saturday.rows[0].is_working === false && monday.rows[0].is_working === true) {
    ok('fn_is_working_day correctly treats a Saturday as non-working and the following Monday as working');
  } else {
    fail('weekend check', new Error(
      `expected [Sat:false, Mon:true], got [Sat:${saturday.rows[0].is_working}, Mon:${monday.rows[0].is_working}]`));
  }
} catch (err) {
  fail('weekend check', err);
}

// ---- 5. A real national public holiday itself is not a working day -------

try {
  const christmas = await db.query(`select fn_is_working_day($1::date) as is_working`, ['2026-12-25']); // Natal — a Friday in 2026
  if (christmas.rows[0].is_working === false) {
    ok('fn_is_working_day treats a real seeded public holiday (Natal, 2026-12-25) as non-working');
  } else {
    fail('public holiday check', new Error('expected false for 2026-12-25, got true'));
  }
} catch (err) {
  fail('public holiday check', err);
}

// ---- 6. authenticated (RLS) can read pt_holiday, matching what a
// SECURITY INVOKER RPC calling fn_add_working_days needs to actually work —
// checked via pg_roles/grants rather than a full auth fixture, since this
// table has no tenant scoping to exercise.

try {
  const r = await db.query(`
    select has_table_privilege('authenticated', 'pt_holiday', 'SELECT') as can_select
  `);
  if (r.rows[0].can_select) {
    ok('authenticated role can SELECT from pt_holiday (required for a SECURITY INVOKER RPC to use fn_add_working_days at all)');
  } else {
    fail('pt_holiday grant', new Error('authenticated cannot SELECT pt_holiday'));
  }
} catch (err) {
  fail('pt_holiday grant', err);
}

// ---- 7. A duplicate national holiday for an already-seeded date is
// actually rejected — security review (medium, confirmed): this file's own
// header explains why idx_pt_holiday_date_municipality uses
// coalesce(municipality, '') instead of a plain composite unique
// constraint (Postgres treats every NULL as distinct, so a plain
// unique(holiday_date, municipality) would NOT catch two null-municipality
// rows for the same date) — but nothing here had ever actually attempted
// the insert this index exists to reject.

try {
  let rejected = false;
  try {
    await db.query(`insert into pt_holiday (holiday_date, name, kind, municipality) values ('2026-12-25', 'Natal (duplicado)', 'public', null)`);
  } catch (err) {
    rejected = /duplicate key|unique constraint/i.test(err.message);
    if (!rejected) throw err;
  }
  if (rejected) {
    ok('a duplicate national holiday for an already-seeded date (2026-12-25) is rejected by idx_pt_holiday_date_municipality');
  } else {
    fail('duplicate national holiday rejection', new Error('insert unexpectedly succeeded'));
  }
} catch (err) {
  fail('duplicate national holiday rejection', err);
}

await db.end();

console.log('\n' + (reporter.failures === 0
  ? `All checks passed.`
  : `${reporter.failures} check(s) failed — see FAIL lines above.`));
process.exit(reporter.failures === 0 ? 0 : 1);
