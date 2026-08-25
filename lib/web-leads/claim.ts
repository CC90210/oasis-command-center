/**
 * claim.ts — who owns a lead right now, and when that stops being true.
 *
 * THE PROBLEM THIS SOLVES: two reps dialling the same business. Adon's words --
 * "so that our reps are not calling the same people". A lead a rep has claimed
 * leaves the shared Leads tab and appears only in that rep's own book.
 *
 * THE PROBLEM IT MUST NOT CREATE: a pool that only ever drains. Reps claim 100
 * leads, work 70, and the other 30 sit locked forever behind someone who has
 * moved on. Across five reps and a month that is thousands of businesses nobody
 * is allowed to call, and nothing on any screen would say so -- the numbers all
 * look fine, there are just fewer leads every week. So ownership EXPIRES.
 *
 * ═══ THE THREE RULES (Adon's decisions, 2026-08-23) ══════════════════════════
 *
 *   1. Claimed but never dialled for 7 days  -> back in the pool.
 *   2. One rep holds at most 250 leads at a time.
 *   3. Marked "not interested" 90 days ago   -> back in the pool.
 *
 * Rule 3 is the commercially interesting one: "not interested" almost always
 * means "not right now". A permanent kill throws away leads that were only a
 * timing problem, and the next rep to reach them can see the earlier call in
 * the history rather than opening blind.
 *
 * ═══ WHY THIS IS COMPUTED ON READ, NOT SWEPT BY A CRON ═══════════════════════
 *
 * The obvious implementation is a nightly job that clears expired claims. That
 * job is a single point of silent failure: when it stops running, nothing
 * breaks loudly -- leads simply stop returning to the pool, the pool quietly
 * shrinks, and the first symptom is a rep saying "there's nothing left to call"
 * weeks later. This estate has lost eight days of a worker and five days of
 * shop-out to exactly that shape of failure.
 *
 * So availability is DERIVED from the lead's own timestamps every time it is
 * read. There is no job to fail. A lead whose claim has expired is available
 * the instant it expires, whether or not anything ran. The cost is a few
 * comparisons per lead per request, which is nothing next to a silent drain.
 *
 * ═══ INTERNAL DO-NOT-CALL OUTRANKS ALL THREE ════════════════════════════════
 *
 * `dnc: true` means a human said "never call me again". That never expires,
 * never recycles, and never returns to the pool for a second rep to rediscover
 * in 90 days. Canada requires an internal do-not-call list to be honoured
 * organisation-wide and permanently, and honouring it per-rep is the same as
 * not honouring it. It is checked FIRST in every function here, so no other
 * rule can route around it.
 */

/** Everything the ownership rules read. A subset of the lead's stored `data`,
 *  named so the rules can be tested without a database or a WebLead. */
import {
  OASIS_COLD_OUTBOUND_MOTION,
  OASIS_WEBSITE_SALES_PROGRAM,
} from "@/lib/leads/canonical-lead-fields";

export type ClaimFacts = {
  /** Auth user id of the owning rep, or null when nobody holds it. */
  assignedTo: string | null;
  /** When the current owner took it. */
  claimedAt: string | null;
  /** The most recent logged call, whoever made it. */
  lastCallAt: string | null;
  /** Current lifecycle stage (CC's WEBSITE_SALES_STAGES value). */
  stage: string | null;
  /** When the lead was marked lost. */
  lostAt: string | null;
  /** Internal do-not-call. Permanent, organisation-wide, outranks everything. */
  dnc: boolean;
};

export const CLAIM_STALE_DAYS = 7;
export const LOST_RECYCLE_DAYS = 90;
export const MAX_LEADS_PER_REP = 250;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds since an ISO timestamp, or null when it is absent or garbage.
 *  A malformed date must not read as "very old" (which would recycle a lead
 *  that was claimed a minute ago) nor as "very recent" (which would lock one
 *  forever) -- it reads as ABSENT, and each caller decides what that means. */
function ageMs(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return now - t;
}

/**
 * Why a lead is claimable, or why it is not. Returned as a reason rather than a
 * boolean so the UI can say "Sarah has this one" instead of hiding the row with
 * no explanation, and so the tests name the rule they are exercising.
 */
export type Availability =
  | { available: true; reason: "unclaimed" | "claim_expired" | "lost_recycled" }
  | { available: false; reason: "do_not_call" | "held" | "in_progress" };

/**
 * Whether anyone may claim this lead right now.
 *
 * ORDER MATTERS, and it is the same defensive ordering audit.ts uses for score
 * states: the most restrictive answer is checked first, so no later rule can
 * override it by accident.
 */
export function availability(f: ClaimFacts, now: number): Availability {
  // 1. Permanent, organisation-wide, never expires. Checked first so nothing
  //    below can hand a do-not-call business to a rep.
  if (f.dnc) return { available: false, reason: "do_not_call" };

  // 2. Marked lost. Checked BEFORE ownership, not after.
  //
  //    A first draft checked "nobody holds it" first, which quietly made the
  //    90-day rule unreachable for any lost lead with no owner: it returned
  //    `unclaimed` at step 2 and never reached this branch, so a business that
  //    said "not interested" yesterday was immediately callable again by
  //    anyone, forever. (Codex review, 2026-08-23.) Whether a lead is worth
  //    calling again is a fact about the CONVERSATION, not about who happens to
  //    hold the record -- so it is answered before ownership is consulted.
  //
  //    It is also checked before staleness because a lost lead HAS been called:
  //    it would never satisfy the never-dialled rule below and would otherwise
  //    be locked to its last owner permanently.
  if (f.stage === "lost") {
    const since = ageMs(f.lostAt, now);
    // A lost lead with no lost_at stamp (written before this field existed)
    // stays held rather than recycling immediately -- fail closed toward the
    // prospect, who said no.
    if (since !== null && since >= LOST_RECYCLE_DAYS * DAY_MS) {
      return { available: true, reason: "lost_recycled" };
    }
    return { available: false, reason: "in_progress" };
  }

  // 3. Nobody holds it, and it is not a recent loss.
  if (!f.assignedTo) return { available: true, reason: "unclaimed" };

  // 4. Claimed but never actually dialled. `lastCallAt` set at all means the
  //    rep is working it, whatever the stage says -- one logged call resets
  //    this, which is the behaviour a rep expects and the one that rewards
  //    logging.
  if (f.lastCallAt) return { available: false, reason: "in_progress" };

  const heldFor = ageMs(f.claimedAt, now);
  // A claim with no timestamp cannot be aged. Treat it as freshly claimed
  // (held) rather than instantly expired: yanking a lead out from under a rep
  // because of a missing field is the worse error.
  if (heldFor === null) return { available: false, reason: "held" };

  return heldFor >= CLAIM_STALE_DAYS * DAY_MS
    ? { available: true, reason: "claim_expired" }
    : { available: false, reason: "held" };
}

/**
 * Whether THIS viewer should see the lead in their own book.
 *
 * Deliberately NOT the inverse of availability(). A rep keeps seeing a lead
 * whose claim has expired -- it appears in their book flagged as released,
 * rather than vanishing overnight with no explanation. Silent disappearance is
 * how a rep loses trust in the tool and starts keeping a private spreadsheet,
 * which defeats the entire point of tracking any of this.
 */
export function isInBookOf(f: ClaimFacts, userId: string): boolean {
  if (!f.assignedTo) return false;
  return f.assignedTo.trim().toLowerCase() === userId.trim().toLowerCase();
}

/** True when a rep still nominally holds a lead but the claim has lapsed --
 *  what the "Released" marker in My Leads is keyed on. */
export function isReleasedFromBook(f: ClaimFacts, now: number): boolean {
  return Boolean(f.assignedTo) && availability(f, now).available;
}

/**
 * Which of `leadIds` a rep may take, given what they already hold.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE, not an error: a rep multi-selects 60
 * leads, two were taken by someone else in the last minute, and one is at the
 * cap. Refusing all 60 over that is hostile; silently taking 57 and reporting
 * "done" is dishonest. So this returns exactly what was granted AND exactly
 * what was refused with the reason, and the UI says so. Same discipline
 * assign.ts documents for territory assignment: "a half-assigned territory that
 * reports success is worse than an error".
 */
export type ClaimPlan = {
  granted: string[];
  refused: { id: string; reason: Availability["reason"] | "at_capacity" }[];
};

export function planClaim(
  candidates: { id: string; facts: ClaimFacts }[],
  heldCount: number,
  now: number,
): ClaimPlan {
  const granted: string[] = [];
  const refused: ClaimPlan["refused"] = [];
  let room = Math.max(0, MAX_LEADS_PER_REP - heldCount);

  for (const c of candidates) {
    const a = availability(c.facts, now);
    if (!a.available) {
      refused.push({ id: c.id, reason: a.reason });
      continue;
    }
    if (room <= 0) {
      refused.push({ id: c.id, reason: "at_capacity" });
      continue;
    }
    granted.push(c.id);
    room -= 1;
  }
  return { granted, refused };
}

/** The `data` patch that records a claim. Stamped fields are cleared as well as
 *  set: a recycled lead carries the PREVIOUS owner's lost_at, and leaving it in
 *  place would make the new owner's lead read as already-lost and recycle again
 *  90 days later regardless of what the new rep does with it. */
export function claimPatch(userId: string, nowIso: string): Record<string, unknown> {
  return {
    assigned_to: userId,
    claimed_at: nowIso,
    sales_program: OASIS_WEBSITE_SALES_PROGRAM,
    sales_motion: OASIS_COLD_OUTBOUND_MOTION,
    last_contacted_at: nowIso,
    last_call_at: null,
    lost_at: null,
    stage: "assigned",
    stage_entered_at: nowIso,
  };
}

/** The `data` patch that returns a lead to the pool. `dnc` is never touched
 *  here -- releasing a lead must not un-suppress a business that asked not to
 *  be called. */
export function releasePatch(): Record<string, unknown> {
  return { assigned_to: null, claimed_at: null };
}

/** Read the ownership facts off a raw stored `data` blob. Tolerant of missing
 *  fields (every lead predates this feature) and never invents a truthy dnc. */
export function factsFrom(data: Record<string, unknown>): ClaimFacts {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    assignedTo: s(data.assigned_to),
    claimedAt: s(data.claimed_at),
    lastCallAt: s(data.last_call_at),
    stage: s(data.stage),
    lostAt: s(data.lost_at),
    // Strict: only a real boolean true, or the 1 libSQL returns for a boolean
    // column, counts. A stray string must never be read as consent to call
    // someone who opted out -- and must never be read as opt-out either, which
    // is why this is not `Boolean(data.dnc)`.
    dnc: data.dnc === true || data.dnc === 1,
  };
}
