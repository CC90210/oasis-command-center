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

/**
 * The copy actually sent for one step, and where it came from.
 *
 * PRECEDENCE, in order:
 *   1. an APPROVED pool template for this (brand, stage, role)
 *   2. the step's own body_variants / subject_variants  ← today's behaviour
 *   3. the step's plain body / subject
 *
 * An empty or fully-unapproved pool therefore produces byte-identical output to
 * the pre-pool engine, which is what makes this safe to deploy before a single
 * template is seeded, and what the tests pin.
 *
 * `source` and `templateId` come back so the send can be audited: knowing which
 * template a merchant actually received is the difference between being able to
 * explain a complaint and guessing.
 */
export type ResolvedCopy = {
  subject: string;
  body: string;
  bodyHtml?: string;
  variantIndex: number;
  source: "pool" | "step_variants" | "step_body";
  templateId: string | null;
};

type StepLike = {
  subject?: string;
  body: string;
  body_html?: string;
  subject_variants?: string[];
  body_variants?: string[];
};

export function resolveCopy(
  step: StepLike,
  leadId: string,
  stepIndex: number,
  pool: PoolTemplate[],
): ResolvedCopy {
  // 1. Approved pool wins.
  const picked = selectFromPool(pool, leadId, stepIndex);
  if (picked) {
    return {
      subject: picked.subject || step.subject || "",
      body: picked.bodyText,
      bodyHtml: step.body_html,
      variantIndex: 0,
      source: "pool",
      templateId: picked.id,
    };
  }

  // 2. The step's own variants — unchanged from the pre-pool engine, including
  //    the subject/body pairing by index.
  const variants = step.body_variants;
  if (variants && variants.length > 0) {
    const i = stableIndex(`${leadId}:${stepIndex}`, variants.length);
    const sv = step.subject_variants;
    const subject = (sv && sv.length > 0 ? sv[i % sv.length] : step.subject) || "";
    return {
      subject,
      body: variants[i],
      bodyHtml: step.body_html,
      variantIndex: i,
      source: "step_variants",
      templateId: null,
    };
  }

  // 3. Plain copy.
  return {
    subject: step.subject || "",
    body: step.body,
    bodyHtml: step.body_html,
    variantIndex: 0,
    source: "step_body",
    templateId: null,
  };
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
