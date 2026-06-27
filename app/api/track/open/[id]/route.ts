/**
 * GET /api/track/open/[id] — email open tracking pixel endpoint.
 *
 * Phase 19 of the SunBiz CRM Reconstructor build (2026-05-17). Every
 * outbound email rendered by scripts/send_gateway.py embeds:
 *
 *   <img src=".../api/track/open/<reservation_id>" width=1 height=1 ...>
 *
 * When the recipient's mail client renders the message, the GET hit
 * lands here. We:
 *
 *   1. Look up the interaction row (the reservation_id from
 *      send_gateway) so we can resolve tenant_id + lead_id WITHOUT
 *      trusting the URL parameter.
 *   2. Insert one row into public.email_open_events. Multiple opens
 *      from the same recipient (re-opens, forwards, multi-device) are
 *      expected and not deduplicated at the DB level — the timeline
 *      renders them as engagement-over-time.
 *   3. Flag `suspicious_prefetch=true` when the open arrives < 60s
 *      after the send. Apple Mail Privacy Protection pre-fetches
 *      images so opens look instant — down-weighted by
 *      sequence_runner's on-open-followup logic instead of dropped
 *      entirely.
 *   4. Emit a BRAVO_EMAIL_OPENED event to agent_events so
 *      sequence_runner.py can fast-forward an on-open follow-up step.
 *   5. Return a 1x1 transparent GIF with cache-control:no-store so
 *      every render hits us (no aggressive caching by mail clients).
 *
 * Failure mode: this route is best-effort — a DB write failure must
 * never break the pixel response (the mail client would log a broken
 * image and that's a worse signal than a silently-missed open). Any
 * error is logged server-side and the GIF is still returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getClientIp } from "@/lib/api-helpers";
import { publishAgentEvent } from "@/lib/manifest/events";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 1x1 transparent GIF, base64 — 43 bytes when decoded.
const TRANSPARENT_GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function gifResponse(): NextResponse {
  const buf = Buffer.from(TRANSPARENT_GIF_B64, "base64");
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  // Tiny non-cryptographic hash so we record a stable identifier
  // without storing the raw IP. djb2 — fine for this use case.
  let h = 5381;
  for (let i = 0; i < ip.length; i++) {
    h = ((h << 5) + h + ip.charCodeAt(i)) & 0xffffffff;
  }
  return "h" + (h >>> 0).toString(16);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = (rawId || "").trim();

  // Always return the pixel; never let body lookup failures leak as
  // a broken image to the recipient.
  if (!id || id.length < 8) return gifResponse();

  try {
    const sb = getServiceSupabase();

    // 1. Resolve tenant_id + lead_id + sent_at from the interaction
    //    row. send_gateway writes interactions/lead_interactions with
    //    id=reservation_id; the exact table name varies across legacy
    //    migrations so we probe lead_interactions first (the canonical
    //    table in current production), falling back to interactions.
    let tenantId: string | null = null;
    let leadId: string | null = null;
    let sentAtMs: number | null = null;
    // 2026-05-22: also pull the email subject so the BRAVO_EMAIL_OPENED
    // event lands on the dashboard event bus with a human-readable
    // caption instead of a blank row. CC noticed inconsistency in the
    // feed: OUTBOUND_RECORDED rows showed "Free 3D Virtual Walkthrough"
    // while EMAIL_OPENED rows were blank.
    let subject: string | null = null;

    const lookupTables = ["lead_interactions", "interactions"];
    for (const table of lookupTables) {
      const { data, error } = await sb
        .from(table)
        .select("id, tenant_id, lead_id, created_at, sent_at, subject")
        .eq("id", id)
        .maybeSingle();
      if (!error && data) {
        const row = data as {
          tenant_id: string | null;
          lead_id: string | null;
          created_at: string | null;
          sent_at: string | null;
          subject: string | null;
        };
        tenantId = row.tenant_id || null;
        leadId = row.lead_id || null;
        subject = row.subject || null;
        const ts = row.sent_at || row.created_at;
        if (ts) sentAtMs = new Date(ts).getTime();
        break;
      }
    }

    if (!tenantId) return gifResponse(); // unknown id — silently drop, return pixel

    const ua = req.headers.get("user-agent") || null;
    const resolvedIp = getClientIp(req);
    const ip = resolvedIp === "unknown" ? null : resolvedIp;
    const ipHash = hashIp(ip);
    const nowMs = Date.now();
    const suspicious =
      sentAtMs !== null && nowMs - sentAtMs < 60_000; // <60s = APMP-likely prefetch

    // Source-level dedup (2026-06-27, CC: "email opened over and over"). The
    // pixel is served no-store, so Gmail / Apple Mail image proxies re-fetch it
    // many times per delivered email — live data showed ONE email producing 23
    // open events for a single lead, flooding the timeline + bloating
    // agent_events. Two rules tame this at the source:
    //
    //   1. Only GENUINE (non-prefetch) opens publish BRAVO_EMAIL_OPENED. A
    //      prefetch (<60s after send — the proxy fetching the image, not a human
    //      read) is recorded in email_open_events for raw telemetry but never
    //      hits the event bus. This keeps proxy noise off the bus AND guarantees
    //      a delivery-time prefetch can't mask the genuine open that follows it.
    //   2. At most ONE genuine open per message PER CALENDAR DAY (UTC). The probe
    //      looks for a genuine BRAVO_EMAIL_OPENED for this outbound_message_id
    //      already published today; if found, this hit is a same-day re-open and
    //      we skip the publish. Day-scoping (not all-time) collapses the same-day
    //      proxy storm while still letting a genuine re-open on a LATER day
    //      publish, so the timeline's distinct-day "seen N days" stays truthful.
    //
    // Stage advance is NOT gated on this (see below) — the engine is idempotent.
    // Fail-open: if the probe errors we publish, so a read blip can't silently
    // drop a real open. Not atomic: a burst of truly-simultaneous first opens can
    // each pass the probe and publish, so a message can still get a couple of
    // same-day rows under a proxy burst; the timeline de-noises those to one row,
    // so the display stays correct. The durable fix is a unique idempotency index
    // on (correlation_id, outbound_message_id, opened_day) — follow-up migration,
    // deliberately not bundled into this no-migration hotfix.
    const dayStart = new Date(nowMs);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayStartIso = dayStart.toISOString();
    let alreadyOpenedToday = false;
    if (!suspicious) {
      try {
        // Supabase returns query failures as { error } on the normal path (no
        // throw), so check BOTH that and a thrown exception. Either way we
        // fail-open (leave alreadyOpenedToday false → publish) so a probe blip
        // never silently drops a real open — but LOG it, because a persistent
        // failure here means same-day storm collapse is degraded and ops must
        // be able to see it rather than wonder why opens are inflating again.
        const { data: prior, error: probeError } = await sb
          .from("agent_events")
          .select("id")
          .eq("event_type", "BRAVO_EMAIL_OPENED")
          .eq("correlation_id", tenantId)
          .contains("payload", {
            outbound_message_id: id,
            suspicious_prefetch: false,
          })
          .gte("published_at", dayStartIso)
          .limit(1);
        if (probeError) {
          console.error("[track/open] dedup probe error — publishing (fail-open)", probeError);
        } else {
          alreadyOpenedToday = Array.isArray(prior) && prior.length > 0;
        }
      } catch (probeErr) {
        console.error("[track/open] dedup probe threw — publishing (fail-open)", probeErr);
      }
    }
    const shouldPublishOpen = !suspicious && !alreadyOpenedToday;

    // Insert with ON CONFLICT DO NOTHING semantics via upsert + the
    // partial unique index (outbound_message_id, ip_hash) added in
    // migration 050. Re-opens from the same recipient don't add new
    // rows; the operator timeline cares "did they open" not the
    // exact re-open count. Anonymous opens (ip_hash null) skip the
    // index and always insert — over-counting anon is the right side
    // of the trade-off.
    await sb
      .from("email_open_events")
      .upsert(
        {
          tenant_id: tenantId,
          outbound_message_id: id,
          lead_id: leadId,
          user_agent: ua,
          ip_hash: ipHash,
          suspicious_prefetch: suspicious,
        },
        { onConflict: "outbound_message_id,ip_hash", ignoreDuplicates: true },
      );

    // Emit on the event bus so sequence_runner can react to opens
    // without polling email_open_events on every tick. Soft-fail if
    // agent_events isn't reachable in this deploy.
    //
    // Payload follows the canonical agent_event shape (tenant_id +
    // entity + record_id) so the existing drip enrollment path in
    // sequence_runner.enrollment_tick picks it up for free if a drip
    // is configured with trigger_event='BRAVO_EMAIL_OPENED' — no new
    // handler needed in the daemon. Suspicious prefetches are flagged
    // in payload so drip authors can filter them out via
    // trigger_filter if desired.
    // Canonical agent_events shape: no tenant_id column on the table
    // (migration 006) — tenant scope rides in correlation_id. The
    // shared publishAgentEvent helper stamps publisher_agent +
    // severity + correlation_id correctly so this insert no longer
    // silently fails (which is what was happening before — the route
    // looked fine but agent_events.insert errored every call).
    if (shouldPublishOpen) await publishAgentEvent({
      eventType: "BRAVO_EMAIL_OPENED",
      tenantId,
      publisher: "track_open",
      payload: {
        entity: "lead",
        record_id: leadId,
        lead_id: leadId,
        outbound_message_id: id,
        suspicious_prefetch: suspicious,
        // Carry the subject through to the event bus so the /agents
        // and /feed surfaces render a meaningful caption instead of
        // a blank row. Null when the subject column was empty (legacy
        // rows pre-migration); UI falls back to a "(no subject)" hint.
        subject: subject || null,
      },
    });

    // Engine: real (non-prefetch) opens advance the lead from
    // sent_application → viewed_application. Prefetches are filtered
    // out so APMP noise doesn't promote a lead that hasn't actually
    // engaged. Engine guards the from-stage so an open against a
    // lead already past viewed_application is a no-op.
    // Always dispatch on a genuine open — do NOT gate this on alreadyRecorded.
    // The stage engine is idempotent (email_opened only advances
    // sent_application → viewed_application and no-ops once past it via the
    // from-stage guard), so running it on every genuine open is a cheap no-op
    // after the first. Gating it on the event-bus row would strand a lead
    // under-advanced if an early open lost a race with the send (dispatch
    // no-ops, but the event row exists, so every later open would skip forever).
    if (!suspicious && leadId) {
      await dispatchLeadStageEvent({
        type: "email_opened",
        tenantId,
        leadId,
      });
    }
  } catch (err) {
    // Best-effort — log + serve pixel.
    console.error("[track/open] insert failed", err);
  }

  return gifResponse();
}
