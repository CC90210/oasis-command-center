/**
 * POST /api/webhooks/texttorrent/sms-inbound
 *
 * TextTorrent's inbound-SMS webhook lands here. Phase 2 of the TT + Kixie
 * full embedding plan (2026-06-01) — extended from the original opt-out-
 * only handler (2026-05-19) to:
 *
 *   1. Resolve tenant from the destination phone number (`to`) by matching
 *      against tenant_integration_credentials.texttorrent.from_number, so
 *      multi-tenant TT setups route correctly.
 *   2. Try to find an existing lead by phone (tenant_records.lead.phone).
 *   3. Write a lead_interactions row (type=sms_received, channel=sms,
 *      direction=inbound, agent_source=texttorrent) so the drawer timeline
 *      surfaces inbound replies + the conversations page threads them.
 *   4. Idempotent via the TT message_id when present.
 *   5. Keep the existing opt-out keyword auto-suppression behavior.
 *
 * Auth: HMAC-SHA256 of the raw body keyed by TEXTTORRENT_WEBHOOK_SECRET,
 * sent in the `X-TT-Signature` header (base64-encoded digest).
 *
 * TT payload shape (best-effort — TT docs don't formally document the
 * webhook payload, but the inbox claim API uses these field names):
 *   {
 *     "message_id"?: "uuid",
 *     "from": "+14165551234",       // sender (the prospect)
 *     "to"?: "+14164444444",        // our TT number
 *     "body"?: "STOP",              // legacy field name (kept for back-compat)
 *     "message"?: "STOP",           // newer field name
 *     "received_at"?: "2026-06-01T19:00:00Z",
 *     "chat_id"?: "...",            // TT inbox thread id
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isStopCommand, suppressPhoneViaCasl } from "@/lib/sms-opt-out";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";
import { loadSunbizInboundContext } from "@/lib/sunbiz-inbound-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TextTorrentInbound = {
  message_id?: unknown;
  messageid?: unknown;
  from?: unknown;
  to?: unknown;
  body?: unknown;
  message?: unknown;
  received_at?: unknown;
  chat_id?: unknown;
  [k: string]: unknown;
};

function timingSafeStringEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function verifyTextTorrentSignature(rawBody: string, headerSig: string | null): boolean {
  if (!headerSig) return false;
  const secret = (process.env.TEXTTORRENT_WEBHOOK_SECRET || "").trim();
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return timingSafeStringEqual(headerSig.trim(), expected);
}

/**
 * Find which tenant owns this inbound SMS by matching the destination
 * number `to` against the TextTorrent sending numbers on file:
 *
 *   1. tenant_integration_credentials.texttorrent.from_number — the tenant
 *      "Default Business Number" (owner / automated-Helios line).
 *   2. user_integration_credentials.texttorrent.texttorrent_from_number — each
 *      rep's OWN sending DID (per-agent SMS, 2026-06-24). Reps now send from
 *      their own number, so prospect replies land on those DIDs; without this
 *      second pass the reply matches no tenant and is silently dropped
 *      (Codex audit 2026-06-24). Returns the owning rep so the inbound row can
 *      be attributed to them.
 *
 * Best-effort — returns null when no number matches (shared/unknown TT line, or
 * webhook fired before the key was wired in). Caller still does opt-out
 * suppression on null. Cheap at current scale (one TT tenant, a few reps).
 */
async function resolveTenantByInboundNumber(
  db: ReturnType<typeof getServiceSupabase>,
  toNumber: string,
): Promise<{ tenantId: string; userId: string | null } | null> {
  if (!toNumber) return null;
  // Normalize: strip + so we match against +14165551234 vs 14165551234.
  const normalized = toNumber.replace(/^\+/, "");
  try {
    // Late-bind the decrypt helper so this route doesn't drag the
    // field-encryption module + scrypt key derivation onto the import path
    // unless we actually have a number to resolve.
    const { decryptField } = await import("@/lib/field-encryption");

    // 1. Tenant default number.
    const tenantRows = await db
      .from("tenant_integration_credentials")
      .select("tenant_id,encrypted_value")
      .eq("service", "texttorrent")
      .eq("field_key", "from_number");
    for (const row of (tenantRows.data || []) as { tenant_id: string; encrypted_value: string }[]) {
      try {
        if (decryptField(row.encrypted_value).replace(/^\+/, "") === normalized) {
          return { tenantId: row.tenant_id, userId: null };
        }
      } catch {
        // Skip rows we can't decrypt — likely a different key environment.
      }
    }

    // 2. Per-rep number — match the reply back to the rep who owns the DID.
    const userRows = await db
      .from("user_integration_credentials")
      .select("tenant_id,user_id,encrypted_value")
      .eq("service", "texttorrent")
      .eq("field_key", "texttorrent_from_number");
    for (const row of (userRows.data || []) as { tenant_id: string; user_id: string; encrypted_value: string }[]) {
      try {
        if (decryptField(row.encrypted_value).replace(/^\+/, "") === normalized) {
          return { tenantId: row.tenant_id, userId: row.user_id };
        }
      } catch {
        // Skip rows we can't decrypt.
      }
    }

    // 3. Env fallback — a single-tenant TT setup wires creds via Vercel env
    // (not the encrypted DB), so the DB lookups above find nothing. When the
    // destination is the configured tenant default number, route to the
    // configured tenant. Fail-closed: requires BOTH env vars to be set.
    const envNumber = (process.env.TEXTTORRENT_FROM_NUMBER || "").replace(/^\+/, "").trim();
    const envTenant = (process.env.TEXTTORRENT_TENANT_ID || "").trim();
    if (envNumber && envTenant && envNumber === normalized) {
      return { tenantId: envTenant, userId: null };
    }

    return null;
  } catch (err) {
    console.error("[webhooks.tt.sms-inbound] tenant resolve failed", err);
    return null;
  }
}

/**
 * Find a lead in the tenant whose phone number matches the inbound `from`.
 * Best-effort match — tenant_records.data->>phone vs normalized E.164.
 */
async function findLeadByPhone(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  fromNumber: string,
): Promise<string | null> {
  if (!fromNumber) return null;
  try {
    // Last 10 digits — covers +1 variations + leading-1 vs leading-+1
    // mismatches without dragging libphonenumber onto this hot path.
    const last10 = fromNumber.replace(/\D/g, "").slice(-10);
    if (!last10) return null;
    const r = await db
      .from("tenant_records")
      .select("id,data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .filter("data->>phone", "ilike", `%${last10}%`)
      .limit(1);
    const rows = (r.data || []) as { id: string }[];
    return rows[0]?.id || null;
  } catch (err) {
    console.error("[webhooks.tt.sms-inbound] lead lookup failed", err);
    return null;
  }
}

async function enqueueInboundWork(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  toNumber: string,
  providerMessageId: string,
  interactionId: string,
  providerConversationId: string | null,
  inboundMessage: string,
  leadId: string | null,
  contactPhone: string,
): Promise<boolean> {
  const normalized = toNumber.replace(/\D/g, "").slice(-10);
  const accounts = await db.from("sunbiz_agent_accounts").select("id,from_number,voice_profile_id")
    .eq("tenant_id", tenantId).eq("provider", "texttorrent").eq("enabled", true);
  if (accounts.error) return false;
  const account = ((accounts.data || []) as Array<{ id: string; from_number: string; voice_profile_id: string | null }>)
    .find((row) => row.from_number.replace(/\D/g, "").slice(-10) === normalized);
  if (!account) {
    await db.from("agent_events").insert({
      event_type: "TEXTTORRENT_UNMAPPED_DID", publisher_agent: "texttorrent",
      severity: "warn", correlation_id: tenantId,
      payload: { tenant_id: tenantId, destination_last4: normalized.slice(-4), provider_message_id: providerMessageId },
    });
    return false;
  }
  let voiceProfile: Record<string, unknown> = {};
  if (account.voice_profile_id) {
    const profile = await db.from("agent_voice_profiles")
      .select("id,style_descriptors,compiled_prompt,example_snippets,confidence,model_used,refreshed_at")
      .eq("id", account.voice_profile_id).eq("tenant_id", tenantId).eq("approved", true).maybeSingle();
    if (profile.error || !profile.data) return false;
    voiceProfile = {
      approved: true,
      instructions: profile.data.compiled_prompt || "",
      style_descriptors: profile.data.style_descriptors,
      example_snippets: profile.data.example_snippets,
      confidence: profile.data.confidence,
      model_used: profile.data.model_used,
      refreshed_at: profile.data.refreshed_at,
    };
  }
  let scoped;
  try {
    scoped = await loadSunbizInboundContext(db, tenantId, leadId, contactPhone);
  } catch {
    return false;
  }
  const queued = await db.from("texttorrent_inbound_work").upsert({
    tenant_id: tenantId, account_id: account.id,
    provider_message_id: providerMessageId, provider_conversation_id: providerConversationId,
    source_interaction_id: interactionId, inbound_message: inboundMessage,
    conversation: {
      ...scoped.conversation,
      thread_key: leadId ? `lead:${leadId}` : `phone:+${contactPhone.replace(/\D/g, "")}`,
      to_phone: contactPhone,
      lead_id: leadId,
    },
    merchant_context: { ...scoped.merchantContext, ...(leadId ? { lead_id: leadId } : {}) },
    voice_profile: voiceProfile,
    status: "pending",
  }, { onConflict: "tenant_id,provider_message_id", ignoreDuplicates: true });
  return !queued.error;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyTextTorrentSignature(rawBody, req.headers.get("x-tt-signature"))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: TextTorrentInbound;
  try {
    payload = JSON.parse(rawBody) as TextTorrentInbound;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const from = typeof payload.from === "string" ? payload.from : "";
  const to = typeof payload.to === "string" ? payload.to : "";
  // TT may send the message text under "body" (legacy) or "message" (newer).
  const messageText =
    (typeof payload.message === "string" && payload.message) ||
    (typeof payload.body === "string" && payload.body) ||
    "";
  const messageId =
    (typeof payload.message_id === "string" && payload.message_id) ||
    (typeof payload.messageid === "string" && payload.messageid) ||
    "";

  // Persist inbound to lead_interactions when we can resolve a tenant.
  const db = getServiceSupabase();
  const resolved = await resolveTenantByInboundNumber(db, to);
  if (!resolved) {
    // Unknown destination number — still 200 so TT doesn't retry, but
    // don't write an orphan interaction row.
    return NextResponse.json({ ok: false, error: "no_tenant_mapping" }, { status: 503 });
  }
  const { tenantId, userId: routedToUserId } = resolved;
  if (from && isStopCommand(messageText)) {
    const digits = from.replace(/\D/g, "").slice(-10);
    if (digits.length !== 10) return NextResponse.json({ ok: false, error: "invalid_stop_phone" }, { status: 400 });
    const durable = await db.from("sunbiz_phone_suppressions").upsert({
      tenant_id: tenantId, phone_last10: digits, reason: "OPT_OUT",
      source: "texttorrent_webhook", updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,phone_last10" });
    if (durable.error) return NextResponse.json({ ok: false, error: "suppression_failed" }, { status: 503 });
    void suppressPhoneViaCasl(from, "texttorrent_inbound").then((result) => {
      if (!result.ok) console.error("[webhooks.texttorrent.sms-inbound] CASL propagation failed", result.error);
    });
  }

  const leadId = await findLeadByPhone(db, tenantId, from);
  const providerMessageId = messageId || `tt-fp:${createHash("sha256")
    .update([to, from, String(payload.received_at || ""), messageText].join("\n"))
    .digest("hex")}`;

  // Idempotency: when messageId is provided, check for an existing row
  // via metadata->>tt_message_id. We could promote this to a column +
  // unique index later if duplicate webhook deliveries become common.
  if (providerMessageId) {
    try {
      const existing = await db
        .from("lead_interactions")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("provider", "texttorrent")
        .eq("provider_message_id", providerMessageId)
        .maybeSingle();
      if ((existing.data as { id?: string } | null)?.id) {
        const queued = await enqueueInboundWork(db, tenantId, to, providerMessageId,
          (existing.data as { id: string }).id, typeof payload.chat_id === "string" ? payload.chat_id : null,
          messageText, leadId, from);
        if (!queued) return NextResponse.json({ ok: false, error: "enqueue_failed" }, { status: 503 });
        return NextResponse.json({ ok: true, deduped: true });
      }
    } catch {
      // Best-effort idempotency check — if it fails, proceed with insert.
    }
  }

  // supabase-js does NOT throw on DB errors — check .error and fail-CLOSED so
  // TT retries instead of us silently dropping an inbound reply (the prior code
  // swallowed the error and returned 200, losing the message permanently).
  const persisted = await db.from("lead_interactions").insert({
    tenant_id: tenantId,
    lead_id: leadId, // null when we couldn't resolve — still useful in the conversations view
    type: "sms_received",
    channel: "sms",
    direction: "inbound",
    agent_source: "texttorrent",
    provider: "texttorrent",
    provider_message_id: providerMessageId,
    from_phone: from,
    to_phone: to,
    content: messageText,
    content_preview: messageText.slice(0, 1024),
    metadata: {
      tt_message_id: messageId || null,
      tt_chat_id: typeof payload.chat_id === "string" ? payload.chat_id : null,
      opt_out_detected: isStopCommand(messageText),
      raw_received_at:
        typeof payload.received_at === "string" ? payload.received_at : null,
      // Which rep's DID this reply came back to (null = the tenant default
      // number). Lets Conversations thread the reply to the right rep and aids
      // debugging of per-agent number routing.
      routed_to_user_id: routedToUserId,
    },
  }).select("id").single();
  if (persisted.error || !persisted.data) {
    console.error("[webhooks.tt.sms-inbound] interaction insert failed", persisted.error);
    return NextResponse.json({ ok: false, error: "persist_failed" }, { status: 500 });
  }
  const queued = await enqueueInboundWork(db, tenantId, to, providerMessageId, persisted.data.id,
    typeof payload.chat_id === "string" ? payload.chat_id : null, messageText, leadId, from);
  if (!queued) return NextResponse.json({ ok: false, error: "enqueue_failed" }, { status: 503 });

  // Phase 3 spine live-refresh (plan §7): an inbound reply just landed —
  // nudge any open Conversations tab for this tenant. Best-effort/
  // fail-silent, never blocks the webhook's 200 back to TT.
  await nudgeConversations(tenantId);

  return NextResponse.json({ ok: true, lead_id: leadId, tenant_id: tenantId });
}
