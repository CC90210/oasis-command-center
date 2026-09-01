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
// SSRF-hardened URL validation (scheme allowlist + private/loopback/
// link-local/metadata hostname refusal). Lives in its own module so the
// rules are unit-tested directly; Next route files export handlers only.
// The JARVIS worker applies the same refusal AND resolves the hostname
// before fetching. (Codex review, 2026-09-01.)
import { validatedRecheckUrl as validatedUrl } from "@/lib/web-leads/recheck-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (ins.error) {
      // The one-open-request invariant is enforced ATOMICALLY by a partial
      // unique index on (tenant_id, lead_id) WHERE status IN
      // ('pending','running') -- the read above is a fast path, not the
      // guarantee. Two concurrent POSTs race past the read; the second
      // insert hits the constraint and is answered with the winner's row
      // instead of a 500. (Codex review, 2026-09-01. Plain INSERT on
      // purpose: upsert(onConflict) against a PARTIAL unique index fails
      // silently on PostgREST -- see tests/partial-index-upsert.test.ts.)
      if (/unique|constraint/i.test(ins.error.message)) {
        const winner = await db
          .from("leadgen_recheck_requests")
          .select("id,status,requested_at")
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("lead_id", lid)
          .in("status", ["pending", "running"])
          .order("requested_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (winner.data) {
          return NextResponse.json({ ok: true, deduped: true, request: winner.data });
        }
      }
      throw new Error(`recheck_insert_failed: ${ins.error.message}`);
    }

    return NextResponse.json({ ok: true, request: { id: row.id, status: row.status, requested_at: row.requested_at } }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "recheck_failed" },
      { status: 500 },
    );
  }
}
