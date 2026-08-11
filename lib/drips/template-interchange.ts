/**
 * lib/drips/template-interchange.ts — which approved templates an operator may
 * put behind a step.
 *
 * WHY THIS IS NOT "EDIT THE STEP'S TEXT". The executor does not send the step's
 * inline body when an approved pool exists for that brand and stage — it samples
 * the POOL (resolveCopy, lib/drips/template-pool.ts). So editing a step's copy
 * and interchanging its template are different operations with different blast
 * radii, and only the second changes what merchants actually receive.
 *
 * TWO RULES, BOTH LOAD-BEARING:
 *
 *   APPROVED ONLY. A draft or retired template must never be selectable. This
 *   surface writes to live merchant mail with no send-time review after it, so
 *   the approval state IS the review.
 *
 *   BRAND ISOLATION. A Bluerise step must never be offered SunBiz copy. Two
 *   company names in one conversation is the confusing first impression the
 *   brand split exists to prevent, and it is a carrier problem too, since 10DLC
 *   registration is per brand.
 *
 * Pure and free of "server-only" so the rules are directly testable.
 */

import type { PoolTemplate } from "@/lib/drips/template-pool";
import type { BrandKey } from "@/lib/email/brands";

export type InterchangeScope = {
  brand: BrandKey;
  stage: string;
  /**
   * The step's role, defaulted the SAME way the executor defaults it
   * (executor.ts: `String(step.role || "nudge")`).
   *
   * This is not cosmetic filtering. The executor narrows the pool with
   * poolFor(brand, stage, role) BEFORE resolveCopy ever sees it, so a template
   * playing another role is not in scope at send time: pinning to one saves
   * fine, reports success, and then sampling quietly picks something else.
   * Offering a choice the engine cannot honour is the same silent no-op this
   * whole feature exists to remove.
   */
  role?: string;
};

/**
 * The one place the role default lives, so the UI, the validator and the
 * executor cannot drift apart on what an unset role means.
 */
export function effectiveRole(role: unknown): string {
  const r = String(role ?? "").trim();
  return r || "nudge";
}

/**
 * Templates an operator may choose for this step.
 *
 * Filters on approval, brand and stage, and drops weight-0 entries: a soft
 * retire is kept for the record and must never be sent, so offering it would
 * quietly undo the retire.
 */
export function selectableTemplates(pool: PoolTemplate[], scope: InterchangeScope): PoolTemplate[] {
  const stage = String(scope.stage ?? "").trim().toLowerCase();
  const role = effectiveRole(scope.role);
  return pool
    .filter((t) => t.status === "approved")
    .filter((t) => t.weight > 0)
    .filter((t) => t.brand === scope.brand)
    .filter((t) => String(t.stage ?? "").trim().toLowerCase() === stage)
    .filter((t) => effectiveRole(t.role) === role)
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

export type InterchangeRequest = {
  sequenceId: string;
  stepIndex: number;
  fromTemplateId: string | null;
  toTemplateId: string;
  actorUserId: string;
  brand: BrandKey;
  stage: string;
  role?: string;
};

export type InterchangeVerdict =
  | { ok: true; template: PoolTemplate }
  | { ok: false; reason: string };

/**
 * Validate a swap before anything is written.
 *
 * Fails closed on everything: an unknown template, an unapproved one, a
 * cross-brand one, or a stage mismatch. The cost of a wrong yes is a merchant
 * receiving the wrong company's wording; the cost of a wrong no is an operator
 * picking again.
 */
export function validateInterchange(
  pool: PoolTemplate[],
  req: InterchangeRequest,
): InterchangeVerdict {
  if (!req.toTemplateId) return { ok: false, reason: "no template selected" };
  if (!Number.isInteger(req.stepIndex) || req.stepIndex < 0) {
    return { ok: false, reason: "invalid step index" };
  }
  if (!req.actorUserId) {
    // An unattributable change to live merchant mail is not acceptable.
    return { ok: false, reason: "no acting user" };
  }

  const allowed = selectableTemplates(pool, { brand: req.brand, stage: req.stage, role: req.role });
  const target = allowed.find((t) => t.id === req.toTemplateId);
  if (!target) {
    // Say WHICH rule refused, so an operator is not left guessing.
    const anywhere = pool.find((t) => t.id === req.toTemplateId);
    if (!anywhere) return { ok: false, reason: "template not found" };
    if (anywhere.status !== "approved") return { ok: false, reason: `template is ${anywhere.status}, not approved` };
    if (anywhere.weight <= 0) return { ok: false, reason: "template is soft-retired (weight 0)" };
    if (anywhere.brand !== req.brand) {
      return { ok: false, reason: `template belongs to ${anywhere.brand}, this step sends as ${req.brand}` };
    }
    if (String(anywhere.stage ?? "").trim().toLowerCase() !== String(req.stage ?? "").trim().toLowerCase()) {
      return { ok: false, reason: `template is for stage "${anywhere.stage}", this step is "${req.stage}"` };
    }
    // Last rule standing: the role. Refusing here is what stops a swap the send
    // path would silently ignore, because the executor scopes the pool by role
    // before it ever resolves the pin.
    return {
      ok: false,
      reason: `template plays the "${effectiveRole(anywhere.role)}" role, this step plays "${effectiveRole(
        req.role,
      )}" - the engine only ever substitutes within one role`,
    };
  }
  return { ok: true, template: target };
}

/** The audit record for a swap. A change to live merchant mail must name who
 *  made it and what it replaced, or it cannot be reconstructed later. */
export function buildInterchangeAudit(req: {
  from: string | null;
  to: string;
  actor: string;
  sequenceId?: string;
  stepIndex?: number;
}): Record<string, unknown> {
  return {
    action: "template_interchange",
    from: req.from,
    to: req.to,
    actor: req.actor,
    ...(req.sequenceId !== undefined ? { sequence_id: req.sequenceId } : {}),
    ...(req.stepIndex !== undefined ? { step_index: req.stepIndex } : {}),
  };
}
