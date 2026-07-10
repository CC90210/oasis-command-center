/**
 * lib/agents/operator-email/ingest.ts — turn monitored Gmail messages into
 * lead_interactions rows so deal email threads under the Conversations "Email"
 * section + the lead timeline.
 *
 * PRIVACY GATE (load-bearing): a message is only written if its counterparty
 * matches an existing lead (findExistingLead). Unmatched / personal mail is
 * DROPPED here — never stored, never sent to an LLM, never logged in the clear.
 * That's how "monitor work + personal inboxes but only surface deal email" holds.
 *
 * Idempotent: dedupes on metadata.gmail_message_id. DRY-RUN logs only.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { findExistingLead } from "@/lib/forms/agent-routing";
import { classifyDealEmail } from "./classify";
import { classifyLenderReply } from "@/lib/lenders/classify-reply";
import type { MonitoredMessage } from "./gmail-read";

export interface IngestResult {
  scanned: number;
  matched: number;
  ingested: number;
  dropped: number; // unmatched / personal — intentionally not stored
  skipped: number; // already ingested (dedupe)
}

function emailFromHeader(h: string): string {
  const m = String(h || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(h || "")).trim().toLowerCase();
}

function toISO(dateHeader: string): string | null {
  const t = Date.parse(dateHeader);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Route an inbound reply's conversation thread to the rep who owns it
 * (2026-07-10). The conv_thread_upsert trigger (migration 112) creates/bumps
 * the thread but never sets assigned_to, so every inbound reply used to land
 * in needs_reply UNASSIGNED and reps triaged each other's deals by hand.
 *
 * Assignment preference:
 *   1. the lead's assigned rep (tenant_records data.assigned_to — the
 *      auth_user_id the lead drawer's "Assign to" writes), else
 *   2. the monitored-mailbox owner (this reply arrived in THEIR inbox).
 *
 * Only fills a NULL assigned_to — a manual assignment (threads/[key] PATCH)
 * is never clobbered. Best-effort + fail-open, same philosophy as the
 * trigger: thread routing must never break ingest.
 */
async function autoAssignThreadForInbound(
  db: ReturnType<typeof getServiceSupabase>,
  args: { tenantId: string; leadId: string; mailboxOwnerUserId: string },
): Promise<void> {
  try {
    let assignee = "";
    const rec = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", args.tenantId)
      .eq("id", args.leadId)
      .maybeSingle();
    const data = (rec.data as { data?: Record<string, unknown> } | null)?.data;
    if (data && typeof data.assigned_to === "string") assignee = data.assigned_to.trim();
    if (!assignee) assignee = (args.mailboxOwnerUserId || "").trim();
    if (!assignee) return;

    await db
      .from("conversation_threads")
      .update({ assigned_to: assignee, updated_at: new Date().toISOString() })
      .eq("tenant_id", args.tenantId)
      .eq("thread_key", `lead:${args.leadId}`)
      .is("assigned_to", null);
  } catch {
    // fail open — routing is a convenience; the interaction row is the ledger
  }
}

/**
 * Ingest a batch for one operator/mailbox. `dryRun` (monitor validation) logs
 * the decision without writing. Returns counts for the tick summary.
 */
export async function ingestMessages(
  args: { tenantId: string; userId: string; mailbox: "work" | "personal"; dryRun: boolean },
  messages: MonitoredMessage[],
): Promise<IngestResult> {
  const db = getServiceSupabase();
  const res: IngestResult = { scanned: messages.length, matched: 0, ingested: 0, dropped: 0, skipped: 0 };

  for (const msg of messages) {
    const fromEmail = emailFromHeader(msg.from);
    const toEmail = emailFromHeader(msg.to);
    const mailbox = (msg.mailboxAddress || "").trim().toLowerCase();
    // Direction relative to Alex's own address; counterparty is the other side.
    const outbound = !!mailbox && fromEmail === mailbox;
    const counterparty = outbound ? toEmail : fromEmail;
    if (!counterparty) { res.dropped += 1; continue; }

    // PRIVACY GATE — only deal/merchant email (matches a lead) is kept.
    let lead: { id: string } | null = null;
    try {
      lead = await findExistingLead(args.tenantId, { email: counterparty });
    } catch {
      lead = null;
    }
    if (!lead) { res.dropped += 1; continue; }
    res.matched += 1;

    // Dedupe on the Gmail message id.
    try {
      const dup = await db
        .from("lead_interactions")
        .select("id")
        .eq("tenant_id", args.tenantId)
        .filter("metadata->>gmail_message_id", "eq", msg.id)
        .limit(1);
      if (!dup.error && Array.isArray(dup.data) && dup.data.length > 0) { res.skipped += 1; continue; }
    } catch {
      // if the dedupe check errors, skip writing (fail-closed on duplicate risk)
      res.skipped += 1;
      continue;
    }

    // Intelligence (Fable 5) — matched email only, so no personal/unmatched mail
    // ever reaches the model. Lender replies additionally get terms/decline
    // extracted (the learning signal). Both classifiers fence + fail closed.
    const cls = await classifyDealEmail(msg.subject, msg.body);
    let lenderEnrichment: Record<string, unknown> = {};
    if (cls.type === "lender_reply") {
      try {
        const lr = await classifyLenderReply(msg.subject, msg.body);
        lenderEnrichment = {
          lender_category: lr.category,
          lender_amount: lr.amount,
          lender_term_months: lr.term_months,
          lender_factor: lr.factor_rate,
        };
      } catch { /* fail closed — no terms */ }
    }
    const enrichment = {
      email_type: cls.type,
      needs_attention: cls.needs_attention,
      summary: cls.summary,
      ...lenderEnrichment,
    };

    if (args.dryRun) {
      console.log(`[operator-email] DRY ${outbound ? "out" : "in"} msg=${msg.id} lead=${lead.id} type=${cls.type}${lenderEnrichment.lender_category ? "/" + lenderEnrichment.lender_category : ""} "${msg.subject.slice(0, 50)}"`);
      res.ingested += 1;
      continue;
    }

    const row = {
      tenant_id: args.tenantId,
      lead_id: lead.id,
      type: outbound ? "email_sent" : "email_received",
      channel: "email",
      direction: outbound ? "outbound" : "inbound",
      agent_source: "gmail_monitor",
      actor_user_id: args.userId,
      subject: msg.subject.slice(0, 500),
      content: msg.body,
      content_preview: msg.body.slice(0, 1024),
      to_email: counterparty,
      sent_at: toISO(msg.date),
      metadata: {
        gmail_message_id: msg.id,
        gmail_thread_id: msg.threadId,
        from_address: fromEmail,
        monitored_mailbox: args.mailbox,
        routed_to_user_id: args.userId,
        ...enrichment,
      },
    };
    try {
      const ins = await db.from("lead_interactions").insert(row);
      if (ins.error) { res.dropped += 1; continue; }
      res.ingested += 1;
      // Inbound replies route their thread to the owning rep (see helper
      // above). Outbound is skipped — sends don't change ownership.
      if (!outbound) {
        await autoAssignThreadForInbound(db, {
          tenantId: args.tenantId,
          leadId: lead.id,
          mailboxOwnerUserId: args.userId,
        });
      }
    } catch {
      res.dropped += 1;
    }
  }
  return res;
}
