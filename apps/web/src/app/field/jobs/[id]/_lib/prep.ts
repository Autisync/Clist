/*
 * Shared types + the sessionStorage handoff key between /prep and
 * /prep-result. Both are real, separately-routed pages (not the
 * prototype's single-component screen-switcher), so the per-item answers
 * the technician records on /prep have to cross an actual navigation to
 * reach /prep-result — this stage doesn't persist them to the API yet (no
 * PATCH, no /sync/mutations call; that's the next stage's offline-queue
 * wiring), so sessionStorage is the local-only carrier in the meantime.
 */

export type Cat = "material" | "equipment" | "doc";

export type ReadinessItem = {
  id: string;
  cat: Cat;
  label: string;
  qty: string | number;
  item_id: string | null;
  scope: "job" | "van" | "office";
  mandatory: boolean;
  status: "ok" | "missing";
};

export type PrepAnswerItem = ReadinessItem & { answer: "yes" | "no" | null };

export function prepStorageKey(jobId: string): string {
  return `fr:prep:${jobId}`;
}
