/**
 * lib/drips/template-pool.ts — the approved template pool and its selection rule.
 *
 * Pure, no I/O, no "server-only", so the approval gate is directly testable. The
 * loader that reads drip_template_pool lives in template-pool-store.ts.
 *
 * WHY THIS EXISTS (Adon, 2026-08-05): copy used to live inside
 * drip_sequences.steps, which meant changing it was a database edit and nobody
 * could contribute a template without touching the sequence. It also meant the
 * 14 cc_email_templates rows under `drip:*` that the Templates UI edits were
 * NEVER READ by the drip engine — an operator could rewrite them all and change
 * nothing about what a merchant received.
 *
 * Now: anyone can add a template, from the UI or imported from outside, and
 * nothing reaches a merchant until a human approves it.
 *
 * TWO RULES:
 *
 *   1. APPROVAL IS A GATE. `draft` and `retired` are unreachable, not
 *      deprioritised. There is no seed, lead, or step index that can select one.
 *   2. SIMILAR MEANS SAME JOB. The pool is keyed on (brand, stage, role), so a
 *      template only ever substitutes for another playing the same part in the
 *      arc. An opener never stands in for a last call. That is the difference
 *      between rotation reading as variation and reading as incoherence.
 */

import type { BrandKey } from "@/lib/email/brands";

/** Where in the arc a template belongs. Rotation only swaps within one role. */
export const TEMPLATE_ROLES = [
  "opener",
  "nudge",
  "value",
  "question",
  "last_call",
  "revive",
] as const;

export type TemplateRole = (typeof TEMPLATE_ROLES)[number];

export type PoolTemplate = {
  id: string;
  brand: BrandKey;
  stage: string;
  role: TemplateRole | string;
  subject: string;
  bodyText: string;
  status: "draft" | "approved" | "retired";
  /** 0 is a soft retire: kept for the record, never sent. */
  weight: number;
};

/**
 * The same hash the executor uses for body_variants, duplicated here rather than
 * imported because executor.ts is server-only. Keeping the algorithm identical
 * matters: a lead must get the same template across retries and reclaims, and a
 * redelivery that re-rolled would read to the merchant as a second, different
 * email.
 */
function stableIndex(seed: string, n: number): number {
  if (n <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

/** Is this row eligible to reach a merchant at all? */
function isSendable(t: PoolTemplate): boolean {
  if (t.status !== "approved") return false;
  // A non-finite or non-positive weight cannot resurrect a template. Guarding
  // here rather than at the call site means a malformed row is inert instead of
  // producing a NaN index that would silently select element 0 every time.
  if (!Number.isFinite(t.weight) || t.weight <= 0) return false;
  if (!t.bodyText || !String(t.bodyText).trim()) return false;
  return true;
}

/**
 * Pick ONE template deterministically per (lead, step).
 *
 * Returns null when nothing is eligible, which is the signal for the caller to
 * fall back to the step's own body_variants and then its plain body. That
 * fallback is what lets this ship before the pool is populated: an empty pool
 * reproduces today's behaviour exactly.
 *
 * `weight` biases selection without ever excluding a lighter template, so an
 * operator can favour a winner without silently retiring the rest.
 */
export function selectFromPool(
  pool: PoolTemplate[],
  leadId: string,
  stepIndex: number,
): PoolTemplate | null {
  const eligible = (pool || []).filter(isSendable);
  if (eligible.length === 0) return null;

  // Expand by weight. Bounded per template so one row with a huge weight cannot
  // blow up the array.
  const bag: PoolTemplate[] = [];
  for (const t of eligible) {
    const n = Math.min(100, Math.floor(t.weight));
    for (let i = 0; i < n; i++) bag.push(t);
  }
  if (bag.length === 0) return null;

  return bag[stableIndex(`${leadId}:${stepIndex}`, bag.length)];
}

/** Narrow a loaded pool to the (brand, stage, role) that a step calls for. */
export function poolFor(
  pool: PoolTemplate[],
  brand: BrandKey,
  stage: string,
  role: string,
): PoolTemplate[] {
  return (pool || []).filter(
    (t) => t.brand === brand && t.stage === stage && String(t.role) === String(role),
  );
}
