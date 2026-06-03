/**
 * lib/lead-interactions-queries.ts — DB-backed read helpers over the
 * `lead_interactions` table for the Conversations inbox.
 *
 * The PURE grouping logic + the phone normalizer live in
 * lib/conversation-threading.ts (no `server-only`, unit-tested). This module
 * is the thin server-only wrapper: it fetches rows, resolves lead display
 * names, and hands both to groupRowsIntoThreads().
 *
 * Re-exports normalizePhoneE164 + the thread types so the send routes / chat
 * tools have one import path and don't need to know about the split.
 */

import "server-only";
import { getServiceSupabase } from "./supabase-server";
import {
  groupRowsIntoThreads,
  distinctLeadIds,
  normalizePhoneE164,
  type RawInteractionRow,
  type ConversationChannel,
  type ConversationThread,
} from "./conversation-threading";

export { normalizePhoneE164 };
export type {
  ConversationThread,
  ConversationMessage,
  ConversationChannel,
} from "./conversation-threading";

/**
 * Dashboard-native opt-out check (2026-06-02, Codex P1 hardening). True when
 * this tenant has an inbound interaction from the number tagged
 * metadata.opt_out_detected — i.e. the contact replied STOP and our TT
 * inbound webhook flagged it. Matched by last-10-digits.
 *
 * IMPORTANT — this is a PARTIAL, defense-in-depth check, not the canonical
 * DNC list. The authoritative CASL suppression list is the CSV the bridge's
 * send_gateway.py / casl_compliance.py manages (data/phone_suppressions.csv),
 * which Vercel functions cannot read. Numbers suppressed via CSV import or
 * the Twilio path are NOT visible here. Full parity requires routing
 * dashboard sends through send_gateway — out of scope for this change. This
 * guard catches the most common case (contact replied STOP through our TT
 * number) on the dashboard's direct-send paths.
 *
 * Best-effort: returns false (does not block) on query error — the dry-run
 * default + the bridge gateway remain the primary safety nets.
 */
export async function isPhoneOptedOut(
  tenantId: string,
  phone: string | null | undefined,
): Promise<boolean> {
  const norm = normalizePhoneE164(phone ?? "");
  if (!tenantId || !norm) return false;
  const last10 = norm.replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return false;
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("lead_interactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("direction", "inbound")
      .filter("metadata->>opt_out_detected", "eq", "true")
      .filter("from_phone", "ilike", `%${last10}%`)
      .limit(1);
    return Array.isArray(r.data) && r.data.length > 0;
  } catch (err) {
    console.error("[lead-interactions-queries] opt-out check failed", err);
    return false;
  }
}

// Must match the columns migration 093 added so call rows render with
// recording/transcript/disposition just like the lead timeline.
const INTERACTION_COLUMNS =
  "id, channel, direction, type, subject, content_preview, created_at, " +
  "sent_at, from_phone, to_phone, to_email, metadata, recording_url, " +
  "transcript_url, disposition, call_outcome, call_duration_sec, " +
  "kixie_call_id, lead_id, actor_user_id";

/**
 * Resolve display names for the given lead_ids in one batched tenant_records
 * query. Best-effort — a failure just leaves labels as the contact phone.
 */
async function resolveLeadLabels(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  leadIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (leadIds.length === 0) return out;
  try {
    const r = await db
      .from("tenant_records")
      .select("id,data")
      .eq("tenant_id", tenantId)
      .in("id", leadIds);
    for (const row of (r.data || []) as Array<{ id: string; data: Record<string, unknown> }>) {
      const d = row.data || {};
      const name =
        (typeof d.name === "string" && d.name) ||
        (typeof d.business_name === "string" && d.business_name) ||
        (typeof d.company === "string" && d.company) ||
        [d.first_name, d.last_name].filter((x) => typeof x === "string" && x).join(" ").trim() ||
        "";
      if (name) out[row.id] = name;
    }
  } catch (err) {
    console.error("[lead-interactions-queries] label lookup failed", err);
  }
  return out;
}

/**
 * Build the contact-threaded inbox for a tenant. Loads the most recent
 * `limit` interaction rows (default 400), resolves lead names, and groups
 * them. Resilient: returns [] on query failure rather than throwing, so a
 * transient DB error renders an empty inbox instead of 500-ing the page.
 */
export async function listThreadsForTenant(
  tenantId: string | null,
  opts: { channel?: ConversationChannel | "all"; limit?: number } = {},
): Promise<ConversationThread[]> {
  if (!tenantId) return [];
  const db = getServiceSupabase();
  const limit = Math.max(50, Math.min(opts.limit ?? 400, 1000));

  let rows: RawInteractionRow[] = [];
  try {
    let query = db
      .from("lead_interactions")
      .select(INTERACTION_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (opts.channel && opts.channel !== "all") {
      query = query.eq("channel", opts.channel);
    }
    const { data, error } = await query;
    if (error) throw error;
    rows = (data || []) as unknown as RawInteractionRow[];
  } catch (err) {
    console.error("[lead-interactions-queries] listThreadsForTenant failed", err);
    return [];
  }

  const labels = await resolveLeadLabels(db, tenantId, distinctLeadIds(rows));
  return groupRowsIntoThreads(rows, labels);
}
