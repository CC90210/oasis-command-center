/**
 * POST /api/offer-events
 *
 * Public, unauthenticated funnel-tracking beacon (V5a, HANDOVER section 5).
 * Called with navigator.sendBeacon from lib/offers/tracking-client.ts on
 * every offer page and every public form. No session exists for this caller
 * — the same category of surface as /api/forms/submit and /api/perf/vitals
 * (middleware.ts's PUBLIC_PATH_PREFIXES; this route self-gates below).
 *
 * FAIL QUIET, ALWAYS 204. A bad shape, an unknown/disabled form, a rate
 * limit, a missing table, a DB error: every one of these answers the exact
 * same empty 204 the happy path does. This is deliberate, not sloppy error
 * handling — the one thing this endpoint must never do is let a response
 * tell a caller whether a tenant or form slug exists (the same "collapse
 * every negative case" rule lib/forms/public-resolver.ts documents for the
 * submit route). A sendBeacon caller never reads the response anyway.
 *
 * THE SERVER DECIDES, NEVER THE BODY:
 *   - tenant_id/form_id come ONLY from resolvePublicForm(tenant slug, form
 *     slug), which also requires the form to be `enabled` — a body can send
 *     any tenant/form slug it likes, but it can never attach an event to a
 *     tenant_id it supplies directly.
 *   - the event name is checked against the fixed vocabulary
 *     (lib/offers/tracking-store.ts:isValidFunnelEvent).
 *   - detail is re-built from an explicit per-event whitelist
 *     (sanitizeFunnelDetail), never stored verbatim.
 *   - lead_id is NEVER read from the body (there is no such field in `Body`
 *     at all). insertFunnelEvent resolves it itself from the persistent
 *     offer_funnel_visit_leads mapping (Codex review, PR #598, 2026-10-12
 *     [P2]), so an event arriving long after submit -- this route's own
 *     normal case, since every event lands here, not just the first one --
 *     still lands linked, without ever trusting a client-supplied id.
 *
 * NO PII, EVER: no IP, no User-Agent, no cookie is read or stored here. The
 * only identifier is the client-generated visit_id (opaque, no server
 * round-trip to mint it) — see the migration's privacy note.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { rateLimit } from "@/lib/rate-limit";
import {
  offerPagesDb,
  insertFunnelEvent,
  isValidFunnelEvent,
  isValidVisitId,
  sanitizeFunnelDetail,
  sanitizeStepIndex,
} from "@/lib/offers/tracking-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard cap on the raw request body — this payload is a handful of short fields. */
const MAX_BODY_BYTES = 2 * 1024;

const EMPTY_204 = () => new NextResponse(null, { status: 204 });

type Body = {
  tenant?: unknown;
  form?: unknown;
  visit_id?: unknown;
  event?: unknown;
  step_index?: unknown;
  detail?: unknown;
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Top-level catch: whatever breaks below, this public caller (a
  // sendBeacon that never reads the response, or a keepalive fetch) always
  // gets the same empty 204 — never an uncaught 500. Same rule
  // /api/forms/submit's own top-level catch documents.
  try {
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return EMPTY_204();
    }
    // Byte cap BEFORE JSON.parse — a huge string must never reach the parser.
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return EMPTY_204();

    let body: Body;
    try {
      body = JSON.parse(raw) as Body;
    } catch {
      return EMPTY_204();
    }
    if (!body || typeof body !== "object") return EMPTY_204();

    const tenantSlug = typeof body.tenant === "string" ? body.tenant : "";
    const formSlug = typeof body.form === "string" ? body.form : "";
    const visitId = body.visit_id;
    const event = body.event;
    if (!tenantSlug || !formSlug || !isValidVisitId(visitId) || !isValidFunnelEvent(event)) {
      return EMPTY_204();
    }

    // Per-visit rate limit, BEFORE any DB read. One visit firing page_view,
    // several step_viewed/step_submitted and four video_progress checkpoints
    // comfortably fits in well under a minute; 60/min leaves headroom without
    // opening a flood vector.
    const limit = rateLimit({ key: `offer-events:${visitId}`, capacity: 60, refillPerSec: 1 });
    if (!limit.allowed) return EMPTY_204();

    // Resolve tenant_id/form_id SERVER-SIDE. A body's tenant/form slug can
    // never widen to another tenant's id, and an unknown or disabled form
    // collapses to the identical "not_found" resolvePublicForm already uses
    // for the submit route — so this probe can't be used to enumerate
    // tenants or form names either.
    const resolved = await resolvePublicForm(getServiceSupabase(), tenantSlug, formSlug);
    if (!resolved.ok) return EMPTY_204();

    const db = offerPagesDb();
    if (!db) return EMPTY_204();

    const stepIndex = sanitizeStepIndex(body.step_index);
    const detail = sanitizeFunnelDetail(event, body.detail);

    await insertFunnelEvent(db, {
      tenantId: resolved.tenant_id,
      formId: resolved.form.id,
      visitId,
      event,
      stepIndex,
      detail,
    });

    return EMPTY_204();
  } catch (err) {
    console.error("/api/offer-events crashed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return EMPTY_204();
  }
}
