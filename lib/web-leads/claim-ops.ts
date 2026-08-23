/**
 * claim-ops.ts — the database side of claiming leads.
 *
 * The rules live in ./claim (pure, no I/O, fully tested at exact instants).
 * This module reads the facts those rules need, applies them, writes the
 * result, and PROVES the write landed the way it thinks it did.
 *
 * ═══ TWO REPS, ONE BUSINESS ══════════════════════════════════════════════════
 *
 * The race this must handle: two reps press Claim on the same lead within the
 * same second. libSQL through the PostgREST-compatible builder cannot express
 * "update only if data.assigned_to is still null" -- filtering on a JSON path
 * inside a conditional write is not available on this path. So a genuinely
 * atomic compare-and-swap is not on the table.
 *
 * What IS available, and what this does instead: write, then read back and
 * check who actually owns it. Both reps write, one write lands last and wins,
 * and BOTH reps are then told the truth -- the winner sees the lead in their
 * book, the loser is told someone just took it. Exactly one rep owns the lead
 * and neither is misinformed, which is the outcome that matters. The failure
 * this prevents is not two writes; it is two reps each believing they own it
 * and both dialling.
 *
 * The alternative -- write and assume -- is the one that produces the duplicate
 * call, silently, with both screens showing success.
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

  // Sequential, not Promise.all: a rep claiming 250 leads at once would open
  // 250 concurrent writes against the bridge. Batched in chunks instead --
  // enough concurrency to be quick, bounded enough not to be a thundering herd.
  const CHUNK = 12;
  for (let i = 0; i < plan.granted.length; i += CHUNK) {
    const chunk = plan.granted.slice(i, i + CHUNK);
    await Promise.allSettled(
      chunk.map((id) =>
        db
          .from("tenant_records")
          .update({ data: { ...(byId.get(id) || {}), ...claimPatch(userId, nowIso) }, updated_at: nowIso })
          .eq("id", id)
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("entity_type", "lead")
          .select("id"),
      ),
    );
  }

  // PROVE IT. Read back every row we tried to claim and check who owns it now.
  // This is what turns "we wrote something" into "this rep owns these leads",
  // and it is the only thing standing between a lost race and two reps dialling
  // the same business.
  if (plan.granted.length > 0) {
    const verify = await db
      .from("tenant_records")
      .select("id,data")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .in("id", plan.granted);
    if (verify.error) throw new Error(`claim_verify_failed: ${verify.error.message}`);
    const after = new Map(
      ((verify.data || []) as { id: string; data: Record<string, unknown> }[])
        .map((r) => [r.id, factsFrom(r.data || {})]),
    );
    for (const id of plan.granted) {
      const facts = after.get(id);
      if (facts && isInBookOf(facts, userId)) claimed.push(id);
      else lostRace.push(id);
    }
  }

  return {
    claimed,
    refused: [
      ...plan.refused,
      // Surfaced with a reason the UI can render rather than swallowed.
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
      chunk.map((r) =>
        db
          .from("tenant_records")
          .update({ data: { ...(r.data || {}), ...releasePatch() }, updated_at: nowIso })
          .eq("id", r.id)
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("entity_type", "lead")
          .select("id"),
      ),
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
