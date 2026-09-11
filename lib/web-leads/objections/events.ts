/**
 * Writes to objection_event. This is the hot path: a rep taps a card while a
 * stranger is talking, so every decision here is subordinate to the tap landing.
 *
 * WHY IDEMPOTENCY IS NOT OPTIONAL. leadgen_call_outcomes shipped with a working
 * UI and sat at zero rows, and the lesson taken from that is that log rate is
 * the whole feature. The corollary is that a rep who taps twice because the
 * first tap did not visibly land must not create two objections -- otherwise
 * the Phase 3 scoreboard reports inflated counts with a straight face. The
 * client sends a stable requestId; the unique index on (tenant_id, request_id)
 * makes the retry a no-op that returns the original row.
 *
 * TENANT PINNING IS THE AUTHORIZATION BOUNDARY. Every read and write pins
 * WEBDEV_TENANT_ID, including the PATCH, so an event id guessed from another
 * tenant cannot be resolved or edited.
 *
 * AND THE LEAD IS A BOUNDARY TOO, not just the tenant. The routes authorize
 * with `accessMode: "owned_oasis_sales"`, which is per-LEAD ownership, so the
 * PATCH pins lead_record_id alongside tenant_id -- see patchObjectionEvent.
 */

import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import { safeFilterValue } from "@/lib/web-leads/audit";
import {
  type ObjectionEventRecord,
  type ObjectionResolution,
} from "./types";

export class ObjectionEventError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ObjectionEventError";
    this.code = code;
  }
}

const EVENT_COLUMNS =
  "id, objection_id, response_id, used_variant, resolution, occurred_at";

function toRecord(row: {
  id: string; objection_id: string; response_id: string | null;
  used_variant: number | boolean; resolution: string | null; occurred_at: string;
}): ObjectionEventRecord {
  return {
    id: row.id,
    objectionId: row.objection_id,
    responseId: row.response_id,
    // libSQL hands back 0/1. A === true here would report every event as
    // library-worded and make the Phase 3 variant comparison meaningless.
    usedVariant: Number(row.used_variant) === 1,
    resolution: (row.resolution as ObjectionResolution | null) ?? null,
    occurredAt: row.occurred_at,
  };
}

/**
 * PURE, and exported for tests. Decides what lands in the NOT NULL business_id
 * column.
 *
 * `leadgen_businesses.id` is the key leadgen_call_outcomes uses, reached through
 * `data.webdev_source_business_id` on the promoted lead. When that pointer is
 * absent the objection must still be loggable, so the lead's own
 * `tenant_records.id` is used -- the same decision lib/web-leads/outcome.ts
 * documents and for the same reason.
 *
 * THE CONSEQUENCE, stated because a later aggregate must respect it: a fallback
 * row's business_id will NOT join to leadgen_businesses. `usedFallback` is
 * returned rather than inferred so callers and the Phase 3 scoreboard can count
 * those rows in a visible bucket instead of dropping them on an inner join.
 */
export function resolveEventKeys(lead: { id: string; businessId: string | null | undefined }): {
  businessId: string;
  leadRecordId: string;
  usedFallback: boolean;
} {
  const pointer = typeof lead.businessId === "string" ? lead.businessId.trim() : "";
  if (pointer) {
    return { businessId: pointer, leadRecordId: lead.id, usedFallback: false };
  }
  return { businessId: lead.id, leadRecordId: lead.id, usedFallback: true };
}

export async function logObjectionEvent(args: {
  lead: { id: string; businessId: string | null | undefined };
  objectionId: string;
  responseId: string | null;
  usedVariant: boolean;
  repUserId: string;
  requestId: string;
}): Promise<{ event: ObjectionEventRecord; idempotent: boolean }> {
  const db = getServiceSupabase();
  const keys = resolveEventKeys(args.lead);
  const nowIso = new Date().toISOString();

  const ins = await db
    .from("objection_event")
    .insert({
      id: randomUUID(),
      tenant_id: WEBDEV_TENANT_ID,
      business_id: keys.businessId,
      lead_record_id: keys.leadRecordId,
      rep_user_id: args.repUserId,
      objection_id: args.objectionId,
      response_id: args.responseId,
      used_variant: args.usedVariant ? 1 : 0,
      resolution: null,
      occurred_at: nowIso,
      request_id: args.requestId,
      created_at: nowIso,
    })
    .select(EVENT_COLUMNS)
    .maybeSingle();

  if (!ins.error && ins.data) {
    return { event: toRecord(ins.data as never), idempotent: false };
  }

  // A retry of a tap that DID land. Return the original row rather than an
  // error: from the rep's side the objection is logged either way, and an
  // error here would train them to tap a third time.
  if (ins.error && isUniqueViolationError(ins.error)) {
    const existing = await db
      .from("objection_event")
      .select(EVENT_COLUMNS)
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("request_id", args.requestId)
      .maybeSingle();
    if (existing.error || !existing.data) {
      throw new ObjectionEventError("request_id_conflict", "duplicate request id could not be resolved");
    }
    return { event: toRecord(existing.data as never), idempotent: true };
  }

  throw new ObjectionEventError(
    "objection_event_write_failed",
    ins.error ? ins.error.message : "insert returned no row",
  );
}

/**
 * Attaches the answer a rep actually used, or the outcome of the exchange, to
 * an event already logged. All three fields are optional and independent: a
 * rep may tap the objection and never resolve it, which is normal and must
 * stay cheap.
 *
 * `leadRecordId` IS NOT OPTIONAL, and it is not decoration. The PATCH route
 * proves the caller may work the lead in its own URL
 * (`assertMayWorkLead(..., accessMode: "owned_oasis_sales")`), which is a
 * PER-LEAD ownership boundary, not a tenant one. Pinning only tenant_id and id
 * here left nothing tying the event to that lead, so a rep who owns lead A
 * could attach a resolution or a response to an event belonging to lead B,
 * owned by another rep, by putting lead A's id in the path. Not remotely
 * exploitable today (event ids are only ever exposed through the owning
 * lead's own GET), but a URL that does not mean what it says is a trap for
 * the next caller. Final whole-branch review, BLOCKING 5.
 *
 * lead_record_id is the right column for it rather than business_id:
 * logObjectionEvent writes `resolveEventKeys().leadRecordId`, which is always
 * the lead's own tenant_records.id, whereas business_id is the leadgen pointer
 * when one exists and the lead id only as a fallback.
 */
export async function patchObjectionEvent(args: {
  eventId: string;
  leadRecordId: string;
  responseId?: string | null;
  usedVariant?: boolean;
  resolution?: ObjectionResolution;
}): Promise<ObjectionEventRecord> {
  const db = getServiceSupabase();

  // Charset-allowlisted before it reaches the PostgREST filter, same treatment
  // as fetchLeadEvents below and the sibling fetchRecentOutcomes in
  // lib/web-leads/outcome.ts. Fails CLOSED: an id that cannot be safely
  // filtered is a not-found, never an unscoped update.
  const leadRecordId = safeFilterValue(args.leadRecordId || "");
  if (!leadRecordId) {
    throw new ObjectionEventError("not_found", "no such event for this tenant");
  }

  const patch: Record<string, unknown> = {};
  if (args.responseId !== undefined) patch.response_id = args.responseId;
  if (args.usedVariant !== undefined) patch.used_variant = args.usedVariant ? 1 : 0;
  if (args.resolution !== undefined) {
    patch.resolution = args.resolution;
    patch.resolved_at = new Date().toISOString();
  }
  if (Object.keys(patch).length === 0) {
    throw new ObjectionEventError("empty_patch", "nothing to update");
  }

  /**
   * THE RESPONSE MUST BE APPROVED AND MUST BELONG TO THIS EVENT'S OBJECTION.
   *
   * Codex audit, P1. The POST path in app/api/web-leads/[id]/objections/route.ts
   * resolves the objection from the approved catalog and confirms the supplied
   * responseId is one of THAT objection's answers before writing. That check was
   * never carried across to here, and the BLOCKING-5 fix made this branch
   * reachable from a client for the first time -- so a stale or malformed client
   * could attach another objection's response, or a draft response, to an event.
   * response_id is the column the four-posture model exists to populate and the
   * one Phase 3 reads to answer "which way of answering recovers the deal", so a
   * wrong pairing there is not a cosmetic defect: it is a silently wrong answer
   * to the question the feature was built for.
   *
   * ENFORCED ON THE WRITE STATEMENT, not by a read-then-write. One read resolves
   * which objection the response belongs to and proves it is approved; that
   * objection id then becomes a filter on the UPDATE itself, so an event whose
   * objection_id differs simply matches NO ROW and falls out as the existing
   * not_found. Same reason the tenant and lead pins live on the statement: a
   * pairing checked before a separate write is a pairing a concurrent request
   * can slip past.
   *
   * Only when a response id is actually being SET. `null` clears the column and
   * has no pairing to verify.
   */
  let responseObjectionId: string | null = null;
  if (typeof args.responseId === "string" && args.responseId.trim()) {
    const responseId = safeFilterValue(args.responseId.trim());
    if (!responseId) {
      throw new ObjectionEventError("unknown_response", "response id is not a usable identifier");
    }
    const resp = await db
      .from("objection_response")
      .select("objection_id")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("id", responseId)
      // A DRAFT or RETIRED answer must never be recorded as the one a rep used.
      // Same approval rule the console read enforces, applied to the write.
      .eq("status", "approved")
      .maybeSingle();
    if (resp.error) {
      throw new ObjectionEventError("objection_response_read_failed", resp.error.message);
    }
    if (!resp.data) {
      throw new ObjectionEventError("unknown_response", "no such approved response for this tenant");
    }
    responseObjectionId = safeFilterValue(String((resp.data as { objection_id: string }).objection_id));
    if (!responseObjectionId) {
      throw new ObjectionEventError("unknown_response", "response is not attached to a usable objection");
    }
  }

  let q = db
    .from("objection_event")
    .update(patch)
    // The tenant pin is on the UPDATE itself, not on a prior read. A check
    // that happens before the write is a check a concurrent request can slip
    // past; this one is part of the same statement.
    .eq("tenant_id", WEBDEV_TENANT_ID)
    // The lead scope rides on the same statement, for the same reason the
    // tenant pin does: an event that belongs to another lead must be
    // untouchable, not merely un-fetched by a prior read.
    .eq("lead_record_id", leadRecordId)
    .eq("id", args.eventId);

  // The pairing constraint, on the same statement as the write (see above).
  if (responseObjectionId !== null) q = q.eq("objection_id", responseObjectionId);

  const { data, error } = await q.select(EVENT_COLUMNS).maybeSingle();

  if (error) throw new ObjectionEventError("objection_event_patch_failed", error.message);
  // Deliberately the same message whether the event does not exist, belongs to
  // another tenant, belongs to another lead, or belongs to a DIFFERENT
  // OBJECTION than the response being attached: the route answers 404 for all
  // four, so neither an event id nor a response id is probeable through this
  // endpoint.
  if (!data) throw new ObjectionEventError("not_found", "no such event for this lead");
  return toRecord(data as never);
}

/**
 * How far back an objection_event still counts as "this call".
 *
 * WHY THERE IS A WINDOW AT ALL. This read used to fetch the lead's last 50
 * events with no bound, and ObjectionCard sets `logged = Boolean(existingEvent)`
 * and disables the tap when logged. So from the second call onward, every
 * objection the rep had ever tapped on that lead showed "Logged" behind a dead
 * control, and the same objection coming up again could not be recorded. That
 * systematically under-counts precisely the RECURRING objections the Phase 3
 * scoreboard exists to rank, and log rate is this feature's whole premise.
 * (Final whole-branch review, BLOCKING 3.)
 *
 * WHY A WINDOW AND NOT objection_event.call_outcome_id. That column exists in
 * migration 171 for exactly this and is still not written, for a reason worth
 * stating rather than leaving as an apparent oversight: a call outcome is
 * logged at the END of a call (CallOutcomeLog), and an objection is tapped
 * DURING it, so at insert time the id does not exist yet. Writing it properly
 * means back-stamping every objection event when the outcome lands, which is a
 * second write on the outcome path and Phase 2 work. A time window needs no
 * new plumbing on the hot path and is correct for the thing the console
 * actually uses this for.
 *
 * WHY 90 MINUTES. It has to be longer than a call plus any reload inside it
 * (a rep who refreshes mid-call must not be handed a fresh card and log the
 * same objection twice -- the requestId is minted per card MOUNT, so a reload
 * does not dedupe), and shorter than the gap to a genuinely later call, which
 * on this desk is days: "call me back in a few months" is a seeded objection.
 * 90 minutes is comfortably inside that gap. The cost of the remaining error
 * is asymmetric in the right direction: a redial inside 90 minutes shows a
 * stale "Logged" (an under-count of one, on a rare path), where a window too
 * short double-counts one objection in one call and quietly inflates the
 * scoreboard.
 */
export const SAME_CALL_WINDOW_MINUTES = 90;

/**
 * This lead's objection events from the CURRENT call only, most recent first,
 * so the console can show which cards were already tapped on this call and
 * leave every other card tappable.
 *
 * "Current call" means the last SAME_CALL_WINDOW_MINUTES -- see that constant
 * for why. THE CONSEQUENCE, stated so nothing downstream assumes otherwise:
 * this is NOT the lead's objection history and must never be used as one. A
 * manager opening the battle card a day later sees no "Logged" marks and no
 * resolutions, which is correct for a live-call surface; lead-lifetime
 * history is the Phase 3 scoreboard's job, reading objection_event directly.
 */
export async function fetchLeadEvents(lead: {
  id: string;
  businessId: string | null | undefined;
}): Promise<ObjectionEventRecord[]> {
  const db = getServiceSupabase();
  const keys = resolveEventKeys(lead);
  // Both keys, because a lead promoted after some calls has rows under the
  // fallback id AND rows under the real business id. Querying one loses half
  // the history and the console would offer a card the rep already tapped.
  // Charset-allowlisted before reaching the PostgREST filter, same treatment
  // as the sibling fetchRecentOutcomes in lib/web-leads/outcome.ts.
  const ids = Array.from(new Set([keys.businessId, keys.leadRecordId]
    .map((value) => safeFilterValue(value || ""))
    .filter((value): value is string => Boolean(value))));

  // occurred_at is written as `new Date().toISOString()` on every insert, so
  // every stored value is a fixed-width UTC ISO-8601 string and a lexical >=
  // is a chronological >=. Computing the cutoff the same way keeps the two
  // sides in the same representation.
  const since = new Date(Date.now() - SAME_CALL_WINDOW_MINUTES * 60_000).toISOString();

  const { data, error } = await db
    .from("objection_event")
    .select(EVENT_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .in("business_id", ids)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(50);

  if (error) throw new ObjectionEventError("objection_event_read_failed", error.message);
  return ((data || []) as never[]).map(toRecord);
}
