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
 * NO PII, EVER: no IP, no User-Agent, no cookie is READ OR STORED on the
 * row — the only identifier that reaches offer_funnel_events is the
 * client-generated visit_id (opaque, no server round-trip to mint it); see
 * the migration's privacy note. getClientIp(req) below (CodeRabbit,
 * PRRT_kwDOSgetsc6rd9DP, 2026-10-12) is the ONE exception, and it is a
 * narrow one: the IP is used ONLY as an in-memory rate-limit bucket key,
 * never written to any row, log, or response. It is gone the moment the
 * process's rate-limit map evicts or restarts it. Law 25 compliance is
 * unchanged -- this is identical to how /api/forms/submit already uses the
 * same helper for its own per-token bucket, just keyed differently.
 *
 * THREE RATE LIMITS, ALL BEFORE THE DATABASE READ (CodeRabbit,
 * PRRT_kwDOSgetsc6rd9DP): the per-visit limit alone does nothing against a
 * script that mints a fresh random visit_id on every request -- each one
 * gets its own full bucket, so a flood of distinct visit_ids reaches
 * resolvePublicForm and writes a row unbounded, inflating a form's Views
 * count. The per-sender (IP) and per-form limits catch exactly that: a
 * flood from one sender, or one targeting one form, is capped regardless of
 * how many visit_ids it rotates through.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getClientIp } from "@/lib/api-helpers";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { readCappedJson } from "@/lib/offer-pages/public-http";
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
    // 2026-10-18: cap the stream itself. req.text() buffered a chunked public
    // request in full before the old post-read size check could reject it.
    const body = await readCappedJson(req, MAX_BODY_BYTES) as Body | null;
    if (!body) return EMPTY_204();

    const tenantSlug = typeof body.tenant === "string" ? body.tenant : "";
    const formSlug = typeof body.form === "string" ? body.form : "";
    const visitId = body.visit_id;
    const event = body.event;
    if (!tenantSlug || !formSlug || !isValidVisitId(visitId) || !isValidFunnelEvent(event)) {
      return EMPTY_204();
    }

    // RATE LIMITS. lib/rate-limit.ts keeps one in-memory bucket per key with
    // no eviction, so every limiter key here must have BOUNDED cardinality:
    // a key built from a client-chosen value (visit_id, raw slugs) lets one
    // sender mint unlimited buckets and exhaust the isolate's memory
    // (independent review, 2026-10-12, HIGH). Hence: no per-visit limiter,
    // and the per-form limiter keys on the RESOLVED form id, after lookup.
    //
    // 1. Per-sender (IP), BEFORE any DB read (CodeRabbit, PRRT_kwDOSgetsc6rd9DP):
    // bounds a flood that mints a fresh visit_id on every request, and
    // bounds how many form lookups one sender can cause. 300/min is generous
    // enough for a shared office IP legitimately running several visitors'
    // sessions. The IP itself is never stored -- see the file doc comment.
    const ip = getClientIp(req);
    const ipLimit = rateLimit({ key: `offer-events:ip:${ip}`, capacity: 300, refillPerSec: 5 });
    if (!ipLimit.allowed) return EMPTY_204();

    // Resolve tenant_id/form_id SERVER-SIDE. A body's tenant/form slug can
    // never widen to another tenant's id, and an unknown or disabled form
    // collapses to the identical "not_found" resolvePublicForm already uses
    // for the submit route — so this probe can't be used to enumerate
    // tenants or form names either.
    const resolved = await resolvePublicForm(getServiceSupabase(), tenantSlug, formSlug);
    if (!resolved.ok) return EMPTY_204();

    // 2. Per-form, keyed on the resolved form id (one bucket per real form,
    // never per invented slug). Bounds a flood targeting one form's Views
    // count even across many distinct IPs and visit_ids.
    const formLimit = rateLimit({ key: `offer-events:form:${resolved.form.id}`, capacity: 600, refillPerSec: 10 });
    if (!formLimit.allowed) return EMPTY_204();

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
