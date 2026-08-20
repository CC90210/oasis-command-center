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
 *
 * 🚨 Rows are identified by agent_source ALONE, never by `type`. The drain
 * rewrites a row's type from 'email_queued' to 'email_sent' on success
 * (lib/bulk-email/dispatch.ts), so a type filter silently drops every
 * DELIVERED recipient: history would omit successful batches entirely and the
 * dialog would poll a vanishing batch until its timeout. That is the exact
 * "it says nothing happened" failure this endpoint exists to end, so it is
 * pinned by tests/bulk-email-visibility.test.ts. (Codex review P1, 2026-08-20;
 * confirmed against production, where all 26 sent rows carry 'email_sent'.)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionContext } from "@/lib/api-auth";
import { BULK_EMAIL_SOURCE } from "@/lib/bulk-email/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows per round-trip while paginating. */
const PAGE = 500;
/**
 * A batch may hold up to MAX_EMAIL_IDS (10k) recipients, so a receipt reads to
 * that depth: a per-recipient list that stops early is a receipt that lies.
 */
const DETAIL_MAX = 10_000;
/**
 * The list view aggregates a rolling window rather than the whole table. When
 * the window is exhausted the response says so (`truncated`) instead of
 * quietly reporting a short total. No silent caps.
 */
const LIST_SCAN_MAX = 3_000;
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

/**
 * Page through this tenant's bulk rows, newest first, up to `max`.
 * Returns `truncated` when the ceiling cut the scan short, so the caller can
 * say so out loud rather than present a partial count as a complete one.
 */
async function fetchBulkRows(
  db: SupabaseClient,
  opts: { tenantId: string; ownerId: string | null; batchId: string | null; max: number },
): Promise<{ rows: Row[]; truncated: boolean; error?: string }> {
  const rows: Row[] = [];
  let from = 0;
  for (;;) {
    const take = Math.min(PAGE, opts.max - rows.length);
    if (take <= 0) return { rows, truncated: true };
    let q = db
      .from("lead_interactions")
      .select("id, to_email, subject, created_at, sent_at, metadata")
      .eq("tenant_id", opts.tenantId)
      // agent_source ONLY — see the header note on the type column.
      .eq("agent_source", BULK_EMAIL_SOURCE)
      .order("created_at", { ascending: false })
      .range(from, from + take - 1);
    if (opts.batchId) q = q.eq("metadata->>batch_id", opts.batchId);
    if (opts.ownerId) q = q.eq("metadata->>acted_by_user_id", opts.ownerId);

    const res = await q;
    if (res.error) return { rows, truncated: false, error: res.error.message };
    const page = (res.data ?? []) as Row[];
    rows.push(...page);
    if (page.length < take) return { rows, truncated: false }; // exhausted
    from += take;
  }
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
    return NextResponse.json({ ok: true, batches: [], rows: [], truncated: false });
  }

  const { rows, truncated, error } = await fetchBulkRows(getServiceSupabase(), {
    tenantId: sess.tenantId,
    ownerId: sess.isAdmin ? null : sess.userId,
    batchId: wanted || null,
    max: wanted ? DETAIL_MAX : LIST_SCAN_MAX,
  });
  if (error) {
    console.error("[leads.bulk.batches] fetch failed", { error });
    return NextResponse.json({ ok: false, error: "fetch_failed" }, { status: 500 });
  }

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
    return NextResponse.json({ ok: true, batches, truncated });
  }

  // Detail view: the per-recipient rows behind one batch, so an operator can
  // see WHICH address failed rather than only that one did.
  return NextResponse.json({
    ok: true,
    batches,
    batch: batches[0] ?? null,
    truncated,
    rows: rows.map((r) => ({
      to_email: r.to_email,
      status: statusOf(r.metadata),
      sent_at: r.sent_at,
      send_error: str(r.metadata?.send_error) || null,
      needs_operator_review: r.metadata?.needs_operator_review === true,
    })),
  });
}
