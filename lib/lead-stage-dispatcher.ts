/**
 * lib/lead-stage-dispatcher.ts — tenant-aware lead-stage-event router.
 *
 * Routes every lead-stage event to the right engine based on the
 * tenant's slug:
 *
 *   - SunBiz (slug starts with "sun" or "submissions") → lib/lead-stage-engine.ts
 *     (Salesforce-parity funding funnel: hot_lead → ... → submitted;
 *     migration 064 retired imported / not_interested / approved)
 *
 *   - OASIS (slug starts with "oasis") → lib/oasis-lead-stage-engine.ts
 *     (14-stage Website Sales Engine lifecycle: researched → assigned →
 *     attempting_contact → ... → launched)
 *
 *   - Anything else → no-op (returns { fired: false, reason: "no_rule" }).
 *
 * The two engines share a near-identical Event union for the events
 * that overlap (`outbound_email_queued`, `outbound_email_sent`,
 * `lead_replied_negative`); the dispatcher accepts the SunBiz-shaped
 * union and narrows to the OASIS variant when the tenant matches.
 * Events that exist only on the OASIS side (proposal_sent,
 * contract_signed, etc.) need their own call path — the dispatcher
 * doesn't synthesize them from SunBiz events.
 *
 * Use this from API routes / webhooks instead of importing the engines
 * directly so the call site doesn't have to repeat the tenant-detection
 * boilerplate.
 */

import { revalidatePath } from "next/cache";
import { getServiceSupabase } from "./supabase-server";
import { recordLeadStageEvent, type LeadStageEvent, type LeadStageRecordResult } from "./lead-stage-engine";
import { recordOasisLeadStageEvent, type OasisLeadStageEvent } from "./oasis-lead-stage-engine";

type DispatchResult =
  | LeadStageRecordResult
  | { fired: false; reason: "no_rule" | "error" };

/**
 * Invalidate every Next.js cached path that renders the lead's stage so
 * the operator sees the update everywhere — kanban, lead detail,
 * tenant-shell pipeline. Called from every successful stage-event
 * dispatch so callers (API routes, cloud tools, webhooks) don't have
 * to remember to do it themselves. Pre-extraction this lived inline
 * in two places and would inevitably drift.
 */
function invalidateLeadStagePaths(leadId: string): void {
  try {
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${leadId}`);
    // Tenant-shell pipeline reads the same record; broad /t segment
    // invalidation refetches SunBiz / OASIS / future tenants' shells.
    revalidatePath("/t", "layout");
  } catch (err) {
    // Best-effort. Cache invalidation failure should never break the
    // stage transition itself — the engine already updated the DB,
    // the operator just sees a stale render until next manual refresh.
    console.error("[lead-stage-dispatcher.invalidate]", err);
  }
}

async function tenantSlugFor(tenantId: string): Promise<string | null> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    return (r.data?.slug || null) as string | null;
  } catch (err) {
    console.error("[lead-stage-dispatcher] tenant lookup failed", err);
    return null;
  }
}

function eventToOasis(event: LeadStageEvent): OasisLeadStageEvent | null {
  // SunBiz event types that overlap with OASIS (same trigger, different
  // target stage). The OASIS engine narrows the rest of the union with
  // its own dispatch.
  switch (event.type) {
    case "outbound_email_queued":
    case "outbound_email_sent":
    case "lead_replied_negative":
      return { type: event.type, tenantId: event.tenantId, leadId: event.leadId };
    default:
      // doc_uploaded, email_opened, email_clicked, form_signed,
      // sequence_exhausted — all SunBiz-only triggers. No OASIS equivalent yet.
      return null;
  }
}

/**
 * Dispatch a SunBiz-shaped LeadStageEvent to whichever engine the
 * tenant uses. Always returns a result object even when the tenant
 * doesn't have an applicable rule, so callers can branch on `fired`
 * without worrying about nulls.
 */
export async function dispatchLeadStageEvent(event: LeadStageEvent): Promise<DispatchResult> {
  const slug = (await tenantSlugFor(event.tenantId))?.toLowerCase() || "";
  let result: DispatchResult;
  if (slug.startsWith("oasis")) {
    const oasisEvent = eventToOasis(event);
    if (!oasisEvent) return { fired: false, reason: "no_rule" };
    result = await recordOasisLeadStageEvent(oasisEvent);
  } else {
    // SunBiz tenants (slug starts with "sun" or "submissions") and any
    // other legacy tenant fall through to the SunBiz engine. That keeps
    // existing call sites working — they were always hitting the SunBiz
    // engine before the dispatcher existed.
    result = await recordLeadStageEvent(event);
  }
  if (result.fired) invalidateLeadStagePaths(event.leadId);
  return result;
}

/**
 * Dispatch an OASIS-specific event (one without a SunBiz equivalent —
 * proposal_sent, contract_signed, etc.). Returns no-op for non-OASIS
 * tenants since the event has no meaning there.
 */
export async function dispatchOasisOnlyEvent(event: OasisLeadStageEvent): Promise<DispatchResult> {
  const slug = (await tenantSlugFor(event.tenantId))?.toLowerCase() || "";
  if (!slug.startsWith("oasis")) return { fired: false, reason: "no_rule" };
  const result = await recordOasisLeadStageEvent(event);
  if (result.fired) invalidateLeadStagePaths(event.leadId);
  return result;
}
