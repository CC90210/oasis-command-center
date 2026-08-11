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

/**
 * Which brand and stage a sequence speaks for, read off its trigger_filter.
 *
 * Here rather than in the view because the PATCH route has to reach the SAME
 * verdict the UI did. Two copies of this derivation is how a server-side check
 * ends up validating against a different scope than the operator was shown, and
 * then refusing a swap that looked fine (or worse, allowing one that did not).
 *
 * An absent brand marker resolves to SunBiz, matching lib/drips/brand-routing's
 * default: a cold lead mis-sent as SunBiz costs reputation on a domain that can
 * absorb it, the reverse is a confusing first impression on one that cannot.
 */
export function brandFromTriggerFilter(filter: unknown): BrandKey {
  const f = (filter || {}) as { brand?: unknown };
  return String(f.brand ?? "").toLowerCase() === "bluerise" ? "bluerise" : "sunbiz";
}

export function stageFromTriggerFilter(filter: unknown): string {
  const f = (filter || {}) as { to?: unknown };
  return typeof f.to === "string" && f.to ? f.to : "";
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

/**
 * Enough of a step to tell it apart from its neighbours. `drip_sequences.steps`
 * is a positional JSON array with no step ids, so content IS the identity.
 *
 * Only the fields this module reasons about are named. Identity is computed
 * over every key actually present at runtime, so passing a full DripStep — which
 * is what the PATCH route does — distinguishes steps that differ in delay,
 * body_html, variants or sender as well.
 */
export type PinnedStep = {
  template_id?: string;
  role?: string;
  channel?: string;
  subject?: string;
  body?: string;
};

export type PinChange = {
  /** Index in the SAVED steps for an add or a swap; in the PRIOR steps for a
   *  removal, since there is no new position to point at. */
  index: number;
  from: string | null;
  to: string | null;
  /** The role the pin now sits under. Absent on a pure removal. */
  role?: string;
};

/**
 * Which template pins this edit actually changes.
 *
 * NOT AN INDEX-BY-INDEX DIFF. The sequence editor supports reordering and
 * deleting steps, so position is not identity: moving an unpinned step above a
 * pinned one shifts every index below it and an index-wise comparison reads
 * that as "unpinned A here, pinned A there" — two fabricated changes to live
 * copy, in an audit trail whose entire value is that it only contains real
 * ones. lib/drips/edit-guard.ts already learned this and compares at sequence
 * level for the same reason.
 *
 * KEYED ON (template, role), not template alone. Role is what the executor
 * scopes the pool by, so the same template pinned under a different role is a
 * different decision and has to be re-validated — a pin that was reachable as a
 * "nudge" is invisible on an "opener" step.
 *
 * A pure reorder therefore yields nothing at all, which is correct: nothing
 * about what merchants receive has changed.
 */
export function diffPins(prior: PinnedStep[] | null, next: PinnedStep[]): PinChange[] {
  const key = (s: PinnedStep) => `${s.template_id} ${effectiveRole(s.role)}`;

  const bucket = (steps: PinnedStep[]) => {
    const m = new Map<string, number[]>();
    steps.forEach((s, i) => {
      if (!s.template_id) return;
      const k = key(s);
      const at = m.get(k);
      if (at) at.push(i);
      else m.set(k, [i]);
    });
    return m;
  };

  const before = bucket(prior || []);
  const after = bucket(next);

  // Only the SURPLUS on each side is a change. Three passes, because steps have
  // NO STABLE ID — `drip_sequences.steps` is a positional JSON array, so the
  // only identity a step has is its own content:
  //
  //   1. SAME CONTENT, SAME INDEX. Nothing moved. Matched first so that
  //      [A, A] -> [unpin, A] names index 0, the step that actually lost its
  //      pin, and not index 1, which still has one.
  //   2. SAME CONTENT, ELSEWHERE. The step moved. Silent — position changed,
  //      copy did not. This is what makes deleting the FIRST of two identically
  //      pinned steps report index 0 instead of index 1: the survivor is
  //      recognised by its body, not by where it landed.
  //   3. SAME PIN, EDITED COPY. Paired in order and also silent, because the
  //      pin is what this diff is about; the copy edit is the version snapshot's
  //      business.
  //
  // Whatever remains is a real add or a real removal.
  //
  // RESIDUAL AMBIGUITY, STATED PLAINLY: if two steps carry the same pin AND
  // byte-identical copy, deleting one is indistinguishable from deleting the
  // other. There is no data that decides it. The count is right and the reported
  // index is one of the two — an honest limit of a positional array, not
  // something a cleverer match would fix.
  const removed: Array<{ index: number; id: string }> = [];
  const added: Array<{ index: number; id: string; role?: string }> = [];
  const priorSteps = prior || [];
  // Content identity: the WHOLE step, canonically serialised. A hand-picked
  // subset only distinguishes duplicates that happen to differ in the fields
  // that were picked — two steps identical except for delay_minutes, body_html
  // or a pinned sender would collide and the audit would name the wrong one.
  // Key order is normalised so an equivalent object written in a different
  // order is still recognised as the same step.
  const ident = (s: PinnedStep) =>
    JSON.stringify(
      Object.keys(s)
        .sort()
        .map((k) => [k, (s as Record<string, unknown>)[k]]),
    );

  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(k) || [];
    const a = after.get(k) || [];

    const stayed = new Set(b.filter((i) => a.includes(i) && ident(priorSteps[i]) === ident(next[i])));
    let leftBefore = b.filter((i) => !stayed.has(i));
    let leftAfter = a.filter((i) => !stayed.has(i));

    // Pass 2 — same content at a different index. Consume in pairs.
    for (const i of [...leftBefore]) {
      const j = leftAfter.find((x) => ident(priorSteps[i]) === ident(next[x]));
      if (j === undefined) continue;
      leftBefore = leftBefore.filter((x) => x !== i);
      leftAfter = leftAfter.filter((x) => x !== j);
    }

    // Pass 3 — same pin, copy edited. Still not a pin change.
    const moved = Math.min(leftBefore.length, leftAfter.length);
    for (const i of leftBefore.slice(moved)) {
      removed.push({ index: i, id: priorSteps[i].template_id as string });
    }
    for (const i of leftAfter.slice(moved)) {
      added.push({ index: i, id: next[i].template_id as string, role: next[i].role });
    }
  }

  // Pair an add and a removal at the SAME index into one A -> B record. That is
  // the ordinary swap, and reading it as a removal plus an unrelated addition
  // would lose the thing worth knowing: what this copy replaced.
  const out: PinChange[] = [];
  const takenRemovals = new Set<number>();
  for (const a of added) {
    const r = removed.find((x) => x.index === a.index && !takenRemovals.has(x.index));
    if (r) {
      takenRemovals.add(r.index);
      // from === to here means the TEMPLATE stayed and its role moved. Recording
      // it as a fresh pin would erase that it was already pinned to this; the
      // role field alongside is what says which part changed.
      out.push({ index: a.index, from: r.id, to: a.id, role: a.role });
    } else {
      out.push({ index: a.index, from: null, to: a.id, role: a.role });
    }
  }
  for (const r of removed) {
    if (takenRemovals.has(r.index)) continue;
    out.push({ index: r.index, from: r.id, to: null });
  }
  return out.sort((a, b) => a.index - b.index);
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
