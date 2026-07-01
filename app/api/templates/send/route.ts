/**
 * POST /api/templates/send — send a PERSONALIZED SunBiz HTML template to a
 * merchant straight from the Templates gallery.
 *
 * Compliance posture (the whole reason this is a dedicated endpoint):
 *  - OWNER/ADMIN only (CC's gating for a new direct-send surface, 2026-07-01).
 *  - DRY-RUN BY DEFAULT. The bridge (/api/bridge/exec-tool) and send_gateway.py
 *    do NOT read the dashboard dry-run flags, so this endpoint enforces isDryRun()
 *    itself — it is a no-op preview until LIVE_SEND_EMAIL=1 (or DASHBOARD_LIVE_SEND=1)
 *    is set in Vercel. BRAVO_FORCE_DRY_RUN=1 always clamps back to dry-run.
 *  - The actual send goes through the SAME path the lead-drawer Send Email uses:
 *    /api/bridge/exec-tool → send_gateway.py, which applies DNC/opt-out suppression,
 *    the CASL footer + List-Unsubscribe headers, open-tracking, kill-switch and caps.
 *    A complete HTML document is detected by send_gateway and sent as-is (no
 *    double-wrap; only the CASL footer is appended).
 *  - A tenant-scoped lead is resolved/created for the recipient FIRST so the send
 *    has tenant scoping (kill-switch + suppression are tenant-scoped and fail-closed
 *    without it) and is audited on the merchant's timeline.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { isDryRun } from "@/lib/integrations/send-mode";
import { COLD_OUTREACH_TEMPLATES } from "@/lib/cold-outreach/templates.generated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT = 200;
// The sample business seeded into the gallery preview — must never reach a real
// merchant, so the render rejects it (Codex P1, 2026-07-01).
const SAMPLE_BUSINESS = "Evergreen Auto Group";

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  // Owner/admin only.
  const role = (sess.teamRole || "").trim().toLowerCase();
  if (role !== "owner" && role !== "admin" && !sess.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Only an owner or admin can send from the Templates gallery." },
      { status: 403 },
    );
  }

  let body: { to_email?: unknown; template_key?: unknown; fields?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const toEmail = typeof body.to_email === "string" ? body.to_email.trim() : "";
  const templateKey = typeof body.template_key === "string" ? body.template_key : "";
  const fields: Record<string, string> =
    body.fields && typeof body.fields === "object"
      ? Object.fromEntries(
          Object.entries(body.fields as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]),
        )
      : {};
  if (!EMAIL_RE.test(toEmail)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  // Server-authoritative render from the CANONICAL template. The client sends
  // only field VALUES (not HTML), so it can't tamper with the markup, sample
  // preview values can't leak, and the unsubscribe is a real recipient-scoped link.
  const tmpl = COLD_OUTREACH_TEMPLATES.find((t) => t.key === templateKey);
  if (!tmpl) {
    return NextResponse.json({ ok: false, error: "unknown_template" }, { status: 400 });
  }
  const tokens = new Set([...tmpl.html.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]));
  const businessName = (fields.business_name || "").trim();
  // A merchant must never receive an email addressed to the sample business.
  if (tokens.has("business_name") && (!businessName || businessName === SAMPLE_BUSINESS)) {
    return NextResponse.json(
      { ok: false, error: "business_name_required", message: "Enter the merchant's real business name before sending." },
      { status: 400 },
    );
  }
  const realUnsubscribe = `${new URL(req.url).origin}/api/unsubscribe?email=${encodeURIComponent(toEmail)}`;
  const currentYear = String(new Date().getFullYear());
  const fill = (s: string) =>
    s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, token) => {
      if (token === "unsubscribe_url") return realUnsubscribe;
      if (token === "year") return fields.year?.trim() || currentYear;
      if (token === "first_name") return fields.first_name?.trim() || "there";
      const v = fields[token];
      return v != null && v.trim() !== "" ? v : "";
    });
  const html = fill(tmpl.html);
  const subject = (fill(tmpl.subject).trim() || tmpl.subject).slice(0, MAX_SUBJECT);

  // DRY-RUN GATE — no-op preview until the operator explicitly enables live sends.
  if (isDryRun("email")) {
    return NextResponse.json({
      ok: true,
      status: "dry_run",
      to: toEmail,
      message:
        "Dry-run: nothing was sent. Set LIVE_SEND_EMAIL=1 in the Vercel project env to enable live sends.",
    });
  }

  const db = getServiceSupabase();

  // Resolve or create a tenant-scoped lead for the recipient (tenant scoping +
  // audit trail). Match on data->>email to avoid duplicates.
  let leadId: string | null = null;
  const existing = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "lead")
    .eq("data->>email", toEmail)
    .limit(1)
    .maybeSingle();
  if (existing.data?.id) {
    leadId = existing.data.id as string;
  } else {
    const ins = await db
      .from("tenant_records")
      .insert({
        tenant_id: sess.tenantId,
        entity_type: "lead",
        data: {
          email: toEmail,
          name: businessName || toEmail.split("@")[0],
          source: "template_send",
        },
      })
      .select("id")
      .single();
    if (ins.error) {
      return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
    }
    leadId = ins.data.id as string;
  }

  // Tenant slug -> brand (SunBiz submissions/sun -> sunbiz).
  const tenantRes = await db.from("tenants").select("slug").eq("id", sess.tenantId).maybeSingle();
  const slug = (tenantRes.data as { slug: string } | null)?.slug || "";
  const brand = slug === "submissions" || slug === "sun" ? "sunbiz" : slug ? "oasis" : undefined;

  const signer = resolveSignerForOperator(sess.email);

  // Send through the proven bridge -> send_gateway path.
  try {
    const url = new URL("/api/bridge/exec-tool", req.url);
    const cookie = req.headers.get("cookie") || "";
    const sendRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tool_name: "send_email",
        to: toEmail,
        subject,
        body: html,
        lead_id: leadId,
        brand,
        // A funding template to a merchant is COMMERCIAL, not transactional —
        // so send_gateway applies its opt-out/DNC suppression gate (transactional
        // would skip it). The bridge's manual_cc agent_source still exempts it
        // from cold-outreach hygiene/rate limits, so legitimate operator sends
        // aren't throttled. (Codex P1 #2, 2026-07-01.)
        intent: "commercial",
        signer_name: signer.name,
        signer_email: signer.email,
        signer_phone: signer.phone,
      }),
      signal: AbortSignal.timeout(50_000),
    });
    if (!sendRes.ok) {
      const txt = await sendRes.text();
      return NextResponse.json(
        { ok: false, status: "failed", error: `exec-tool HTTP ${sendRes.status}: ${txt.slice(0, 160)}`, lead_id: leadId },
        { status: 502 },
      );
    }
    const sendData = (await sendRes.json()) as { is_error?: boolean; output?: string };
    if (sendData?.is_error) {
      return NextResponse.json(
        { ok: false, status: "failed", error: String(sendData?.output || "bridge is_error").slice(0, 240), lead_id: leadId },
        { status: 502 },
      );
    }
    let parsed: { status?: string; reason?: string } = {};
    try {
      parsed = JSON.parse(sendData?.output || "{}");
    } catch {
      /* non-JSON output falls through to not_sent */
    }
    if (parsed?.status === "sent") {
      return NextResponse.json({ ok: true, status: "sent", lead_id: leadId, to: toEmail });
    }
    return NextResponse.json(
      { ok: false, status: parsed?.status || "not_sent", reason: parsed?.reason || "", lead_id: leadId },
      { status: 200 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, status: "failed", error: e instanceof Error ? e.message : "send threw", lead_id: leadId },
      { status: 500 },
    );
  }
}
