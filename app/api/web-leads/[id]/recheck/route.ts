/**
 * POST /api/web-leads/[id]/recheck — queue a one-lead website re-measurement.
 *
 * Adon, 2026-09-01: "instead of having to do it for 30,000 leads at a time,
 * you could really just do it one at a time." A rep or operator presses
 * Re-check on a battle card -- optionally pasting the business's CORRECT
 * website link -- and this route writes one row to leadgen_recheck_requests.
 * The JARVIS worker (services/leadgen/recheck-worker.mjs, pm2, ~30s poll)
 * crawls that one site with the same fetcher + scorer as the corpus and
 * writes a fresh audit; the card polls the battlecard payload and refreshes.
 *
 * AUTH MIRRORS THE BATTLECARD ROUTE EXACTLY -- 401 unresolved, 403 wrong
 * tenant, viewer-scoped fetchLead then 404 -- because this is a WRITE that
 * names a lead: anyone who may read the card may ask for it to be re-checked,
 * nobody else may even learn the id exists.
 *
 * THE SUPPLIED URL IS PROVENANCE, NOT DECORATION. When present it authorizes
 * the worker to overwrite the business's website_url and mark ownership
 * verified with {source:'operator', by, at} evidence -- a human asserting
 * "this is their site" is the strongest corroborator we have, and the
 * assertion is recorded with who made it. Validation is the same allowlist
 * discipline as preferredSiteUrl: http/https only, parseable, no other
 * schemes ever (these values end up in hrefs and in a crawler).
 *
 * IDEMPOTENT: one open (pending|running) request per lead. Re-posting while
 * one is open returns 200 with the existing request rather than stacking a
 * queue a rep cannot see.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { fetchLead, WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import { businessIdForLead, safeFilterValue } from "@/lib/web-leads/audit";
import { resolveWebLeadViewer } from "@/lib/web-leads/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** http/https, parseable, nothing else. Returns the normalized href or null. */
function validatedUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.href;
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  try {
    const viewer = await resolveWebLeadViewer(session);
    const lead = await fetchLead(id, viewer);
    if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const businessId = await businessIdForLead(id);
    if (!businessId) {
      // No leadgen business behind this lead -> nothing the worker could
      // re-crawl into. Said plainly rather than queued into a black hole.
      return NextResponse.json({ ok: false, error: "no_business_for_lead" }, { status: 409 });
    }

    let suppliedUrl: string | null = null;
    try {
      const body = (await req.json()) as { url?: unknown };
      if (body && body.url !== undefined && body.url !== null && body.url !== "") {
        suppliedUrl = validatedUrl(body.url);
        if (!suppliedUrl) {
          return NextResponse.json({ ok: false, error: "invalid_url" }, { status: 400 });
        }
      }
    } catch {
      // No body / non-JSON body = re-check the URL already on file.
    }

    // Without a supplied URL there must BE a URL on file to re-measure.
    if (!suppliedUrl && !lead.websiteUrl) {
      return NextResponse.json({ ok: false, error: "no_url_to_check" }, { status: 409 });
    }

    const lid = safeFilterValue(id);
    const bid = safeFilterValue(businessId);
    if (!lid || !bid) {
      return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
    }

    const db = getServiceSupabase();

    const open = await db
      .from("leadgen_recheck_requests")
      .select("id,status,requested_at")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("lead_id", lid)
      .in("status", ["pending", "running"])
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (open.error) throw new Error(`recheck_read_failed: ${open.error.message}`);
    if (open.data) {
      const row = open.data as { id: string; status: string; requested_at: string };
      return NextResponse.json({ ok: true, deduped: true, request: row });
    }

    const row = {
      id: randomUUID(),
      tenant_id: WEBDEV_TENANT_ID,
      business_id: bid,
      lead_id: lid,
      supplied_url: suppliedUrl,
      requested_by: session.email ?? session.userId,
      status: "pending",
      requested_at: new Date().toISOString(),
    };
    const ins = await db.from("leadgen_recheck_requests").insert(row);
    if (ins.error) throw new Error(`recheck_insert_failed: ${ins.error.message}`);

    return NextResponse.json({ ok: true, request: { id: row.id, status: row.status, requested_at: row.requested_at } }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "recheck_failed" },
      { status: 500 },
    );
  }
}
