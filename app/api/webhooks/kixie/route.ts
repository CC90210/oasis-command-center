/**
 * POST /api/webhooks/kixie
 *
 * Kixie lands every call + SMS lifecycle event here. Phase 2 of the TT +
 * Kixie full embedding plan (2026-06-01) — expanded from the original
 * 5-event handler (2026-05-15) to cover the full 9-event Kixie webhook
 * enum + write lifecycle rows into lead_interactions with the new call
 * columns from migration 093.
 *
 * Event types (Kixie's eventname → our canonical mapping):
 *   startcall          — call begins (ringing)
 *   answeredcall       — call connected
 *   endcall            — call terminates (carries duration + recording)
 *   dispositioncall    — agent set call outcome (disposition)
 *   voicemail          — voicemail was left
 *   dialattempt        — outbound dial attempted
 *   scheduledactivity  — calendar event scheduled
 *   sms                — every SMS (inbound + outbound, via direction field)
 *   cisummary          — Conversation Intelligence post-call summary
 *
 * Auth: signed via X-Kixie-Signature header (HMAC-SHA256 of the raw body
 * with KIXIE_WEBHOOK_SECRET). We verify before processing; unsigned
 * requests get a 401.
 *
 * Side effects per event:
 *   1. agent_events row (BRAVO_KIXIE_<event>) so /feed surfaces it live.
 *   2. lead_interactions row when customField1 carries a lead UUID.
 *      Idempotent via the kixie_call_id unique index (mig 093) — duplicate
 *      webhook deliveries (Kixie retries 5xx for ~10min) merge instead
 *      of duplicating.
 *   3. End Call / Disposition / CI Summary patch the existing call row
 *      with recording_url, transcript_url, disposition, call_outcome,
 *      call_duration_sec, metadata.ci_summary.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEBHOOK_SECRET_ENV = "KIXIE_WEBHOOK_SECRET";

// Kixie's webhook payload is loose — different event types carry slightly
// different field sets. Type as a permissive shape and pluck what we need.
type KixieEvent = {
  eventname?: string;
  hookevent?: string;        // SMS webhook uses this too
  callid?: string;
  messageid?: string;
  businessid?: string | number;
  // Call fields
  fromnumber?: string;
  tonumber?: string;
  number?: string;
  calldate?: string;
  answerDate?: string;
  callEndDate?: string;
  duration?: number;
  calltype?: string;         // "outgoing" | "incoming"
  callstatus?: string;
  recordingurl?: string;
  disposition?: string;
  transcripturl?: string;
  ci_summary?: string;       // CI Summary webhook
  ci_sentiment?: string;
  ci_keymoments?: unknown;
  // SMS fields (sometimes wrapped in data.{...} per the Kixie docs)
  data?: KixieEvent;
  direction?: string;        // "outgoing" | "incoming"
  message?: string;
  customernumber?: string;
  businessnumber?: string;
  // Contact attribution
  email?: string;            // agent email
  fname?: string;
  lname?: string;
  contactid?: string;
  dealid?: string;
  crmlink?: string;
  // Bravo lead UUID echoed back from outbound calls/SMS we initiated
  customField1?: string;
  customField2?: string;
  [k: string]: unknown;
};

function verifySignature(rawBody: string, headerSig: string | null): boolean {
  if (!headerSig) return false;
  const secret = (process.env[WEBHOOK_SECRET_ENV] || "").trim();
  if (!secret) {
    // Refuse webhooks when the secret isn't configured. Otherwise an
    // attacker can spam fake call events to pollute /feed.
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const provided = headerSig.trim();
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * Flatten the nested data field Kixie's SMS webhook uses. Other event
 * types have fields at the top level; SMS wraps them in `data.{...}`.
 * Unify here so the rest of the handler doesn't branch.
 */
function flattenEvent(raw: KixieEvent): KixieEvent {
  if (raw.data && typeof raw.data === "object") {
    return { ...raw, ...(raw.data as KixieEvent) };
  }
  return raw;
}

type CallChannel = "phone" | "sms";

/** What channel does this event land in lead_interactions as? */
function channelForEvent(eventname: string): CallChannel | null {
  switch (eventname) {
    case "startcall":
    case "answeredcall":
    case "endcall":
    case "dispositioncall":
    case "voicemail":
    case "dialattempt":
    case "cisummary":
      return "phone";
    case "sms":
      return "sms";
    default:
      return null; // scheduledactivity etc — no interaction row
  }
}

/**
 * Map a Kixie event to a stable lead_interactions row. Uses kixie_call_id
 * as the idempotency anchor for call events (mig 093 has a UNIQUE index)
 * and messageid for SMS. End Call / Disposition / CI Summary UPDATE the
 * existing row rather than inserting a new one.
 */
async function persistLeadInteraction(
  db: ReturnType<typeof getServiceSupabase>,
  args: {
    tenantId: string;
    eventname: string;
    evt: KixieEvent;
  },
): Promise<void> {
  const { tenantId, eventname, evt } = args;
  const channel = channelForEvent(eventname);
  if (!channel) return;
  const leadId = evt.customField1?.trim();
  if (!leadId) return; // no lead linkage → nothing to thread under

  const isSms = channel === "sms";
  const direction = (evt.direction || evt.calltype || "outgoing").toLowerCase();
  const isInbound = direction === "incoming" || direction === "inbound";

  if (isSms) {
    // SMS rows are one per messageid. INSERT once; subsequent webhooks
    // for the same messageid (delivery receipts etc.) UPDATE-merge.
    const messageId = evt.messageid?.trim();
    if (!messageId) return;
    const row = {
      tenant_id: tenantId,
      lead_id: leadId,
      type: isInbound ? "sms_received" : "sms_sent",
      channel: "sms",
      direction: isInbound ? "inbound" : "outbound",
      agent_source: "kixie",
      from_phone: evt.fromnumber || evt.from || null,
      to_phone: evt.tonumber || evt.to || evt.customernumber || null,
      content: evt.message || null,
      content_preview: (evt.message || "").slice(0, 1024),
      metadata: {
        kixie_messageid: messageId,
        kixie_agent_email: evt.email || null,
        crmlink: evt.crmlink || null,
        raw_eventname: eventname,
      },
    };
    // supabase-js does NOT throw on DB errors — check .error explicitly or the
    // failure is invisible. 23505 (unique violation) means already-stored → ok.
    const { error } = await db.from("lead_interactions").insert(row);
    if (error && error.code !== "23505") {
      throw new Error(`sms insert failed: ${error.message}`);
    }
    return;
  }

  // ─── Phone (call lifecycle) ────────────────────────────────────────
  const callId = evt.callid?.trim();
  if (!callId) return;

  // Build the patch — every event refines the row.
  const patch: Record<string, unknown> = {
    tenant_id: tenantId,
    lead_id: leadId,
    channel: "phone",
    agent_source: "kixie",
    kixie_call_id: callId,
    from_phone: evt.fromnumber || null,
    to_phone: evt.tonumber || evt.number || null,
    direction: isInbound ? "inbound" : "outbound",
    // Agent attribution on EVERY event — per-rep call metrics group on
    // metadata.kixie_agent_email. Most calls never emit a CI-summary event
    // (which is the only branch that also sets metadata), so without this the
    // agent would be unknown for ordinary calls. The cisummary branch below
    // overrides metadata with a superset that still carries this field.
    metadata: { kixie_agent_email: evt.email || null },
  };

  // Event-specific fields.
  if (eventname === "startcall" || eventname === "dialattempt") {
    patch.type = isInbound ? "call_incoming" : "call_outgoing";
    patch.content_preview = `${isInbound ? "Inbound" : "Outbound"} call started${evt.email ? ` (${evt.email})` : ""}`;
  } else if (eventname === "answeredcall") {
    patch.type = "call_answered";
    patch.content_preview = `Call answered${evt.email ? ` by ${evt.email}` : ""}`;
  } else if (eventname === "endcall") {
    patch.type = "call_ended";
    patch.call_duration_sec = typeof evt.duration === "number" ? evt.duration : null;
    if (evt.recordingurl) patch.recording_url = evt.recordingurl;
    patch.content_preview = `Call ended (${evt.duration ?? "?"}s)`;
  } else if (eventname === "dispositioncall") {
    patch.type = "call_dispositioned";
    if (evt.disposition) patch.disposition = evt.disposition;
    patch.content_preview = `Disposition: ${evt.disposition || "(unset)"}`;
  } else if (eventname === "voicemail") {
    patch.type = "call_voicemail";
    patch.call_outcome = "voicemail";
    if (evt.recordingurl) patch.recording_url = evt.recordingurl;
    patch.content_preview = "Voicemail left";
  } else if (eventname === "cisummary") {
    patch.type = "call_ci_summary";
    if (evt.transcripturl) patch.transcript_url = evt.transcripturl;
    patch.content_preview = (evt.ci_summary || "Conversation Intelligence summary").slice(0, 1024);
    patch.content = evt.ci_summary || null;
    patch.metadata = {
      kixie_agent_email: evt.email || null,
      ci_sentiment: evt.ci_sentiment || null,
      ci_keymoments: evt.ci_keymoments || null,
      raw_eventname: eventname,
    };
  }

  // ON CONFLICT (kixie_call_id) DO UPDATE — supported via PostgREST upsert
  // with onConflict pointing at the unique index from migration 093.
  const { error } = await db
    .from("lead_interactions")
    .upsert(patch, { onConflict: "kixie_call_id" });
  if (error) {
    throw new Error(`lead_interactions upsert failed: ${error.message}`);
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-kixie-signature");

  if (!verifySignature(rawBody, sig)) {
    return NextResponse.json(
      { ok: false, error: "invalid_signature" },
      { status: 401 },
    );
  }

  let raw: KixieEvent;
  try {
    raw = JSON.parse(rawBody) as KixieEvent;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const evt = flattenEvent(raw);
  const eventname = String(evt.eventname || evt.hookevent || "").toLowerCase();
  if (!eventname) {
    return NextResponse.json({ ok: false, error: "missing_eventname" }, { status: 400 });
  }

  // Canonical Bravo event type so /feed filtering can branch cleanly.
  const eventType = `BRAVO_KIXIE_${eventname.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;

  // Tenant resolution: businessid → tenants.custom_fields.kixie_business_id.
  // (The tenants table has no `metadata` column — its jsonb config lives in
  // `custom_fields`, matching lib/agent-actions.ts + lib/underwriting/run.ts.)
  const db = getServiceSupabase();
  let tenantId: string | null = null;
  if (evt.businessid !== undefined && evt.businessid !== null) {
    const tenantRow = await db
      .from("tenants")
      .select("id")
      .eq("custom_fields->>kixie_business_id", String(evt.businessid))
      .maybeSingle();
    tenantId = (tenantRow.data as { id: string } | null)?.id ?? null;
  }

  if (!tenantId) {
    console.warn(
      `[webhooks.kixie] no tenant mapping for businessid=${evt.businessid} event=${eventname}`,
    );
    return NextResponse.json({ ok: true, ignored: "no_tenant_mapping" });
  }

  // 1. Publish to agent_events so /feed surfaces the event live.
  const severity =
    eventname === "voicemail" || eventname.includes("missed")
      ? "warn"
      : eventname === "cisummary"
        ? "info"
        : "info";
  try {
    await db.from("agent_events").insert({
      event_type: eventType,
      publisher_agent: "kixie",
      severity,
      payload: {
        tenant_id: tenantId,
        call_id: evt.callid || null,
        message_id: evt.messageid || null,
        number: evt.number || evt.tonumber || evt.customernumber || null,
        agent_email: evt.email || null,
        duration_sec: evt.duration ?? null,
        lead_id: evt.customField1 || null,
        direction: evt.direction || evt.calltype || null,
        disposition: evt.disposition || null,
        recording_url: evt.recordingurl || null,
        raw_eventname: eventname,
      },
      correlation_id: tenantId,
    });
  } catch (err) {
    console.error("[webhooks.kixie] agent_events insert failed", err);
  }

  // 2. Persist to lead_interactions (mutating call lifecycle / SMS thread).
  //    Fail-CLOSED: a DB error returns non-2xx so Kixie RETRIES rather than
  //    marking the event delivered and dropping it forever (the prior code
  //    swallowed supabase-js .error and returned 200).
  try {
    await persistLeadInteraction(db, { tenantId, eventname, evt });
  } catch (err) {
    console.error("[webhooks.kixie] persist failed", err);
    return NextResponse.json({ ok: false, error: "persist_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, event_type: eventType });
}
