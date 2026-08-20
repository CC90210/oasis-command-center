/**
 * GET /api/leads/bulk/batches — the receipt an operator can open to confirm a
 * bulk send actually went out.
 *
 * Why this exists (Adon, 2026-08-20): the bulk path had NO history surface at
 * all. The only feedback was a transient "N queued" line that a router refresh
 * wiped, and the actual send happened up to five minutes later on a cron. An
 * operator therefore had no way, ever, to answer "did that batch send?" — so
 * a fully working pipeline was reported as "not sending at all" for weeks
 * while every message was in fact being delivered. Transport health that the
 * operator cannot observe is indistinguishable from an outage.
 *
 *   (no args)          → recent batches with per-status rollups
 *   ?batch_id=<uuid>   → that batch, plus its per-recipient rows (for polling
 *                        a send that is still draining)
 *
 * Scope: tenant-bound always. An admin sees every batch on the tenant; anyone
 * else sees only batches they themselves sent (fail closed on an unresolved
 * identity — no identity means no batches, never all of them).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { BULK_EMAIL_SOURCE } from "@/lib/bulk-email/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many recent queue rows to aggregate for the history list. */
const SCAN_LIMIT = 600;
/** How many batches to return in the list view. */
const MAX_BATCHES = 25;

/** Every terminal + in-flight state a queued row can hold. */
const STATUSES = ["queued", "sending", "sent", "failed", "suppressed", "expired"] as const;
type Status = (typeof STATUSES)[number];

type Row = {
  id: string;
  to_email: string | null;
  subject: string | null;
  created_at: string | null;
  sent_at: string | null;
  metadata: Record<string, unknown> | null;
};

export type BulkBatch = {
  batch_id: string;
  subject: string;
  custom_message: boolean;
  template_id: string | null;
  requested_by_email: string | null;
  entity_type: string;
  started_at: string | null;
  last_activity_at: string | null;
  total: number;
  counts: Record<Status, number>;
  /** True while any row is still queued or mid-send. */
  in_flight: boolean;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function statusOf(meta: Record<string, unknown> | null): Status {
  const s = str(meta?.status);
  return (STATUSES as readonly string[]).includes(s) ? (s as Status) : "queued";
}

function emptyCounts(): Record<Status, number> {
  return { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0, expired: 0 };
}

export async function GET(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const wanted = (req.nextUrl.searchParams.get("batch_id") || "").trim();
  if (wanted && !UUID_RE.test(wanted)) {
    return NextResponse.json({ ok: false, error: "invalid_batch_id" }, { status: 400 });
  }

  // Non-admins are restricted to their OWN sends. An unresolved identity gets
  // nothing rather than the tenant's whole outbound history.
  if (!sess.isAdmin && !sess.userId) {
    return NextResponse.json({ ok: true, batches: [], rows: [] });
  }

  const db = getServiceSupabase();
  let q = db
    .from("lead_interactions")
    .select("id, to_email, subject, created_at, sent_at, metadata")
    .eq("tenant_id", sess.tenantId)
    .eq("agent_source", BULK_EMAIL_SOURCE)
    .eq("type", "email_queued")
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (wanted) q = q.eq("metadata->>batch_id", wanted);
  if (!sess.isAdmin) q = q.eq("metadata->>acted_by_user_id", sess.userId);

  const res = await q;
  if (res.error) {
    console.error("[leads.bulk.batches] fetch failed", { error: res.error.message });
    return NextResponse.json({ ok: false, error: "fetch_failed" }, { status: 500 });
  }

  const rows = (res.data ?? []) as Row[];
  const byBatch = new Map<string, BulkBatch>();

  for (const r of rows) {
    const meta = r.metadata || {};
    // Rows predating batch tagging (2026-08-20) still deserve a receipt; group
    // them by their queue timestamp so history isn't silently truncated at the
    // point the feature shipped.
    const batchId = str(meta.batch_id) || `legacy:${str(r.created_at).slice(0, 19)}`;
    let b = byBatch.get(batchId);
    if (!b) {
      b = {
        batch_id: batchId,
        subject: r.subject || "(no subject)",
        custom_message: meta.custom_message === true,
        template_id: str(meta.template_id) || null,
        requested_by_email: str(meta.requested_by_email) || null,
        entity_type: str(meta.entity_type) || "lead",
        started_at: r.created_at,
        last_activity_at: r.sent_at || r.created_at,
        total: 0,
        counts: emptyCounts(),
        in_flight: false,
      };
      byBatch.set(batchId, b);
    }
    b.total += 1;
    b.counts[statusOf(meta)] += 1;
    const activity = r.sent_at || r.created_at;
    if (activity && (!b.last_activity_at || activity > b.last_activity_at)) {
      b.last_activity_at = activity;
    }
    if (r.created_at && b.started_at && r.created_at < b.started_at) b.started_at = r.created_at;
  }

  const batches = [...byBatch.values()]
    .map((b) => ({ ...b, in_flight: b.counts.queued + b.counts.sending > 0 }))
    .sort((a, b) => str(b.started_at).localeCompare(str(a.started_at)))
    .slice(0, MAX_BATCHES);

  if (!wanted) {
    return NextResponse.json({ ok: true, batches });
  }

  // Detail view: the per-recipient rows behind one batch, so an operator can
  // see WHICH address failed rather than only that one did.
  return NextResponse.json({
    ok: true,
    batches,
    batch: batches[0] ?? null,
    rows: rows.map((r) => ({
      to_email: r.to_email,
      status: statusOf(r.metadata),
      sent_at: r.sent_at,
      send_error: str(r.metadata?.send_error) || null,
      needs_operator_review: r.metadata?.needs_operator_review === true,
    })),
  });
}
