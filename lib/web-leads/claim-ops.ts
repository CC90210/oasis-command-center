/**
 * claim-ops.ts — the database side of claiming leads.
 *
 * The rules live in ./claim (pure, no I/O, fully tested at exact instants).
 * This module reads the facts those rules need, applies them, writes the
 * result, and PROVES the write landed the way it thinks it did.
 *
 * ═══ TWO REPS, ONE BUSINESS: AN ACTUAL COMPARE-AND-SWAP ══════════════════════
 *
 * The race: two reps press Claim on the same lead within the same second. This
 * is not exotic. Two reps starting Monday on the same filtered view -- "Toronto
 * salons under 40" -- and bulk-claiming page 1 is the NORMAL case, not an edge
 * case, and it collides on every lead at once.
 *
 * A first draft of this file wrote unconditionally and then read back to see
 * who won, and its comment claimed that gave exactly one owner. It did not:
 * both requests can complete their verification read before the other's write
 * lands, so both reps are told they own it, and a later write silently changes
 * the owner while the first rep's screen still says success. Codex caught the
 * overclaim (2026-08-23). Read-after-write detects most collisions and
 * guarantees nothing.
 *
 * What this does instead is a real compare-and-swap, in ONE statement:
 *
 *     UPDATE tenant_records SET data = ?
 *      WHERE id = ? AND tenant_id = ? AND entity_type = 'lead'
 *        AND json_extract(data,'$.assigned_to') IS <the owner we read>
 *
 * lib/turso-postgrest.ts's `q()` compiles `data->>assigned_to` to a
 * json_extract, and runUpdate() puts every filter into that single UPDATE's
 * WHERE clause -- so the test and the write are one atomic statement, and
 * PostgREST compiles the same predicate on the supabase-js path. Zero rows
 * returned means the owner changed between our read and our write: somebody
 * else got there first, and the rep is told so.
 *
 * The condition is the owner we OBSERVED, not a bare "is null", because a lead
 * recycled out of an expired claim or a 90-day-old loss still carries its
 * previous owner. Conditioning on null would refuse exactly the leads the
 * recycling rules just released.
 *
 * ═══ EVERY READ PINS THE TENANT ══════════════════════════════════════════════
 *
 * libSQL has no row-level security. Same rule as data.ts, audit.ts and
 * scores.ts: WEBDEV_TENANT_ID on every statement, no exceptions.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID, LEAD_READ_CAP, assertCompleteRead } from "./tenant";
import {
  availability, factsFrom, isInBookOf, planClaim, claimPatch, releasePatch,
  MAX_LEADS_PER_REP, type ClaimPlan,
} from "./claim";

/** How many leads a rep currently holds. Counts rows whose assigned_to is this
 *  rep, INCLUDING lapsed ones -- a lapsed lead still occupies their book until
 *  someone else takes it, and a cap that ignored them would let a rep sit on
 *  600 stale leads while the counter read 0. */
async function heldCount(userId: string): Promise<number> {
  const db = getServiceSupabase();
  const { data, error, count } = await db
    .from("tenant_records")
    .select("id,data", { count: "exact" })
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .limit(LEAD_READ_CAP);
  if (error) throw new Error(`held_count_failed: ${error.message}`);
  assertCompleteRead("held_count", data || [], count);
  const rows = (data || []) as { id: string; data: Record<string, unknown> }[];
  return rows.filter((r) => isInBookOf(factsFrom(r.data || {}), userId)).length;
}

export type ClaimResult = {
  claimed: string[];
  refused: ClaimPlan["refused"];
  /** Rows we wrote but that a concurrent claim won. Reported separately from
   *  `refused` because the rep DID try and the answer changed underneath them,
   *  which is a different sentence on screen. */
  lostRace: string[];
  held: number;
  cap: number;
};

/**
 * Claim one or more leads for `userId`.
 *
 * `now` is injected rather than read here so the whole path is testable at a
 * fixed instant and so the expiry rules cannot disagree with the caller's clock
 * mid-request.
 */
export async function claimLeads(
  userId: string,
  leadIds: string[],
  now: number,
): Promise<ClaimResult> {
  if (leadIds.length === 0) {
    return { claimed: [], refused: [], lostRace: [], held: await heldCount(userId), cap: MAX_LEADS_PER_REP };
  }
  const db = getServiceSupabase();

  // Read the candidates. `in` on the primary key is a real indexed predicate,
  // so this is the one read here that does not scan.
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .in("id", leadIds);
  if (error) throw new Error(`claim_read_failed: ${error.message}`);

  const rows = (data || []) as { id: string; data: Record<string, unknown> }[];
  const byId = new Map(rows.map((r) => [r.id, r.data || {}]));

  // An id that came back with no row does not exist (or is outside this
  // tenant). Report it rather than dropping it: a rep who selected 60 and is
  // told about 59 has no way to find the missing one.
  const missing = leadIds.filter((id) => !byId.has(id));

  const held = await heldCount(userId);
  const plan = planClaim(
    rows.map((r) => ({ id: r.id, facts: factsFrom(r.data || {}) })),
    held,
    now,
  );

  const nowIso = new Date(now).toISOString();
  const claimed: string[] = [];
  const lostRace: string[] = [];

  // Chunked, not one Promise.all over 250: a rep claiming their whole cap at
  // once would otherwise open 250 concurrent writes against the bridge.
  const CHUNK = 12;
  for (let i = 0; i < plan.granted.length; i += CHUNK) {
    const chunk = plan.granted.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((id) => {
        const raw = byId.get(id) || {};
        // The owner we OBSERVED, which is what the swap tests against.
        const prevOwner = factsFrom(raw).assignedTo;
        let q = db
          .from("tenant_records")
          .update({ data: { ...raw, ...claimPatch(userId, nowIso) }, updated_at: nowIso })
          .eq("id", id)
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("entity_type", "lead");
        // THE SWAP. One statement, so the test and the write cannot be
        // separated by another request. `.is(col, null)` compiles to
        // `IS NULL` on both backends; `.eq` to an equality on the extracted
        // JSON value. Note this is deliberately NOT `.is(col, "not.null")` --
        // that spelling works only against our Turso adapter and 500s on
        // supabase-js (see scores.ts).
        q = prevOwner === null
          ? q.is("data->>assigned_to", null)
          : q.eq("data->>assigned_to", prevOwner);
        return q.select("id");
      }),
    );
    results.forEach((res, idx) => {
      const id = chunk[idx];
      const won =
        res.status === "fulfilled" &&
        !res.value.error &&
        ((res.value.data as unknown[] | null)?.length ?? 0) === 1;
      // Zero rows updated means the owner changed between our read and our
      // write. That is the whole point of the swap: the rep is told somebody
      // else got there first, rather than being told they own a lead they do
      // not. A genuine write error lands here too, which is correct -- an
      // unconfirmed claim must never be reported as a claim.
      if (won) claimed.push(id);
      else lostRace.push(id);
    });
  }

  /**
   * THE CAP, RE-CHECKED AFTER THE FACT.
   *
   * The per-lead swap makes each claim exclusive; it does nothing about the
   * rep's own total. Two overlapping requests from one rep -- two browser tabs,
   * a double submit -- both read heldCount = 200, both grant 50, and the rep
   * ends with 300 against an advertised ceiling of 250. Codex caught it
   * (2026-08-23).
   *
   * A truly atomic reservation needs a counter row or a transaction the bridge
   * does not expose. What it does NOT need is to be left wrong: the cap is a
   * business limit, not a security boundary, so the honest fix is to converge
   * rather than to pretend. Re-count after writing, and if this request pushed
   * the rep over, immediately release the excess -- the ones this request just
   * took, newest first, so a concurrent request's leads are never the ones
   * yanked -- and report them as capacity refusals, which is what they are.
   *
   * The rep sees the truth either way: "you now hold 250 of 250", and the
   * leads they did not get named as over the limit.
   */
  let overflowRefused: ClaimPlan["refused"] = [];
  if (claimed.length > 0) {
    const after = await heldCount(userId);
    const excess = after - MAX_LEADS_PER_REP;
    if (excess > 0) {
      const giveBack = claimed.slice(-excess);
      await releaseLeads(userId, false, giveBack);
      overflowRefused = giveBack.map((id) => ({ id, reason: "at_capacity" as const }));
      for (const id of giveBack) {
        const i = claimed.indexOf(id);
        if (i >= 0) claimed.splice(i, 1);
      }
    }
  }

  return {
    claimed,
    refused: [
      ...plan.refused,
      ...overflowRefused,
      // Surfaced with a reason the UI can render rather than swallowed. An id
      // that came back with no row does not exist or is outside this tenant --
      // a rep who selected 60 and is told about 59 has no way to find the
      // missing one.
      ...missing.map((id) => ({ id, reason: "held" as const })),
    ],
    lostRace,
    held: held + claimed.length,
    cap: MAX_LEADS_PER_REP,
  };
}

/**
 * Return leads to the pool.
 *
 * A rep may release only their OWN leads; an admin may release anyone's. The
 * check is here rather than in the route because it is a property of the
 * operation, not of the HTTP layer -- and because a release that silently
 * skipped rows the caller did not own would report success for work it did not
 * do (see assign.ts on half-assigned territories).
 */
export async function releaseLeads(
  userId: string,
  isAdmin: boolean,
  leadIds: string[],
): Promise<{ released: string[]; refused: string[] }> {
  if (leadIds.length === 0) return { released: [], refused: [] };
  const db = getServiceSupabase();

  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .in("id", leadIds);
  if (error) throw new Error(`release_read_failed: ${error.message}`);

  const rows = (data || []) as { id: string; data: Record<string, unknown> }[];
  const nowIso = new Date().toISOString();
  const released: string[] = [];
  const refused: string[] = [];

  const allowed = rows.filter((r) => {
    const facts = factsFrom(r.data || {});
    if (isAdmin) return Boolean(facts.assignedTo);
    return isInBookOf(facts, userId);
  });
  for (const r of rows) if (!allowed.includes(r)) refused.push(r.id);

  const CHUNK = 12;
  for (let i = 0; i < allowed.length; i += CHUNK) {
    const chunk = allowed.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((r) => {
        const prevOwner = factsFrom(r.data || {}).assignedTo;
        return db
          .from("tenant_records")
          .update({ data: { ...(r.data || {}), ...releasePatch() }, updated_at: nowIso })
          .eq("id", r.id)
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("entity_type", "lead")
          // THE SAME SWAP AS CLAIMING, and for a sharper reason. An
          // unconditional release writes back the snapshot read moments ago.
          // If another rep claimed a stale lead in between, that write both
          // restores the stale data AND clears the new owner -- silently
          // erasing someone else's claim and putting a lead they are about to
          // call back in the pool for a third rep. Conditioning on the owner we
          // observed means a release can only ever release what we still hold.
          // (Codex review, 2026-08-23.)
          .eq("data->>assigned_to", prevOwner as string)
          .select("id");
      }),
    );
    results.forEach((res, idx) => {
      const id = chunk[idx].id;
      if (res.status === "fulfilled" && !res.value.error && (res.value.data as unknown[] | null)?.length === 1) {
        released.push(id);
      } else {
        refused.push(id);
      }
    });
  }

  return { released, refused };
}

/** Availability for a single already-read lead. Exported so the list read can
 *  filter the pool without re-deriving the rules at the call site -- one
 *  definition of "claimable", used everywhere. */
export function isClaimable(data: Record<string, unknown>, now: number): boolean {
  return availability(factsFrom(data || {}), now).available;
}
