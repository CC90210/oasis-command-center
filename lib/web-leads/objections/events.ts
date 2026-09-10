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
 */

import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
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
 * an event already logged. Both fields are optional and independent: a rep may
 * tap the objection and never resolve it, which is normal and must stay cheap.
 */
export async function patchObjectionEvent(args: {
  eventId: string;
  responseId?: string | null;
  usedVariant?: boolean;
  resolution?: ObjectionResolution;
}): Promise<ObjectionEventRecord> {
  const db = getServiceSupabase();

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

  const { data, error } = await db
    .from("objection_event")
    .update(patch)
    // The tenant pin is on the UPDATE itself, not on a prior read. A check
    // that happens before the write is a check a concurrent request can slip
    // past; this one is part of the same statement.
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", args.eventId)
    .select(EVENT_COLUMNS)
    .maybeSingle();

  if (error) throw new ObjectionEventError("objection_event_patch_failed", error.message);
  if (!data) throw new ObjectionEventError("not_found", "no such event for this tenant");
  return toRecord(data as never);
}

/** This lead's objection history, most recent first, so the console can show
 *  which cards were already tapped on this call. */
export async function fetchLeadEvents(lead: {
  id: string;
  businessId: string | null | undefined;
}): Promise<ObjectionEventRecord[]> {
  const db = getServiceSupabase();
  const keys = resolveEventKeys(lead);
  // Both keys, because a lead promoted after some calls has rows under the
  // fallback id AND rows under the real business id. Querying one loses half
  // the history and the console would offer a card the rep already tapped.
  const ids = Array.from(new Set([keys.businessId, keys.leadRecordId]));

  const { data, error } = await db
    .from("objection_event")
    .select(EVENT_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .in("business_id", ids)
    .order("occurred_at", { ascending: false })
    .limit(50);

  if (error) throw new ObjectionEventError("objection_event_read_failed", error.message);
  return ((data || []) as never[]).map(toRecord);
}
