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
import { safeLandingForTenant } from "@/lib/tenant/public-identity";
import { getClientIp } from "@/lib/api-helpers";
import { publishAgentEvent } from "@/lib/manifest/events";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { b64urlDecode, verifyClickTarget } from "@/lib/drips/html-email";
import { clickAllowedHosts } from "@/lib/email/sending-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_BASE = (process.env.PUBLIC_APP_URL || "https://oasisai.work").replace(/\/+$/, "");
/**
 * Where an untrusted click lands when we cannot tell whose it was.
 *
 * Nobody's intake form and nobody's sales page. This replaced
 * `SAFE_DEFAULT = ${APP_BASE}/f/submissions/initial-lead-capture`, which sent
 * EVERY tenant's unresolvable click to SunBiz. "Safe" meant "a first-party page
 * that exists", and on a single-tenant platform that was true; once a second
 * company shared the platform it meant "hand this visitor to the other
 * company".
 *
 * The first replacement was `APP_BASE` itself, and that was still wrong:
 * oasisai.work IS OASIS AI's marketing site, so a SunBiz merchant with a dead
 * link landed on another company's pitch. The same leak, pointing the other
 * way. /link-expired belongs to neither company and sells nothing.
 *
 * A tenant-owned landing is resolved per click below; this constant is only
 * for the case where even the tenant is unknown.
 */
const NEUTRAL_LANDING = `${APP_BASE}/link-expired`;
// Hosts we redirect to WITHOUT a valid signature (first-party surfaces only).
//
// The configured drip tracking host is included (2026-07-29) because drip mail
// now builds its links on the SENDING domain rather than the platform domain, so
// a link that legitimately targets that host must not be downgraded to
// SAFE_DEFAULT. Read from env rather than hardcoded so the allowlist cannot
// drift from lib/email/tracked-html.ts, which is what actually mints the links.
// Only the HOST is taken, and only from a valid https URL — a malformed value
// contributes nothing rather than widening the allowlist.
// Derived in lib/email/sending-identity.ts so it cannot drift from what mints
// the links, and so it automatically covers the sending domain and the CTA
// destination after a brand cutover. The legacy hosts stay in that set on
// purpose: mail already sitting in inboxes points at them, and a merchant
// opening a three-week-old email must still land on the right page rather than
// the safe default.
const allowedHosts = clickAllowedHosts;

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  let h = 5381;
  for (let i = 0; i < ip.length; i++) {
    h = ((h << 5) + h + ip.charCodeAt(i)) & 0xffffffff;
  }
  return "h" + (h >>> 0).toString(16);
}

/**
 * Resolve + validate the redirect target, or null when it cannot be trusted.
 *
 * Returns null rather than a landing page. Choosing WHERE an untrusted click
 * lands is a tenant decision and this function does not know the tenant — it
 * only knows whether the URL is trustworthy. It used to answer SAFE_DEFAULT,
 * which was hardcoded to SunBiz's intake form, so any tenant's unresolvable
 * click was handed to SunBiz: an OASIS prospect landed on a funding
 * application, saw a company they had never contacted, and any row they created
 * polluted the client's pipeline with OASIS's audience. The caller resolves the
 * landing from the tenant on the lead_interactions row it already looks up.
 */
function resolveTarget(req: NextRequest): string | null {
  const u = req.nextUrl.searchParams.get("u") || "";
  const s = req.nextUrl.searchParams.get("s") || "";
  if (!u) return null;
  let decoded: string;
  try {
    decoded = b64urlDecode(u);
  } catch {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return null;
  }
  // No javascript:/data:/file: — only real web schemes.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // Signed target → trust it. Otherwise only first-party hosts.
  if (verifyClickTarget(u, s)) return parsed.toString();
  if (allowedHosts().has(parsed.hostname.toLowerCase())) return parsed.toString();
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const id = (rawId || "").trim();
  const trusted = resolveTarget(req);
  // The tenant is looked up for LOGGING below, and an untrusted click needs it
  // to pick a landing page. One lookup, two consumers — so `target` is settled
  // inside this block, where the tenant is known, and read again at the
  // redirect. It is never null by the time anything uses it: `trusted` when the
  // URL verified, the tenant's own page when it did not, and the platform's
  // neutral front door when even the tenant is unknown.
  let tenantId: string | null = null;
  let target = trusted ?? NEUTRAL_LANDING;

  // Log best-effort; never let it block the redirect.
  if (id && id.length >= 8) {
    try {
      const sb = getServiceSupabase();
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

      // Now that the tenant is known, an untrusted click gets THAT tenant's
      // landing page. SunBiz (aa04fa1f) resolves to
      // /f/submissions/initial-lead-capture — byte-identical to the old
      // hardcoded SAFE_DEFAULT, so the 13 live redirects in production are
      // unchanged. Everyone else stops being handed to SunBiz.
      if (!trusted) {
        const landing = safeLandingForTenant({ tenantId });
        if (landing) target = `${APP_BASE}${landing}`;
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
