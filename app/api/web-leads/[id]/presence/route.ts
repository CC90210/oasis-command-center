/**
 * POST /api/web-leads/[id]/presence — queue a one-lead ONLINE-PRESENCE
 * measurement (phase 2 of scoring-v2; Adon: "the evaluation should not just
 * be for the website... overall online presence").
 *
 * A faithful clone of the recheck route's shape, because the shape is the
 * contract: one row into leadgen_presence_requests; the JARVIS worker
 * (services/leadgen/presence-worker.mjs, pm2, ~30s poll) makes ONE Places
 * lookup for that ONE business — hard-capped by the leadgen_api_calls quota
 * ledger — plus DNS and NAP checks, and writes the presence blob the
 * battlecard payload then carries. The card fires this automatically when a
 * lead's presence is absent or stale; the server-side dedupe makes that
 * fire-and-forget safe.
 *
 * AUTH MIRRORS THE BATTLECARD ROUTE EXACTLY — 401 unresolved, 403 wrong
 * tenant, viewer-scoped fetchLead then 404 — a WRITE that names a lead id
 * carries the identical gate stack as the reads (tests/web-leads-guards
 * pins this route in both gate lists).
 *
 * NO REQUEST BODY. Unlike recheck there is nothing an operator supplies:
 * presence is measured from the directory record and public sources. A body,
 * if sent, is ignored.
 *
 * IDEMPOTENT: one open (pending|running) request per lead, enforced
 * ATOMICALLY by the partial unique index idx_presence_req_one_open — the
 * read below is a fast path, not the guarantee; the second of two racing
 * POSTs is answered with the winner's row. Plain INSERT on purpose:
 * upsert(onConflict) against a PARTIAL unique index fails silently on
 * PostgREST (tests/partial-index-upsert.test.ts).
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

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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
      // look up. Said plainly rather than queued into a black hole.
      return NextResponse.json({ ok: false, error: "no_business_for_lead" }, { status: 409 });
    }

    const lid = safeFilterValue(id);
    const bid = safeFilterValue(businessId);
    if (!lid || !bid) {
      return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
    }

    const db = getServiceSupabase();

    const open = await db
      .from("leadgen_presence_requests")
      .select("id,status,requested_at")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("lead_id", lid)
      .in("status", ["pending", "running"])
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (open.error) throw new Error(`presence_read_failed: ${open.error.message}`);
    if (open.data) {
      return NextResponse.json({ ok: true, deduped: true, request: open.data });
    }

    const row = {
      id: randomUUID(),
      tenant_id: WEBDEV_TENANT_ID,
      business_id: bid,
      lead_id: lid,
      requested_by: session.email ?? session.userId,
      status: "pending",
      requested_at: new Date().toISOString(),
    };
    const ins = await db.from("leadgen_presence_requests").insert(row);
    if (ins.error) {
      // ONLY the uniqueness collision recovers (idx_presence_req_one_open);
      // any other constraint failure surfaces as the error it is, or a
      // request that was never queued gets a false ok. Winner looked up at
      // ANY status: it can finish between our conflict and this read, and a
      // completed measurement is still a successful answer.
      if (/idx_presence_req_one_open|unique constraint/i.test(ins.error.message)) {
        const winner = await db
          .from("leadgen_presence_requests")
          .select("id,status,requested_at")
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("lead_id", lid)
          .order("requested_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (winner.data) {
          return NextResponse.json({ ok: true, deduped: true, request: winner.data });
        }
      }
      throw new Error(`presence_insert_failed: ${ins.error.message}`);
    }

    return NextResponse.json(
      { ok: true, request: { id: row.id, status: row.status, requested_at: row.requested_at } },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "presence_failed" },
      { status: 500 },
    );
  }
}
