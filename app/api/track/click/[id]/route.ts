/**
 * GET /api/track/click/[id] — email click tracking + redirect.
 *
 * Sibling to /api/track/open/[id]. Drip emails rewrite every http(s) link in
 * the body through this route (lib/drips/html-email.ts buildDripHtml). On a
 * click we:
 *
 *   1. Resolve tenant_id + lead_id from the lead_interactions row whose id is
 *      `[id]` (the send_id) — NEVER trusting the URL for tenant/lead, same as
 *      the open route.
 *   2. Insert one row into email_click_events (dedup on outbound_message_id,
 *      ip_hash — re-clicks from the same recipient collapse).
 *   3. Emit BRAVO_EMAIL_CLICKED on the bus.
 *   4. Fire email_clicked → the lead auto-advances to viewed_application (a
 *      click is a stronger intent signal than an open; the engine's from-set
 *      keeps it forward-only).
 *   5. 302 to the real target.
 *
 * Open-redirect guard (FAIL-CLOSED): the target lives in the `u` param
 * (base64url) with an HMAC signature in `s`. A validly-signed target is
 * trusted. An unsigned/foreign target is only honored when its host is on the
 * allowlist; anything else (or a non-http(s) scheme, or malformed input) falls
 * back to SAFE_DEFAULT. The route can therefore never be turned into an
 * arbitrary-URL redirector.
 *
 * Best-effort logging: a DB failure must never break the redirect — the
 * recipient still lands on their destination.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getClientIp } from "@/lib/api-helpers";
import { publishAgentEvent } from "@/lib/manifest/events";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { b64urlDecode, verifyClickTarget } from "@/lib/drips/html-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_BASE = (process.env.PUBLIC_APP_URL || "https://oasisai.work").replace(/\/+$/, "");
// Where an untrusted / missing target lands — a safe first-party page.
const SAFE_DEFAULT = `${APP_BASE}/f/submissions/initial-lead-capture`;
// Hosts we redirect to WITHOUT a valid signature (first-party surfaces only).
const ALLOWED_HOSTS = new Set([
  "oasisai.work",
  "www.oasisai.work",
  "sunbizfunding.com",
  "www.sunbizfunding.com",
]);

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  let h = 5381;
  for (let i = 0; i < ip.length; i++) {
    h = ((h << 5) + h + ip.charCodeAt(i)) & 0xffffffff;
  }
  return "h" + (h >>> 0).toString(16);
}

/** Resolve + validate the redirect target. Fail-closed to SAFE_DEFAULT. */
function resolveTarget(req: NextRequest): string {
  const u = req.nextUrl.searchParams.get("u") || "";
  const s = req.nextUrl.searchParams.get("s") || "";
  if (!u) return SAFE_DEFAULT;
  let decoded: string;
  try {
    decoded = b64urlDecode(u);
  } catch {
    return SAFE_DEFAULT;
  }
  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return SAFE_DEFAULT;
  }
  // No javascript:/data:/file: — only real web schemes.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return SAFE_DEFAULT;
  // Signed target → trust it. Otherwise only first-party hosts.
  if (verifyClickTarget(u, s)) return parsed.toString();
  if (ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return parsed.toString();
  return SAFE_DEFAULT;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const id = (rawId || "").trim();
  const target = resolveTarget(req);

  // Log best-effort; never let it block the redirect.
  if (id && id.length >= 8) {
    try {
      const sb = getServiceSupabase();
      let tenantId: string | null = null;
      let leadId: string | null = null;
      for (const table of ["lead_interactions", "interactions"]) {
        const { data, error } = await sb
          .from(table)
          .select("id, tenant_id, lead_id")
          .eq("id", id)
          .maybeSingle();
        if (!error && data) {
          const row = data as { tenant_id: string | null; lead_id: string | null };
          tenantId = row.tenant_id || null;
          leadId = row.lead_id || null;
          break;
        }
      }

      if (tenantId) {
        const ua = req.headers.get("user-agent") || null;
        const resolvedIp = getClientIp(req);
        const ipHash = hashIp(resolvedIp === "unknown" ? null : resolvedIp);

        await sb.from("email_click_events").upsert(
          {
            tenant_id: tenantId,
            outbound_message_id: id,
            lead_id: leadId,
            clicked_url: target.slice(0, 1024),
            user_agent: ua,
            ip_hash: ipHash,
          },
          { onConflict: "outbound_message_id,ip_hash", ignoreDuplicates: true },
        );

        await publishAgentEvent({
          eventType: "BRAVO_EMAIL_CLICKED",
          tenantId,
          publisher: "track_click",
          payload: {
            entity: "lead",
            record_id: leadId,
            lead_id: leadId,
            outbound_message_id: id,
            clicked_url: target,
          },
        });

        // A click auto-advances the lead to viewed_application (forward-only via
        // the engine's from-set; a click past viewed is a no-op).
        if (leadId) {
          await dispatchLeadStageEvent({ type: "email_clicked", tenantId, leadId });
        }
      }
    } catch (err) {
      console.error("[track/click] log failed", err);
    }
  }

  return NextResponse.redirect(target, 302);
}
