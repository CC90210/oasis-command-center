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
import { createHmac, timingSafeEqual } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isStopCommand, suppressPhoneViaCasl } from "@/lib/sms-opt-out";

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
 * number `to` against the from_number field stored in
 * tenant_integration_credentials.texttorrent for each tenant.
 *
 * Best-effort — returns null when no tenant has the matching number on
 * file (e.g. shared TT default number, or webhook fired before the
 * operator wired their key into the tenant store). Caller still does
 * opt-out suppression on null.
 */
async function resolveTenantByInboundNumber(
  db: ReturnType<typeof getServiceSupabase>,
  toNumber: string,
): Promise<string | null> {
  if (!toNumber) return null;
  // Normalize: strip + so we match against +14165551234 vs 14165551234.
  const normalized = toNumber.replace(/^\+/, "");
  // We need decrypted field values; tenant_integration_credentials stores
  // encrypted_value. The bundle store has the helper but it works per
  // (tenant, service) and we don't know which tenant yet. So we read
  // all texttorrent.from_number rows and decrypt-match. Cheap at the
  // current scale (one TT tenant today).
  try {
    const r = await db
      .from("tenant_integration_credentials")
      .select("tenant_id,encrypted_value,field_key")
      .eq("service", "texttorrent")
      .eq("field_key", "from_number");
    const rows = (r.data || []) as { tenant_id: string; encrypted_value: string; field_key: string }[];
    if (rows.length === 0) return null;
    // Late-bind the decrypt helper so this route doesn't drag the
    // field-encryption module + scrypt key derivation onto the import path
    // unless we actually have rows to check.
    const { decryptField } = await import("@/lib/field-encryption");
    for (const row of rows) {
      try {
        const plain = decryptField(row.encrypted_value);
        if (plain.replace(/^\+/, "") === normalized) return row.tenant_id;
      } catch {
        // Skip rows we can't decrypt — likely a different key environment.
      }
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

  // Opt-out keyword auto-suppression — runs regardless of tenant resolution.
  if (from && isStopCommand(messageText)) {
    const result = await suppressPhoneViaCasl(from, "texttorrent_inbound");
    if (!result.ok) {
      console.error("[webhooks.texttorrent.sms-inbound] suppress-phone failed", result.error);
    }
  }

  // Persist inbound to lead_interactions when we can resolve a tenant.
  const db = getServiceSupabase();
  const tenantId = await resolveTenantByInboundNumber(db, to);
  if (!tenantId) {
    // Unknown destination number — still 200 so TT doesn't retry, but
    // don't write an orphan interaction row.
    return NextResponse.json({ ok: true, ignored: "no_tenant_mapping" });
  }

  const leadId = await findLeadByPhone(db, tenantId, from);

  // Idempotency: when messageId is provided, check for an existing row
  // via metadata->>tt_message_id. We could promote this to a column +
  // unique index later if duplicate webhook deliveries become common.
  if (messageId) {
    try {
      const existing = await db
        .from("lead_interactions")
        .select("id")
        .eq("tenant_id", tenantId)
        .filter("metadata->>tt_message_id", "eq", messageId)
        .maybeSingle();
      if ((existing.data as { id?: string } | null)?.id) {
        return NextResponse.json({ ok: true, deduped: true });
      }
    } catch {
      // Best-effort idempotency check — if it fails, proceed with insert.
    }
  }

  try {
    await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: leadId, // null when we couldn't resolve — still useful in the conversations view
      type: "sms_received",
      channel: "sms",
      direction: "inbound",
      agent_source: "texttorrent",
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
      },
    });
  } catch (err) {
    console.error("[webhooks.tt.sms-inbound] interaction insert failed", err);
    // Swallow + 200 — TT retrying won't help if our DB is the problem.
  }

  return NextResponse.json({ ok: true, lead_id: leadId, tenant_id: tenantId });
}
