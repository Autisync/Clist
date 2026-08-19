// Test evaluation — 05-phase2-job-loop.md §7: "outcome computed server-side
// via the same range/min/max evaluator the prototype already implements in
// JS (evalTest, fieldready-prototype.jsx:129) -- port that function into
// packages/core so client (for instant phone-side pass/fail before sync)
// and server (source of truth) can't disagree, rather than reimplementing
// it twice."
//
// Ported verbatim from fieldready-prototype.jsx:129-135:
//
//   const evalTest = (t, v) => {
//     if (v === "" || v === null || v === undefined || isNaN(Number(v))) return "pending";
//     const n = Number(v);
//     if (t.dir === "range") return n >= t.min && n <= t.max ? "pass" : "fail";
//     if (t.dir === "min") return n >= t.min ? "pass" : "fail";
//     return n <= t.max ? "pass" : "fail";
//   };
//
// Same logic, typed against TestProtocolTest (template.ts) — its own
// .refine already guarantees min/max are present for the given `dir`, so
// the non-null assertions below hold at runtime for any value that passed
// that schema.
//
// dir === "external_pass_fail" (06-phase3-compliance.md §2, F11/Tabela 6.1):
// there's no ITED-specific numeric limit to compute against — the "value"
// passed in for this kind of test IS the verdict itself, as displayed by the
// certifying instrument against EN 50173 Classe E. No min/max exists on the
// test to compute against, so this branch just normalizes and returns that
// verdict rather than computing anything numeric.

import type { TestProtocolTest } from "./template.js";

export type TestOutcome = "pass" | "fail" | "pending";

export function evalTest(
  test: TestProtocolTest,
  value: string | number | null | undefined
): TestOutcome {
  if (value === "" || value === null || value === undefined) {
    return "pending";
  }
  if (test.dir === "external_pass_fail") {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "pass") return "pass";
    if (normalized === "fail") return "fail";
    return "pending";
  }
  if (Number.isNaN(Number(value))) {
    return "pending";
  }
  const n = Number(value);
  if (test.dir === "range") return n >= test.min! && n <= test.max! ? "pass" : "fail";
  if (test.dir === "min") return n >= test.min! ? "pass" : "fail";
  return n <= test.max! ? "pass" : "fail";
}
